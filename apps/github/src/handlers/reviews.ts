import { z } from "zod";
import { appendEvent, type Queryable } from "@foreman/db";
import type { SyncJob } from "../jobs.js";
import { CLOSES_RE, resolveProject } from "./issues.js";

// X-6: GitHub payload text is untrusted — zod-parse defensively, parameterised SQL only.
const reviewPayload = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }).passthrough(),
  review: z.object({
    id: z.number().int(),
    state: z.string(),
    user: z.object({ login: z.string() }).passthrough(),
    html_url: z.string(),
  }).passthrough(),
  pull_request: z.object({
    number: z.number().int(),
    html_url: z.string(),
    body: z.string().nullish(),
  }).passthrough(),
}).passthrough();

export async function handlePullRequestReviewEvent(tx: Queryable, job: SyncJob): Promise<void> {
  const p = reviewPayload.safeParse(job.payload);
  if (!p.success) { console.warn(`pull_request_review payload rejected: ${p.error.message}`); return; }
  const { action, repository, review, pull_request: pr } = p.data;
  // GitHub sends "dismissed" as an action, not a review state; only "submitted" carries a state to record.
  if (action !== "submitted") return;
  const repo = repository.full_name;

  const projectId = await resolveProject(tx, job.organisation_id, repo);
  if (projectId === null) return;

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
    type: "github.pr_reviewed",
    payload: {
      gh_repo: repo, pr_number: pr.number, pr_url: pr.html_url,
      review_id: review.id, reviewer: review.user.login, state: review.state,
    },
    idempotency_key: `ghd:${job.delivery_id}`,
  });
}
