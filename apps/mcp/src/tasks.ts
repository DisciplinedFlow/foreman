import crypto from "node:crypto";
import type pg from "pg";
import { claimNextWorkItem, WipLimitExceededError, type Queryable } from "@foreman/db";
import type { AuthCtx } from "./auth.js";

export interface TaskRow {
  task_id: string;
  organisation_id: string;
  agent_id: string;
  kind: "claim" | "checkpoint";
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  checkpoint_id: string | null;
  result: unknown;
  poll_interval_ms: number;
  ttl_ms: string | number | null;
  created_at: Date;
  last_updated_at: Date;
}

// AGT-8: task ids are bearer tokens — 32 random bytes, never sequential.
export async function createTask(q: Queryable, opts: {
  organisationId: string; agentId: string; kind: "claim" | "checkpoint";
  checkpointId?: string; status?: TaskRow["status"];
}): Promise<TaskRow> {
  const taskId = crypto.randomBytes(32).toString("base64url");
  const res = await q.query(
    `insert into mcp_tasks (task_id, organisation_id, agent_id, kind, status, checkpoint_id)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [taskId, opts.organisationId, opts.agentId, opts.kind, opts.status ?? "working", opts.checkpointId ?? null]);
  return res.rows[0] as TaskRow;
}

// Wire shape per the published TaskSchema (SDK 1.30.0, protocol 2025-11-25).
export function taskToWire(row: TaskRow): {
  taskId: string; status: string; ttl: number | null; createdAt: string; lastUpdatedAt: string; pollInterval: number;
} {
  return {
    taskId: row.task_id,
    status: row.status,
    ttl: row.ttl_ms === null ? null : Number(row.ttl_ms),
    createdAt: new Date(row.created_at).toISOString(),
    lastUpdatedAt: new Date(row.last_updated_at).toISOString(),
    pollInterval: row.poll_interval_ms,
  };
}

async function complete(pool: pg.Pool, taskId: string, result: unknown): Promise<TaskRow> {
  const res = await pool.query(
    `update mcp_tasks set status='completed', result=$2, last_updated_at=now()
     where task_id = $1 and status in ('working','input_required') returning *`,
    [taskId, JSON.stringify(result)]);
  return res.rows[0] as TaskRow;
}

// Poll-through (Phase 4 deviation 2): polling a waiting claim task attempts the
// claim right then — same claimNextWorkItem, same WIP/dep gating — so the task
// completes with no background completer. Scoped to the authenticated agent:
// someone else's taskId is null (not_found), never forbidden (no oracle).
export async function pollTask(pool: pg.Pool, ctx: AuthCtx, taskId: string): Promise<TaskRow | null> {
  const res = await pool.query(
    "select * from mcp_tasks where task_id = $1 and agent_id = $2", [taskId, ctx.agentId ?? null]);
  if (res.rowCount === 0) return null;
  const row = res.rows[0] as TaskRow;

  if (row.kind === "claim" && row.status === "working") {
    let item;
    try {
      item = await claimNextWorkItem(pool, { projectId: ctx.projectId, agentId: row.agent_id });
    } catch (e) {
      if (e instanceof WipLimitExceededError) return row; // still working; retry after pollInterval
      throw e;
    }
    if (item === null) return row;
    return complete(pool, taskId, {
      status: "assigned",
      work_item: {
        id: item.id, title: item.title, intent: item.intent,
        acceptance: item.acceptance, priority: item.priority, kind: item.kind,
      },
      lease_expires_at: new Date(item.lease_expires_at as unknown as string).toISOString(),
    });
  }

  if (row.kind === "checkpoint" && row.status === "input_required" && row.checkpoint_id !== null) {
    const cp = await pool.query(
      "select status, answer, answered_at from checkpoints where id = $1", [row.checkpoint_id]);
    if (cp.rowCount && cp.rows[0].status === "answered") {
      return complete(pool, taskId, {
        answer: cp.rows[0].answer,
        answered_at: cp.rows[0].answered_at !== null ? new Date(cp.rows[0].answered_at).toISOString() : null,
      });
    }
  }

  return row;
}

export async function cancelTask(pool: pg.Pool, ctx: AuthCtx, taskId: string): Promise<TaskRow | null> {
  const res = await pool.query(
    `update mcp_tasks set status='cancelled', last_updated_at=now()
     where task_id = $1 and agent_id = $2 and status in ('working','input_required') returning *`,
    [taskId, ctx.agentId ?? null]);
  if (res.rowCount) return res.rows[0] as TaskRow;
  // Terminal or unknown: return the row if it's theirs (cancel is idempotent-ish), else null.
  const existing = await pool.query(
    "select * from mcp_tasks where task_id = $1 and agent_id = $2", [taskId, ctx.agentId ?? null]);
  return existing.rowCount ? (existing.rows[0] as TaskRow) : null;
}
