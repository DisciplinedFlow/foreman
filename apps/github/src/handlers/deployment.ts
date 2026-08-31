import { z } from "zod";
import { appendEvent, type Queryable } from "@foreman/db";
import type { SyncJob } from "../jobs.js";

const payload = z.object({
  deployment_status: z.object({ state: z.string() }).passthrough(),
  deployment: z.object({ id: z.number(), sha: z.string().optional() }).passthrough(),
  repository: z.object({ full_name: z.string() }).passthrough(),
}).passthrough();

// LFC-5 (Phase 6 deviation 2): deployment evidence is repo-granular in v1 —
// a successful deployment promotes that repo's implemented/tested endpoints.
export async function handleDeploymentStatus(tx: Queryable, job: SyncJob): Promise<void> {
  const p = payload.safeParse(job.payload);
  if (!p.success) { console.warn(`deployment_status payload rejected: ${p.error.message}`); return; }
  const repo = p.data.repository.full_name;

  const proj = await tx.query(
    "select id from projects where organisation_id = $1 and gh_repos @> array[$2]::text[]",
    [job.organisation_id, repo]);
  if (proj.rowCount === 0) return;
  const projectId: string = proj.rows[0].id;

  if (p.data.deployment_status.state === "success") {
    await tx.query(
      `update endpoints set state='deployed', state_changed_at=now(),
         evidence = evidence || $3::jsonb
       where project_id = $1 and gh_repo = $2 and state in ('implemented','tested')`,
      [projectId, repo, JSON.stringify([{ kind: "deploy", ref: String(p.data.deployment.id) }])]);
    await appendEvent(tx, {
      organisation_id: job.organisation_id, project_id: projectId,
      type: "deploy.succeeded",
      payload: { ...(p.data.deployment.sha !== undefined ? { sha: p.data.deployment.sha } : {}) },
      idempotency_key: `ghd:${job.delivery_id}`,
    });
  } else if (p.data.deployment_status.state === "failure" || p.data.deployment_status.state === "error") {
    await appendEvent(tx, {
      organisation_id: job.organisation_id, project_id: projectId,
      type: "deploy.failed",
      payload: { ...(p.data.deployment.sha !== undefined ? { sha: p.data.deployment.sha } : {}) },
      idempotency_key: `ghd:${job.delivery_id}`,
    });
  }
}
