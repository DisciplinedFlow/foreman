import { z } from "zod";
import type { Backbone, NewWorkItem } from "@foreman/backbone";
import type { SyncJob } from "../jobs.js";

const payload = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1),
  intent: z.string().optional(),
  kind: z.enum(["epic", "story", "task", "bug", "chore"]).optional(),
  priority: z.number().int().optional(),
  acceptance: z.array(z.string()).optional(),
}).passthrough();

// UI item creation on GitHub-connected projects (Phase 8): the github worker is
// the single GitHub writer; createWorkItem already posts the issue, inserts the
// row, appends the event and echo-records.
export async function handleCreateItem(job: SyncJob, backbone: Backbone): Promise<void> {
  const p = payload.safeParse(job.payload);
  if (!p.success) { console.warn(`create_item payload rejected: ${p.error.message}`); return; }
  const item: NewWorkItem = {
    title: p.data.title,
    ...(p.data.intent !== undefined ? { intent: p.data.intent } : {}),
    ...(p.data.kind !== undefined ? { kind: p.data.kind } : {}),
    ...(p.data.priority !== undefined ? { priority: p.data.priority } : {}),
    ...(p.data.acceptance !== undefined ? { acceptance: p.data.acceptance } : {}),
  };
  await backbone.createWorkItem({ projectId: p.data.project_id }, item);
}
