import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  GetTaskRequestSchema, GetTaskPayloadRequestSchema, CancelTaskRequestSchema,
  McpError, ErrorCode, type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createTask, taskToWire, pollTask, cancelTask } from "./tasks.js";
import { z } from "zod";
import type pg from "pg";
import {
  appendEvent, claimNextWorkItem, completeWorkItem, extendLease, WipLimitExceededError,
  type Queryable,
} from "@foreman/db";
import type { AuthCtx } from "./auth.js";

function ok(out: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
}

function err(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] };
}

const NOT_ANNOUNCED = err("not_announced", "agent has not announced yet; call foreman__agent_announce first");

// GHA-5: claim/report/complete reflect into a check run via the github worker —
// the MCP server never holds GitHub credentials, it only enqueues the job.
async function enqueueReportRun(q: Queryable, orgId: string, projectId: string, payload: {
  work_item_id: string; state: "queued" | "in_progress" | "completed";
  summary?: string; head_sha?: string; conclusion?: "success" | "failure" | "cancelled";
}): Promise<void> {
  const proj = await q.query("select gh_installation_id from projects where id = $1", [projectId]);
  await q.query(
    `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)
     values ($1,$2,$3,'foreman.report_run',$4)`,
    [orgId, proj.rows[0]?.gh_installation_id ?? 0,
     `reportrun:${payload.work_item_id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
     JSON.stringify(payload)]);
}

async function assertOwnsWorkItem(q: Queryable, workItemId: string, agentId: string):
  Promise<{ organisationId: string; projectId: string; status: string } | null> {
  const res = await q.query(
    "select organisation_id, project_id, status, claimed_by from work_items where id = $1", [workItemId]);
  if (!res.rowCount || res.rows[0].claimed_by !== agentId) return null;
  return { organisationId: res.rows[0].organisation_id, projectId: res.rows[0].project_id, status: res.rows[0].status };
}

// Every mutation + its event must land atomically (X-1): check out one client, begin/commit/rollback
// around it, so a crash mid-tool-call never leaves state mutated without the event that explains it.
async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const result = await fn(c);
    await c.query("commit");
    return result;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

export function buildMcpServer(pool: pg.Pool, ctx: AuthCtx): McpServer {
  const server = new McpServer({ name: "foreman-mcp", version: "0.1.0" },
    { capabilities: { tasks: {} } });

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

    const agentId = await withTx(pool, async (c) => {
      if (ctx.agentId) {
        const agentId = ctx.agentId;
        await c.query(
          "update agents set display_name = $1, platform = $2, model = $3, capabilities = $4 where id = $5",
          [display_name, platform, model ?? null, caps, agentId]);
        await appendEvent(c, {
          organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: agentId,
          type: "agent.announced", payload: { display_name, platform, model, capabilities: caps },
        });
        return agentId;
      }

      // First announce for this token: insert a new agent, then atomically bind the token to it.
      const ins = await c.query(
        `insert into agents (organisation_id, project_id, display_name, platform, model, capabilities, integration_depth)
         values ($1,$2,$3,$4,$5,$6,'mcp') returning id`,
        [ctx.organisationId, ctx.projectId, display_name, platform, model ?? null, caps]);
      const newAgentId: string = ins.rows[0].id;

      const bind = await c.query(
        "update agent_tokens set agent_id = $1 where id = $2 and agent_id is null returning agent_id",
        [newAgentId, ctx.tokenId]);

      let agentId: string;
      if (bind.rowCount) {
        agentId = newAgentId;
      } else {
        // Lost a concurrent first-announce race on the same token: another request already bound
        // it. Discard our now-orphaned agent row and fold this announce into the winner instead.
        await c.query("delete from agents where id = $1", [newAgentId]);
        const winner = await c.query("select agent_id from agent_tokens where id = $1", [ctx.tokenId]);
        agentId = winner.rows[0].agent_id;
        await c.query(
          "update agents set display_name = $1, platform = $2, model = $3, capabilities = $4 where id = $5",
          [display_name, platform, model ?? null, caps, agentId]);
      }

      await appendEvent(c, {
        organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: agentId,
        type: "agent.announced", payload: { display_name, platform, model, capabilities: caps },
      });
      return agentId;
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
    const agentId = ctx.agentId;
    await withTx(pool, async (c) => {
      const prior = await c.query("select status from agents where id = $1 for update", [agentId]);
      await c.query("update agents set status = $1, last_seen_at = now() where id = $2", [status, agentId]);
      if (current_work_item_id) await extendLease(c, current_work_item_id, agentId);
      // AVW-3 recovery: any heartbeat from a stalled agent means it's back.
      if (prior.rows[0]?.status === "stalled") {
        await appendEvent(c, {
          organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: agentId,
          type: "agent.resumed", payload: {},
        });
      }
      await appendEvent(c, {
        organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: agentId,
        type: "agent.heartbeat", payload: { status, current_tool, current_work_item_id },
      });
    });
    return ok({ ack: true, directives: [] });
  });

  server.registerTool("foreman__work_claim", {
    description: "Claim the next available work item in this project (priority order, WIP-limited). "
      + "Pass wait:true to receive a task on an empty queue; poll it with tasks/get until completed.",
    inputSchema: { wait: z.boolean().optional() },
  }, async ({ wait }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    let item;
    try {
      item = await claimNextWorkItem(pool, { projectId: ctx.projectId, agentId: ctx.agentId });
    } catch (e) {
      if (e instanceof WipLimitExceededError) return err("wip_limit_exceeded", `wip limit exceeded: ${e.scope}`);
      throw e;
    }
    if (!item && wait === true) {
      const task = await createTask(pool, {
        organisationId: ctx.organisationId, agentId: ctx.agentId, kind: "claim" });
      return ok({ status: "waiting", task: taskToWire(task) });
    }
    if (!item) return ok({ status: "empty", retry_after_ms: 2000 });
    await enqueueReportRun(pool, ctx.organisationId, ctx.projectId, {
      work_item_id: item.id, state: "in_progress", summary: "Claimed by an agent",
    });
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
      commit_sha: z.string().optional(),
    },
  }, async ({ work_item_id, progress_note, percent, commit_sha }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    const agentId = ctx.agentId;
    return withTx(pool, async (c) => {
      const owned = await assertOwnsWorkItem(c, work_item_id, agentId);
      if (!owned) return err("not_yours", "work item is not claimed by you");
      const wasBlocked = owned.status === "blocked";
      await c.query("update work_items set status = 'in_progress', updated_at = now() where id = $1", [work_item_id]);
      await extendLease(c, work_item_id, agentId);
      if (wasBlocked) {
        await appendEvent(c, {
          organisation_id: owned.organisationId, project_id: owned.projectId, agent_id: agentId,
          work_item_id, type: "work.unblocked", payload: {},
        });
      }
      await appendEvent(c, {
        organisation_id: owned.organisationId, project_id: owned.projectId, agent_id: agentId,
        work_item_id, type: "work.progressed", payload: { note: progress_note, percent },
      });
      await enqueueReportRun(c, owned.organisationId, owned.projectId, {
        work_item_id, state: "in_progress", summary: progress_note,
        ...(commit_sha !== undefined ? { head_sha: commit_sha } : {}),
      });
      return ok({ ack: true });
    });
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
    const agentId = ctx.agentId;
    return withTx(pool, async (c) => {
      const owned = await assertOwnsWorkItem(c, work_item_id, agentId);
      if (!owned) return err("not_yours", "work item is not claimed by you");
      await c.query("update work_items set status = 'blocked', updated_at = now() where id = $1", [work_item_id]);
      await appendEvent(c, {
        organisation_id: owned.organisationId, project_id: owned.projectId, agent_id: agentId,
        work_item_id, type: "work.blocked", payload: { reason, blocked_on },
      });
      return ok({ ack: true });
    });
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
    await enqueueReportRun(pool, ctx.organisationId, ctx.projectId, {
      work_item_id, state: "completed",
      summary, conclusion: acceptance_results.every((r) => r.met) ? "success" : "failure",
      ...(commit_sha !== undefined ? { head_sha: commit_sha } : {}),
    });
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
    const agentId = ctx.agentId;
    return withTx(pool, async (c) => {
      const owned = await assertOwnsWorkItem(c, work_item_id, agentId);
      if (!owned) return err("not_yours", "work item is not claimed by you");
      const res = await c.query(
        `insert into checkpoints (organisation_id, project_id, work_item_id, agent_id, question, options, context)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [owned.organisationId, owned.projectId, work_item_id, agentId, question,
          options ? JSON.stringify(options) : null, context ?? null]);
      const checkpointId = res.rows[0].id;
      await c.query("update work_items set status = 'blocked', updated_at = now() where id = $1", [work_item_id]);
      await appendEvent(c, {
        organisation_id: owned.organisationId, project_id: owned.projectId, agent_id: agentId,
        work_item_id, type: "work.checkpoint_requested", payload: { checkpoint_id: checkpointId, question, options, context },
      });
      // Task-shaped checkpoint (gate 1): input_required until the human answers;
      // tasks/get poll-through completes it. checkpoint_poll remains for old clients.
      const task = await createTask(c, {
        organisationId: owned.organisationId, agentId, kind: "checkpoint",
        checkpointId, status: "input_required",
      });
      return ok({ checkpoint_id: checkpointId, status: "pending", poll_interval_ms: 2000, task: taskToWire(task) });
    });
  });

  server.registerTool("foreman__checkpoint_poll", {
    description: "Poll a checkpoint for a human answer.",
    inputSchema: { checkpoint_id: z.string().uuid() },
  }, async ({ checkpoint_id }) => {
    if (!ctx.agentId) return NOT_ANNOUNCED;
    return withTx(pool, async (c) => {
      // Scoped to this org AND to the agent that raised the checkpoint: a checkpoint id alone must
      // never reveal whether it exists, let alone its contents, to a caller outside its tenant.
      const res = await c.query(
        `select work_item_id, organisation_id, project_id, status, answer
         from checkpoints where id = $1 and organisation_id = $2 and agent_id = $3`,
        [checkpoint_id, ctx.organisationId, ctx.agentId]);
      if (!res.rowCount) return err("not_found", "checkpoint not found");
      const row = res.rows[0];
      if (row.status !== "answered") return ok({ status: "open" });
      const flipped = await c.query(
        "update work_items set status = 'in_progress', updated_at = now() where id = $1 and status = 'blocked' returning id",
        [row.work_item_id]);
      if (flipped.rowCount) {
        await appendEvent(c, {
          organisation_id: row.organisation_id, project_id: row.project_id, work_item_id: row.work_item_id,
          type: "work.unblocked", payload: {},
        });
      }
      return ok({ status: "answered", answer: row.answer });
    });
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
    if (to_agent_id) {
      const target = await pool.query(
        "select id from agents where id = $1 and organisation_id = $2", [to_agent_id, ctx.organisationId]);
      if (!target.rowCount) return err("not_found", "target agent not found");
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

  // Published tasks surface (gate 1: tasks/get, tasks/result, tasks/cancel; no
  // tasks/update exists; tasks/list intentionally unimplemented in v1).
  server.server.setRequestHandler(GetTaskRequestSchema, async (req) => {
    const row = await pollTask(pool, ctx, req.params.taskId);
    if (row === null) throw new McpError(ErrorCode.InvalidParams, "task not found");
    return taskToWire(row);
  });

  server.server.setRequestHandler(GetTaskPayloadRequestSchema, async (req) => {
    const row = await pollTask(pool, ctx, req.params.taskId);
    if (row === null) throw new McpError(ErrorCode.InvalidParams, "task not found");
    if (row.status !== "completed") {
      throw new McpError(ErrorCode.InvalidParams, `task is ${row.status}, not completed`);
    }
    return ok(row.result as Record<string, unknown>);
  });

  server.server.setRequestHandler(CancelTaskRequestSchema, async (req) => {
    const row = await cancelTask(pool, ctx, req.params.taskId);
    if (row === null) throw new McpError(ErrorCode.InvalidParams, "task not found");
    return taskToWire(row);
  });

  return server;
}
