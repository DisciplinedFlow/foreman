import type { Queryable } from "@foreman/db";
import { EchoCache, InMemoryKv } from "@foreman/github-client";
import type { SyncJob } from "../jobs.js";
import { handleIssuesEvent, handlePullRequestEvent } from "./issues.js";
import { handleProjectItemEvent } from "./project-item.js";

const fallbackEcho = new EchoCache(new InMemoryKv());

export async function handleSyncJob(
  tx: Queryable, job: SyncJob, ctx: { echo?: EchoCache } = {},
): Promise<void> {
  switch (job.event_name) {
    case "issues": return handleIssuesEvent(tx, job);
    case "pull_request": return handlePullRequestEvent(tx, job);
    case "projects_v2_item": return handleProjectItemEvent(tx, ctx.echo ?? fallbackEcho, job);
    default: return; // unhandled event names are noise, not errors
  }
}
