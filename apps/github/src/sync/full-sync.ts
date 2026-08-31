import { appendEvent, type Queryable } from "@foreman/db";
import type { FieldMap, GithubClientLike } from "./field-map.js";

const ITEMS_QUERY = `
query ($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first: 50) {
            nodes {
              ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { id } } }
              ... on ProjectV2ItemFieldIterationValue { iterationId startDate duration field { ... on ProjectV2FieldCommon { id } } }
              ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } }
            }
          }
          content {
            ... on Issue {
              id fullDatabaseId number title body state
              repository { nameWithOwner }
              parent { id }
            }
          }
        }
      }
    }
  }
}`;

export interface SyncProject {
  id: string;
  organisation_id: string;
  gh_installation_id: string | number;
  gh_project_node_id: string;
  gh_repos: string[];
  field_map: FieldMap;
}

interface ItemNode {
  id: string;
  fieldValues: { nodes: Array<{ date?: string; iterationId?: string; startDate?: string; optionId?: string; field?: { id: string } }> };
  content: {
    id: string; fullDatabaseId: number; number: number; title: string; body?: string | null;
    state: string; repository: { nameWithOwner: string }; parent?: { id: string } | null;
  } | null;
}

// Statuses the queue owns (deviation 5) — never clobbered by sync.
const QUEUE_OWNED = new Set(["claimed", "in_progress", "in_review"]);

export async function fullSync(
  deps: { tx: Queryable; gh: GithubClientLike },
  project: SyncProject,
): Promise<{ items: number }> {
  const { tx, gh } = deps;
  const installationId = Number(project.gh_installation_id);
  const appRow = await tx.query(
    "select app_id from github_installations where installation_id = $1", [installationId]);
  if (appRow.rowCount === 0) throw new Error(`no github_installations row for installation ${installationId}`);
  const appId = Number(appRow.rows[0].app_id);
  const fm = project.field_map ?? {};
  const runTs = new Date().toISOString();

  // Page 1: collect every item.
  const items: ItemNode[] = [];
  let cursor: string | null = null;
  do {
    const data: { node: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ItemNode[] } } } =
      await gh.graphql(appId, installationId, ITEMS_QUERY, { id: project.gh_project_node_id, cursor });
    const page = data.node?.items;
    if (!page) break;
    items.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor !== null);

  // Pass 1: upsert each issue-backed item with linkage + schedule columns.
  const byContentNodeId = new Map<string, string>(); // gh issue node id → work_item uuid
  for (const item of items) {
    const c = item.content;
    if (!c?.id) continue; // draft items / PRs: skipped at Phase 2

    let startAt: string | null = null, targetAt: string | null = null, iterationId: string | null = null;
    let laneStatus: string | null = null;
    for (const fv of item.fieldValues?.nodes ?? []) {
      const fieldId = fv.field?.id;
      if (fieldId === undefined) continue;
      if (fv.date !== undefined) {
        if (fieldId === fm.start_field?.node_id) startAt = fv.date;
        else if (fieldId === fm.target_field?.node_id) targetAt = fv.date;
      } else if (fv.iterationId !== undefined) {
        if (fieldId === fm.iteration_field?.node_id) iterationId = fv.iterationId;
        if (fieldId === fm.start_field?.node_id && fv.startDate !== undefined) startAt = fv.startDate;
      } else if (fv.optionId !== undefined && fieldId === fm.status_field?.node_id) {
        for (const [status, optId] of Object.entries(fm.status_field?.options ?? {})) {
          if (optId === fv.optionId) laneStatus = status;
        }
      }
    }
    if (laneStatus === null && c.state?.toUpperCase() === "CLOSED") laneStatus = "done";

    const existing = await tx.query(
      "select id, status from work_items where organisation_id = $1 and gh_issue_node_id = $2",
      [project.organisation_id, c.id]);
    let workItemId: string;
    if (existing.rowCount === 0) {
      const ins = await tx.query(
        `insert into work_items (organisation_id, project_id, title, intent, status, kind,
           gh_issue_id, gh_issue_node_id, gh_issue_number, gh_repo, gh_item_node_id, start_at, target_at, iteration_id)
         values ($1,$2,$3,$4,$5,'task',$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [project.organisation_id, project.id, c.title, c.body ?? null, laneStatus ?? "queued",
         c.fullDatabaseId, c.id, c.number, c.repository.nameWithOwner, item.id, startAt, targetAt, iterationId]);
      workItemId = ins.rows[0].id;
    } else {
      workItemId = existing.rows[0].id;
      const statusOk = laneStatus !== null && !QUEUE_OWNED.has(existing.rows[0].status);
      await tx.query(
        `update work_items set title=$2, intent=$3, gh_issue_id=$4, gh_issue_number=$5, gh_repo=$6,
           gh_item_node_id=$7, start_at=$8, target_at=$9, iteration_id=$10,
           status = case when $11::text is not null then $11 else status end, updated_at=now()
         where id=$1`,
        [workItemId, c.title, c.body ?? null, c.fullDatabaseId, c.number, c.repository.nameWithOwner,
         item.id, startAt, targetAt, iterationId, statusOk ? laneStatus : null]);
    }
    byContentNodeId.set(c.id, workItemId);

    await appendEvent(tx, {
      organisation_id: project.organisation_id, project_id: project.id, work_item_id: workItemId,
      type: "github.issue_synced",
      payload: { gh_repo: c.repository.nameWithOwner, gh_issue_number: c.number, gh_issue_node_id: c.id },
      idempotency_key: `fullsync:${project.id}:${c.id}:${runTs}`,
    });
  }

  // Pass 2: parents (issue node id → uuid; parents outside the synced set resolve via DB).
  for (const item of items) {
    const c = item.content;
    if (!c?.parent?.id) continue;
    const childId = byContentNodeId.get(c.id);
    if (childId === undefined) continue;
    let parentId = byContentNodeId.get(c.parent.id) ?? null;
    if (parentId === null) {
      const row = await tx.query(
        "select id from work_items where organisation_id = $1 and gh_issue_node_id = $2",
        [project.organisation_id, c.parent.id]);
      parentId = row.rowCount ? row.rows[0].id : null;
    }
    if (parentId !== null) {
      await tx.query("update work_items set parent_id = $2, updated_at=now() where id = $1", [childId, parentId]);
    }
  }

  // Pass 3: dependencies via REST database ids (§5.3), replacing github-sourced rows per item.
  for (const item of items) {
    const c = item.content;
    if (!c?.id) continue;
    const workItemId = byContentNodeId.get(c.id)!;
    const res = await gh.rest(appId, installationId, "GET",
      `/repos/${c.repository.nameWithOwner}/issues/${c.number}/dependencies/blocked_by?per_page=100`);
    if (res.status !== 200 || !Array.isArray(res.json)) continue;
    await tx.query("delete from work_item_deps where blocked_id = $1 and source = 'github'", [workItemId]);
    for (const blocker of res.json as Array<{ id: number }>) {
      const blockerRow = await tx.query(
        "select id from work_items where organisation_id = $1 and gh_issue_id = $2",
        [project.organisation_id, blocker.id]);
      if (blockerRow.rowCount === 0) continue;
      await tx.query(
        `insert into work_item_deps (organisation_id, blocked_id, blocker_id, source)
         values ($1,$2,$3,'github') on conflict do nothing`,
        [project.organisation_id, workItemId, blockerRow.rows[0].id]);
    }
  }

  return { items: byContentNodeId.size };
}
