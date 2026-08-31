import { z } from "zod";
import type { Backbone } from "@foreman/backbone";
import type { SyncJob } from "../jobs.js";

const payload = z.object({
  work_item_id: z.string().uuid(),
  start_at: z.string().optional(),
  target_at: z.string().optional(),
}).passthrough();

// The api's PATCH lands here (deviation 4): the github worker is the single
// GitHub writer, and updateSchedule already echo-records + appends work.rescheduled.
export async function handleScheduleWrite(job: SyncJob, backbone: Backbone): Promise<void> {
  const p = payload.safeParse(job.payload);
  if (!p.success) { console.warn(`schedule_write payload rejected: ${p.error.message}`); return; }
  await backbone.updateSchedule({ workItemId: p.data.work_item_id }, {
    ...(p.data.start_at !== undefined ? { startAt: p.data.start_at } : {}),
    ...(p.data.target_at !== undefined ? { targetAt: p.data.target_at } : {}),
  });
}
