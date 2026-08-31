import { z } from "zod";
import { appendEvent, type Queryable } from "@foreman/db";
import type { SyncJob } from "../jobs.js";

// X-6: GitHub payload text is untrusted — zod-parse defensively, parameterised SQL only.
const issuePayload = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }).passthrough(),
  issue: z.object({
    id: z.number(),
    node_id: z.string(),
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullish(),
    state: z.string(),
    type: z.object({ name: z.string() }).nullish(),
  }).passthrough(),
}).passthrough();

const prPayload = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }).passthrough(),
  pull_request: z.object({
    number: z.number().int(),
    merged: z.boolean().nullish(),
    html_url: z.string(),
    merge_commit_sha: z.string().nullish(),
    body: z.string().nullish(),
  }).passthrough(),
}).passthrough();

const KINDS = new Set(["epic", "story", "task", "bug", "chore"]);
// Statuses owned by the queue (Phase 1) — inbound sync never clobbers them (deviation 5).
const QUEUE_OWNED = new Set(["claimed", "in_progress", "in_review"]);

async function resolveProject(tx: Queryable, orgId: string, repo: string): Promise<string | null> {
  const res = await tx.query(
    "select id from projects where organisation_id = $1 and gh_repos @> array[$2]::text[]", [orgId, repo]);
  return res.rowCount ? res.rows[0].id : null;
}

export async function handleIssuesEvent(tx: Queryable, job: SyncJob): Promise<void> {
  const p = issuePayload.safeParse(job.payload);
  if (!p.success) { console.warn(`issues payload rejected: ${p.error.message}`); return; }
  const { action, repository, issue } = p.data;
  const repo = repository.full_name;

  const projectId = await resolveProject(tx, job.organisation_id, repo);
  if (projectId === null) { console.log(`issue from untracked repo ${repo}, skipping`); return; }

  const existing = await tx.query(
    "select id, status from work_items where organisation_id = $1 and gh_issue_node_id = $2",
    [job.organisation_id, issue.node_id]);

  let workItemId: string;
  if (existing.rowCount === 0) {
    const typeName = issue.type?.name?.toLowerCase();
    const kind = typeName !== undefined && KINDS.has(typeName) ? typeName : "task";
    const status = action === "deleted" ? "cancelled" : issue.state === "closed" ? "done" : "queued";
    const ins = await tx.query(
      `insert into work_items (organisation_id, project_id, title, intent, status, kind,
         gh_issue_id, gh_issue_node_id, gh_issue_number, gh_repo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [job.organisation_id, projectId, issue.title, issue.body ?? null, status, kind,
       issue.id, issue.node_id, issue.number, repo]);
    workItemId = ins.rows[0].id;
  } else {
    workItemId = existing.rows[0].id;
    const status: string = existing.rows[0].status;
    if (action === "edited") {
      await tx.query("update work_items set title=$2, intent=$3, updated_at=now() where id=$1",
        [workItemId, issue.title, issue.body ?? null]);
    } else if (action === "closed" && !QUEUE_OWNED.has(status)) {
      await tx.query("update work_items set status='done', updated_at=now() where id=$1", [workItemId]);
    } else if (action === "reopened" && (status === "done" || status === "cancelled")) {
      await tx.query("update work_items set status='queued', updated_at=now() where id=$1", [workItemId]);
    } else if (action === "deleted") {
      await tx.query("update work_items set status='cancelled', updated_at=now() where id=$1", [workItemId]);
    }
  }

  await appendEvent(tx, {
    organisation_id: job.organisation_id, project_id: projectId, work_item_id: workItemId,
    type: "github.issue_synced",
    payload: { gh_repo: repo, gh_issue_number: issue.number, gh_issue_node_id: issue.node_id },
    idempotency_key: `ghd:${job.delivery_id}`,
  });
}

const CLOSES_RE = /(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/i;

export async function handlePullRequestEvent(tx: Queryable, job: SyncJob): Promise<void> {
  const p = prPayload.safeParse(job.payload);
  if (!p.success) { console.warn(`pull_request payload rejected: ${p.error.message}`); return; }
  const { action, repository, pull_request: pr } = p.data;
  const repo = repository.full_name;

  const projectId = await resolveProject(tx, job.organisation_id, repo);
  if (projectId === null) return;

  let type: "github.pr_opened" | "github.pr_merged";
  if (action === "opened") type = "github.pr_opened";
  else if (action === "closed" && pr.merged === true) type = "github.pr_merged";
  else return;

  let workItemId: string | null = null;
  const m = pr.body?.match(CLOSES_RE);
  if (m) {
    const linked = await tx.query(
      "select id from work_items where organisation_id = $1 and gh_repo = $2 and gh_issue_number = $3",
      [job.organisation_id, repo, Number(m[1])]);
    if (linked.rowCount) workItemId = linked.rows[0].id;
  }

  await appendEvent(tx, {
    organisation_id: job.organisation_id, project_id: projectId, work_item_id: workItemId ?? undefined,
    type,
    payload: {
      gh_repo: repo, pr_number: pr.number, pr_url: pr.html_url,
      ...(type === "github.pr_merged" && pr.merge_commit_sha ? { merge_sha: pr.merge_commit_sha } : {}),
    },
    idempotency_key: `ghd:${job.delivery_id}`,
  });
}
