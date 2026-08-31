import type { Queryable } from "@foreman/db";
import type { SyncJob } from "../jobs.js";
import { handleIssuesEvent, handlePullRequestEvent } from "./issues.js";

export async function handleSyncJob(tx: Queryable, job: SyncJob): Promise<void> {
  switch (job.event_name) {
    case "issues": return handleIssuesEvent(tx, job);
    case "pull_request": return handlePullRequestEvent(tx, job);
    default: return; // unhandled event names are noise, not errors
  }
}
