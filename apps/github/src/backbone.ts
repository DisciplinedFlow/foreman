import type { EventEmitter } from "node:events";
import type pg from "pg";
import { appendEvent } from "@foreman/db";
import type {
  Backbone, BackboneEvent, NewWorkItem, ProjectRef, RunStatus, Schedule, Unsubscribe, WorkItem, WorkItemRef,
} from "@foreman/backbone";
import type { EchoCache } from "@foreman/github-client";
import type { FieldMap, GithubClientLike } from "./sync/field-map.js";

// Deviation 4: check runs ship with the Phase 4 plan.
export class BackboneCapabilityError extends Error {
  constructor(message: string) { super(message); this.name = "BackboneCapabilityError"; }
}

// Verified item 6: REST issue-type param is `type` (name string), silently dropped
// without push access — acceptable.
const KIND_TO_ISSUE_TYPE: Record<string, string> = { bug: "Bug", task: "Task", epic: "Epic" };

const UPDATE_FIELD_MUTATION = `
mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
    projectV2Item { id }
  }
}`;

interface ProjectRow {
  id: string; organisation_id: string; gh_installation_id: string | number;
  gh_project_node_id: string | null; gh_repos: string[]; field_map: FieldMap;
}

export class GithubBackbone implements Backbone {
  constructor(private deps: { pool: pg.Pool; gh: GithubClientLike; echo: EchoCache; emitter: EventEmitter }) {}

  private async project(projectId: string): Promise<ProjectRow & { appId: number; installationId: number }> {
    const res = await this.deps.pool.query("select * from projects where id = $1", [projectId]);
    if (res.rowCount === 0) throw new Error(`unknown project ${projectId}`);
    const row = res.rows[0] as ProjectRow;
    const installationId = Number(row.gh_installation_id);
    const app = await this.deps.pool.query(
      "select app_id from github_installations where installation_id = $1", [installationId]);
    if (app.rowCount === 0) throw new Error(`no installation ${installationId} for project ${projectId}`);
    return { ...row, appId: Number(app.rows[0].app_id), installationId };
  }

  private async item(workItemId: string): Promise<any> {
    const res = await this.deps.pool.query("select * from work_items where id = $1", [workItemId]);
    if (res.rowCount === 0) throw new Error(`unknown work item ${workItemId}`);
    return res.rows[0];
  }

  async listWorkItems(project: ProjectRef, since?: Date): Promise<WorkItem[]> {
    const res = since === undefined
      ? await this.deps.pool.query("select * from work_items where project_id = $1", [project.projectId])
      : await this.deps.pool.query("select * from work_items where project_id = $1 and updated_at >= $2",
          [project.projectId, since]);
    return res.rows.map((r: any) => ({
      workItemId: r.id, title: r.title, intent: r.intent ?? undefined, kind: r.kind,
      priority: r.priority, status: r.status,
      ghIssueNumber: r.gh_issue_number ?? undefined, ghRepo: r.gh_repo ?? undefined,
    }));
  }

