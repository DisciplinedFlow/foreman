import type { Queryable } from "@foreman/db";
import type { Backbone } from "@foreman/backbone";
import { EchoCache, InMemoryKv } from "@foreman/github-client";
import type { SyncJob } from "../jobs.js";
import type { GithubClientLike } from "../sync/field-map.js";
import { fullSync } from "../sync/full-sync.js";
import { handleIssuesEvent, handlePullRequestEvent } from "./issues.js";
import { handlePullRequestReviewEvent } from "./reviews.js";
import { handleProjectItemEvent } from "./project-item.js";
import { handleCheckRunEvent } from "./check-run.js";
import { handleDeploymentStatus } from "./deployment.js";
import { scanLifecycle } from "../lifecycle/scan.js";
import { handleScheduleWrite } from "./schedule-write.js";
import { handleReportRun } from "./report-run.js";
import { handleCreateItem } from "./create-item.js";

const fallbackEcho = new EchoCache(new InMemoryKv());

export interface HandlerContext {
  echo?: EchoCache;
  gh?: GithubClientLike;
  backbone?: Backbone;
}

export async function handleSyncJob(
  tx: Queryable, job: SyncJob, ctx: HandlerContext = {},
): Promise<void> {
  switch (job.event_name) {
    case "issues": return handleIssuesEvent(tx, job);
    case "pull_request": return handlePullRequestEvent(tx, job);
    case "pull_request_review": return handlePullRequestReviewEvent(tx, job);
    case "projects_v2_item": return handleProjectItemEvent(tx, ctx.echo ?? fallbackEcho, job);
    case "check_run": return handleCheckRunEvent(tx, job);
    case "deployment_status": return handleDeploymentStatus(tx, job);
    case "foreman.lifecycle_scan": {
      if (ctx.gh === undefined) { console.warn("lifecycle_scan skipped: no github client wired"); return; }
      const projectId = (job.payload as { project_id?: string } | null)?.project_id;
      if (projectId === undefined) return;
      const proj = await tx.query("select * from projects where id = $1", [projectId]);
      if (proj.rowCount === 0 || (proj.rows[0].gh_repos ?? []).length === 0) return;
      await scanLifecycle(tx, ctx.gh, proj.rows[0]);
      return;
    }
    case "foreman.create_item": {
      if (ctx.backbone === undefined) throw new Error("create_item handler not wired");
      return handleCreateItem(job, ctx.backbone);
    }
    case "foreman.report_run": {
      if (ctx.backbone === undefined) throw new Error("report_run handler not wired");
      return handleReportRun(job, ctx.backbone);
    }
    case "foreman.schedule_write": {
      if (ctx.backbone === undefined) throw new Error("schedule_write handler not wired");
      return handleScheduleWrite(job, ctx.backbone);
    }
    case "foreman.reconcile": {
      if (ctx.gh === undefined) { console.warn("reconcile skipped: no github client wired"); return; }
      const projectId = (job.payload as { project_id?: string } | null)?.project_id;
      if (projectId === undefined) return;
      const proj = await tx.query("select * from projects where id = $1", [projectId]);
      if (proj.rowCount === 0 || proj.rows[0].gh_project_node_id === null) return;
      await fullSync({ tx, gh: ctx.gh }, proj.rows[0]);
      return;
    }
    default: return; // unhandled event names are noise, not errors
  }
}
