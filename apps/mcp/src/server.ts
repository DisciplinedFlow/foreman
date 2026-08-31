import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type pg from "pg";
import {
  appendEvent, claimNextWorkItem, completeWorkItem, extendLease, WipLimitExceededError,
} from "@foreman/db";
import type { AuthCtx } from "./auth.js";

function ok(out: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}

function err(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] };
}

const NOT_ANNOUNCED = err("not_announced", "agent has not announced yet; call foreman__agent_announce first");

async function assertOwnsWorkItem(pool: pg.Pool, workItemId: string, agentId: string):
  Promise<{ organisationId: string; projectId: string } | null> {
  const res = await pool.query(
    "select organisation_id, project_id, claimed_by from work_items where id = $1", [workItemId]);
  if (!res.rowCount || res.rows[0].claimed_by !== agentId) return null;
  return { organisationId: res.rows[0].organisation_id, projectId: res.rows[0].project_id };
}

export function buildMcpServer(pool: pg.Pool, ctx: AuthCtx): McpServer {
  const server = new McpServer({ name: "foreman-mcp", version: "0.1.0" });

  server.registerTool("foreman__agent_announce", {
    description: "Announce this agent to Foreman, binding the bearer token to an agent identity.",
    inputSchema: {
      display_name: z.string().min(1),
      platform: z.string().min(1),
      model: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
    },
  }, async ({ display_name, platform, model, capabilities }) => {
    const caps = capabilities ?? [];
    let agentId: string;
    if (ctx.agentId) {
      agentId = ctx.agentId;
      await pool.query(
        "update agents set display_name = $1, platform = $2, model = $3, capabilities = $4 where id = $5",
        [display_name, platform, model ?? null, caps, agentId]);
    } else {
      const res = await pool.query(
        `insert into agents (organisation_id, project_id, display_name, platform, model, capabilities, integration_depth)
         values ($1,$2,$3,$4,$5,$6,'mcp') returning id`,
        [ctx.organisationId, ctx.projectId, display_name, platform, model ?? null, caps]);
      agentId = res.rows[0].id;
      await pool.query("update agent_tokens set agent_id = $1 where id = $2", [agentId, ctx.tokenId]);
    }
    await appendEvent(pool, {
      organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: agentId,
      type: "agent.announced", payload: { display_name, platform, model, capabilities: caps },
    });
    return ok({ agent_id: agentId, project_id: ctx.projectId, poll_interval_ms: 2000, server_time: new Date().toISOString() });
  });

  server.registerTool("foreman__agent_heartbeat", {
    description: "Report agent liveness and (optionally) extend the lease on the work item in progress.",
    inputSchema: {
      status: z.enum(["idle", "working", "blocked", "stalled", "offline", "error"]),
      current_tool: z.string().optional(),
      current_work_item_id: z.string().uuid().optional(),
    },
  }, async ({ status, current_tool, current_work_item_id }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    await pool.query("update agents set status = $1, last_seen_at = now() where id = $2", [status, ctx.agentId]);
    if (current_work_item_id) await extendLease(pool, current_work_item_id, ctx.agentId);
    await appendEvent(pool, {
      organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: ctx.agentId,
      type: "agent.heartbeat", payload: { status, current_tool, current_work_item_id },
    });
    return ok({ ack: true, directives: [] });
  });

  server.registerTool("foreman__work_claim", {
    description: "Claim the next available work item in this project (priority order, WIP-limited).",
    inputSchema: {},
  }, async () => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    let item;
    try {
      item = await claimNextWorkItem(pool, { projectId: ctx.projectId, agentId: ctx.agentId });
    } catch (e) {
      if (e instanceof WipLimitExceededError) return err("wip_limit_exceeded", `wip limit exceeded: ${e.scope}`);
      throw e;
    }
    if (!item) return ok({ status: "empty", retry_after_ms: 2000 });
    return ok({
      status: "assigned",
      work_item: {
        id: item.id, title: item.title, intent: item.intent,
        acceptance: item.acceptance, priority: item.priority, kind: item.kind,
      },
    });
  });

  server.registerTool("foreman__work_report", {
    description: "Report progress on a claimed work item; extends the claim lease.",
    inputSchema: {
      work_item_id: z.string().uuid(),
      progress_note: z.string().min(1),
      percent: z.number().min(0).max(100).optional(),
    },
  }, async ({ work_item_id, progress_note, percent }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    const owned = await assertOwnsWorkItem(pool, work_item_id, ctx.agentId);
    if (!owned) return err("not_yours", "work item is not claimed by you");
    await pool.query("update work_items set status = 'in_progress', updated_at = now() where id = $1", [work_item_id]);
    await extendLease(pool, work_item_id, ctx.agentId);
    await appendEvent(pool, {
      organisation_id: owned.organisationId, project_id: owned.projectId, agent_id: ctx.agentId,
      work_item_id, type: "work.progressed", payload: { note: progress_note, percent },
    });
    return ok({ ack: true });
  });

  server.registerTool("foreman__work_block", {
    description: "Mark a claimed work item as blocked.",
    inputSchema: {
      work_item_id: z.string().uuid(),
      reason: z.string().min(1),
      blocked_on: z.string().optional(),
    },
  }, async ({ work_item_id, reason, blocked_on }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    const owned = await assertOwnsWorkItem(pool, work_item_id, ctx.agentId);
    if (!owned) return err("not_yours", "work item is not claimed by you");
    await pool.query("update work_items set status = 'blocked', updated_at = now() where id = $1", [work_item_id]);
    await appendEvent(pool, {
      organisation_id: owned.organisationId, project_id: owned.projectId, agent_id: ctx.agentId,
      work_item_id, type: "work.blocked", payload: { reason, blocked_on },
    });
    return ok({ ack: true });
  });

  server.registerTool("foreman__work_complete", {
    description: "Complete a claimed work item with an acceptance-criteria verdict.",
    inputSchema: {
      work_item_id: z.string().uuid(),
      summary: z.string().min(1),
      acceptance_results: z.array(z.object({ criterion: z.string(), met: z.boolean() })),
      pr_url: z.string().optional(),
      commit_sha: z.string().optional(),
    },
  }, async ({ work_item_id, summary, acceptance_results, pr_url, commit_sha }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    try {
      await completeWorkItem(pool, {
        workItemId: work_item_id, agentId: ctx.agentId, summary,
        acceptanceResults: acceptance_results, prUrl: pr_url, commitSha: commit_sha,
      });
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      if (code === "acceptance_verdict_required") return err(code, (e as Error).message);
      if (e instanceof Error && /not claimed by you/.test(e.message)) return err("not_yours", e.message);
      throw e;
    }
    return ok({ ack: true });
  });

  server.registerTool("foreman__work_checkpoint", {
    description: "Ask a human/supervisor a blocking question about a claimed work item.",
    inputSchema: {
      work_item_id: z.string().uuid(),
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
      context: z.string().optional(),
    },
  }, async ({ work_item_id, question, options, context }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    const owned = await assertOwnsWorkItem(pool, work_item_id, ctx.agentId);
    if (!owned) return err("not_yours", "work item is not claimed by you");
    const res = await pool.query(
      `insert into checkpoints (organisation_id, project_id, work_item_id, agent_id, question, options, context)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [owned.organisationId, owned.projectId, work_item_id, ctx.agentId, question,
        options ? JSON.stringify(options) : null, context ?? null]);
    const checkpointId = res.rows[0].id;
    await pool.query("update work_items set status = 'blocked', updated_at = now() where id = $1", [work_item_id]);
    await appendEvent(pool, {
      organisation_id: owned.organisationId, project_id: owned.projectId, agent_id: ctx.agentId,
      work_item_id, type: "work.checkpoint_requested", payload: { checkpoint_id: checkpointId, question, options, context },
    });
    return ok({ checkpoint_id: checkpointId, status: "pending", poll_interval_ms: 2000 });
  });

  server.registerTool("foreman__checkpoint_poll", {
    description: "Poll a checkpoint for a human answer.",
    inputSchema: { checkpoint_id: z.string().uuid() },
  }, async ({ checkpoint_id }) => {
    const res = await pool.query(
      "select work_item_id, organisation_id, project_id, status, answer from checkpoints where id = $1",
      [checkpoint_id]);
    if (!res.rowCount) return err("not_found", "checkpoint not found");
    const row = res.rows[0];
    if (row.status !== "answered") return ok({ status: "open" });
    const flipped = await pool.query(
      "update work_items set status = 'in_progress', updated_at = now() where id = $1 and status = 'blocked' returning id",
      [row.work_item_id]);
    if (flipped.rowCount) {
      await appendEvent(pool, {
        organisation_id: row.organisation_id, project_id: row.project_id, work_item_id: row.work_item_id,
        type: "work.unblocked", payload: {},
      });
    }
    return ok({ status: "answered", answer: row.answer });
  });

  server.registerTool("foreman__comm_send", {
    description: "Send a message to another agent or broadcast to the project/organisation.",
    inputSchema: {
      to_agent_id: z.string().uuid().optional(),
      broadcast_scope: z.enum(["project", "organisation"]).optional(),
      message: z.string().min(1),
    },
  }, async ({ to_agent_id, broadcast_scope, message }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    if ((to_agent_id ? 1 : 0) + (broadcast_scope ? 1 : 0) !== 1) {
      return err("invalid_argument", "exactly one of to_agent_id or broadcast_scope is required");
    }
    await appendEvent(pool, {
      organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: ctx.agentId,
      type: "comm.message_sent", payload: { from_agent_id: ctx.agentId, to_agent_id, broadcast_scope, message },
    });
    return ok({ delivered: true });
  });

  server.registerTool("foreman__context_get", {
    description: "Get a snapshot of the project's work item counts by status.",
    inputSchema: { sections: z.array(z.string()).optional() },
  }, async () => {
    const proj = await pool.query("select id, name from projects where id = $1", [ctx.projectId]);
    if (!proj.rowCount) return err("not_found", "project not found");
    const counts = await pool.query(
      "select status, count(*)::int as n from work_items where project_id = $1 group by status", [ctx.projectId]);
    const buckets = { queued: 0, claimed: 0, in_progress: 0, blocked: 0, done: 0 };
    for (const row of counts.rows) {
      if (row.status in buckets) buckets[row.status as keyof typeof buckets] = row.n;
    }
    return ok({ project: { id: proj.rows[0].id, name: proj.rows[0].name }, counts: buckets });
  });

  return server;
}