  async createWorkItem(project: ProjectRef, item: NewWorkItem): Promise<WorkItem> {
    const proj = await this.project(project.projectId);
    const repo = item.repo ?? proj.gh_repos[0];
    if (repo === undefined) throw new Error(`project ${proj.id} has no gh_repos to create issues in`);

    const issueType = item.kind !== undefined ? KIND_TO_ISSUE_TYPE[item.kind] : undefined;
    const res = await this.deps.gh.rest(proj.appId, proj.installationId, "POST", `/repos/${repo}/issues`, {
      title: item.title,
      ...(item.intent !== undefined ? { body: item.intent } : {}),
      ...(issueType !== undefined ? { type: issueType } : {}),
    });
    if (res.status !== 201) throw new Error(`issue create failed: ${res.status}`);
    const gh = res.json as { id: number; node_id: string; number: number };
    await this.deps.echo.record(gh.node_id, "issue", item.title);

    const client = await this.deps.pool.connect();
    try {
      await client.query("begin");
      const ins = await client.query(
        `insert into work_items (organisation_id, project_id, title, intent, kind, priority, acceptance,
           gh_issue_id, gh_issue_node_id, gh_issue_number, gh_repo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, status`,
        [proj.organisation_id, proj.id, item.title, item.intent ?? null, item.kind ?? "task",
         item.priority ?? 100, JSON.stringify(item.acceptance ?? []), gh.id, gh.node_id, gh.number, repo]);
      await appendEvent(client, {
        organisation_id: proj.organisation_id, project_id: proj.id, work_item_id: ins.rows[0].id,
        type: "github.issue_synced",
        payload: { gh_repo: repo, gh_issue_number: gh.number, gh_issue_node_id: gh.node_id },
      });
      await client.query("commit");
      return {
        workItemId: ins.rows[0].id, title: item.title, status: ins.rows[0].status,
        ghIssueNumber: gh.number, ghRepo: repo,
        ...(item.intent !== undefined ? { intent: item.intent } : {}),
        ...(item.kind !== undefined ? { kind: item.kind } : {}),
      };
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async linkParent(child: WorkItemRef, parent: WorkItemRef): Promise<void> {
    const childRow = await this.item(child.workItemId);
    const parentRow = await this.item(parent.workItemId);
    const proj = await this.project(childRow.project_id);
    // §5.3: sub-issue API takes the *database id* of the child, addressed at the parent's number.
    const res = await this.deps.gh.rest(proj.appId, proj.installationId, "POST",
      `/repos/${parentRow.gh_repo}/issues/${parentRow.gh_issue_number}/sub_issues`,
      { sub_issue_id: Number(childRow.gh_issue_id) });
    if (res.status >= 300) throw new Error(`sub_issues link failed: ${res.status}`);
    await this.deps.pool.query(
      "update work_items set parent_id = $2, updated_at=now() where id = $1",
      [child.workItemId, parent.workItemId]);
  }

  async addDependency(blocked: WorkItemRef, blocker: WorkItemRef): Promise<void> {
    const blockedRow = await this.item(blocked.workItemId);
    const blockerRow = await this.item(blocker.workItemId);
    const proj = await this.project(blockedRow.project_id);
    const res = await this.deps.gh.rest(proj.appId, proj.installationId, "POST",
      `/repos/${blockedRow.gh_repo}/issues/${blockedRow.gh_issue_number}/dependencies/blocked_by`,
      { issue_id: Number(blockerRow.gh_issue_id) });
    if (res.status >= 300) throw new Error(`blocked_by add failed: ${res.status}`);
    await this.deps.pool.query(
      `insert into work_item_deps (organisation_id, blocked_id, blocker_id, source)
       values ($1,$2,$3,'foreman')
       on conflict (blocked_id, blocker_id) do update set source = 'foreman'`,
      [blockedRow.organisation_id, blocked.workItemId, blocker.workItemId]);
  }

  async updateSchedule(item: WorkItemRef, s: Schedule): Promise<void> {
    const row = await this.item(item.workItemId);
    const proj = await this.project(row.project_id);
    const fm = proj.field_map ?? {};
    if (row.gh_item_node_id === null) throw new Error(`work item ${item.workItemId} has no project item`);

    // Per dimension: skip when unmapped; echo-record BEFORE the HTTP call (GHA-4).
    const writes: Array<{ fieldId: string; value: Record<string, string>; echoValue: string }> = [];
    if (s.startAt !== undefined && fm.start_field !== undefined && fm.start_field.type === "DATE") {
      writes.push({ fieldId: fm.start_field.node_id, value: { date: s.startAt }, echoValue: s.startAt });
    }
    if (s.targetAt !== undefined && fm.target_field !== undefined && fm.target_field.type === "DATE") {
      writes.push({ fieldId: fm.target_field.node_id, value: { date: s.targetAt }, echoValue: s.targetAt });
    }
    if (s.iterationId !== undefined && fm.iteration_field !== undefined) {
      writes.push({ fieldId: fm.iteration_field.node_id, value: { iterationId: s.iterationId }, echoValue: s.iterationId });
    }

    for (const w of writes) {
      await this.deps.echo.record(row.gh_item_node_id, w.fieldId, w.echoValue);
      await this.deps.gh.graphql(proj.appId, proj.installationId, UPDATE_FIELD_MUTATION, {
        projectId: proj.gh_project_node_id, itemId: row.gh_item_node_id, fieldId: w.fieldId, value: w.value,
      });
    }
    if (writes.length === 0) return;

    const synced = {
      start_at: s.startAt !== undefined && fm.start_field?.type === "DATE" ? s.startAt : undefined,
      target_at: s.targetAt !== undefined && fm.target_field?.type === "DATE" ? s.targetAt : undefined,
      iteration_id: s.iterationId !== undefined && fm.iteration_field !== undefined ? s.iterationId : undefined,
    };
    const client = await this.deps.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `update work_items set start_at = coalesce($2::date, start_at), target_at = coalesce($3::date, target_at),
           iteration_id = coalesce($4, iteration_id), updated_at=now() where id = $1`,
        [item.workItemId, synced.start_at ?? null, synced.target_at ?? null, synced.iteration_id ?? null]);
      await appendEvent(client, {
        organisation_id: row.organisation_id, project_id: row.project_id, work_item_id: item.workItemId,
        type: "work.rescheduled",
        payload: {
          ...(synced.start_at !== undefined ? { start_at: synced.start_at } : {}),
          ...(synced.target_at !== undefined ? { target_at: synced.target_at } : {}),
          ...(synced.iteration_id !== undefined ? { iteration_id: synced.iteration_id } : {}),
        },
      });
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async reportRun(_item: WorkItemRef, _run: RunStatus): Promise<void> {
    throw new BackboneCapabilityError("check runs ship with the Phase 4 plan");
  }

  subscribe(handler: (e: BackboneEvent) => void): Unsubscribe {
    this.deps.emitter.on("backbone_event", handler);
    return () => this.deps.emitter.off("backbone_event", handler);
  }
}
