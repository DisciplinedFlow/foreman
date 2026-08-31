import { z } from "zod";
import type { Backbone, RunStatus } from "@foreman/backbone";
import type { SyncJob } from "../jobs.js";

const payload = z.object({
  work_item_id: z.string().uuid(),
  state: z.enum(["queued", "in_progress", "completed"]),
  summary: z.string().optional(),
  head_sha: z.string().optional(),
  conclusion: z.enum(["success", "failure", "cancelled"]).optional(),
}).passthrough();

// GHA-5: the MCP server enqueues these on claim/report/complete; the github
// worker is the only writer of check runs.
export async function handleReportRun(job: SyncJob, backbone: Backbone): Promise<void> {
  const p = payload.safeParse(job.payload);
  if (!p.success) { console.warn(`report_run payload rejected: ${p.error.message}`); return; }
  const run: RunStatus = {
    state: p.data.state,
    ...(p.data.summary !== undefined ? { summary: p.data.summary } : {}),
    ...(p.data.head_sha !== undefined ? { headSha: p.data.head_sha } : {}),
    ...(p.data.conclusion !== undefined ? { conclusion: p.data.conclusion } : {}),
  };
  await backbone.reportRun({ workItemId: p.data.work_item_id }, run);
}
