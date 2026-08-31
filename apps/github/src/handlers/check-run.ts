import { z } from "zod";
import { appendEvent, type Queryable } from "@foreman/db";
import type { SyncJob } from "../jobs.js";

const payload = z.object({
  action: z.string(),
  check_run: z.object({ id: z.number() }).passthrough(),
  requested_action: z.object({ identifier: z.string() }).passthrough().optional(),
}).passthrough();

// Terminal states are never clobbered by a button click; the event records the
// intent regardless so the audit trail shows who pressed what.
const TERMINAL = new Set(["done", "cancelled"]);

export async function handleCheckRunEvent(tx: Queryable, job: SyncJob): Promise<void> {
  const p = payload.safeParse(job.payload);
  if (!p.success) { console.warn(`check_run payload rejected: ${p.error.message}`); return; }
  if (p.data.action !== "requested_action" || p.data.requested_action === undefined) return;
  const identifier = p.data.requested_action.identifier;

  const item = await tx.query(
    "select id, status from work_items where organisation_id = $1 and gh_check_run_id = $2",
    [job.organisation_id, p.data.check_run.id]);
  if (item.rowCount === 0) { console.log(`check_run ${p.data.check_run.id} matches no work item`); return; }
  const workItemId: string = item.rows[0].id;
  const status: string = item.rows[0].status;

  if (identifier === "retry" || identifier === "reassign") {
    if (!TERMINAL.has(status)) {
      await tx.query(
        "update work_items set status='queued', claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1",
        [workItemId]);
    }
    await appendEvent(tx, {
      organisation_id: job.organisation_id, work_item_id: workItemId,
      type: "work.reassigned", payload: { by: `check_run:${identifier}` },
      idempotency_key: `ghd:${job.delivery_id}`,
    });
    return;
  }

  if (identifier === "abort") {
    if (!TERMINAL.has(status)) {
      await tx.query(
        "update work_items set status='cancelled', claimed_by=null, lease_expires_at=null, updated_at=now() where id=$1",
        [workItemId]);
    }
    await appendEvent(tx, {
      organisation_id: job.organisation_id, work_item_id: workItemId,
      type: "work.cancelled", payload: { by: "check_run:abort" },
      idempotency_key: `ghd:${job.delivery_id}`,
    });
    return;
  }

  console.warn(`unknown check_run action identifier: ${identifier}`);
}
