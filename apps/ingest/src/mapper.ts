import { z } from "zod";
import { appendEvent, type Queryable } from "@foreman/db";
import type { AuthCtx } from "./auth.js";

// Verified hook payload fields (SPEC §11 item 8, resolved 31-08-2026).
const hookPayload = z.object({
  session_id: z.string(),
  cwd: z.string().optional(),
  hook_event_name: z.string(),
  tool_name: z.string().optional(),
  tool_input: z.record(z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
}).passthrough();

export type HookPayload = z.infer<typeof hookPayload>;

export function parseHook(body: unknown): HookPayload | null {
  const p = hookPayload.safeParse(body);
  return p.success ? p.data : null;
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? "claude-code";

// Resolve (or create+bind) the agent for this token. §4.1: SessionStart on a fresh
// token is the ten-second onboarding path — the agent row appears with no code change.
async function resolveAgent(tx: Queryable, ctx: AuthCtx, hook: HookPayload): Promise<string | null> {
  if (ctx.agentId !== null) return ctx.agentId;
  if (hook.hook_event_name !== "SessionStart") return null; // nothing to attach to yet
  const ins = await tx.query(
    `insert into agents (organisation_id, project_id, display_name, platform, integration_depth, status, last_seen_at)
     values ($1,$2,$3,'claude-code','telemetry','working',now()) returning id`,
    [ctx.organisationId, ctx.projectId, basename(hook.cwd ?? "")]);
  const agentId: string = ins.rows[0].id;
  await tx.query("update agent_tokens set agent_id = $1 where id = $2 and agent_id is null", [agentId, ctx.tokenId]);
  await appendEvent(tx, {
    organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: agentId,
    type: "agent.announced",
    payload: { display_name: basename(hook.cwd ?? ""), platform: "claude-code", capabilities: [] },
  });
  return agentId;
}

export async function mapHook(tx: Queryable, ctx: AuthCtx, hook: HookPayload): Promise<void> {
  const agentId = await resolveAgent(tx, ctx, hook);
  if (agentId === null) return;
  const base = { organisation_id: ctx.organisationId, project_id: ctx.projectId, agent_id: agentId };
  const touch = () => tx.query("update agents set last_seen_at = now() where id = $1", [agentId]);

  switch (hook.hook_event_name) {
    case "SessionStart": {
      await tx.query("update agents set status='working', last_seen_at=now() where id = $1", [agentId]);
      const open = await tx.query(
        "select 1 from runs where external_session_id = $1 and ended_at is null", [hook.session_id]);
      if (open.rowCount === 0) {
        await tx.query(
          "insert into runs (organisation_id, agent_id, external_session_id) values ($1,$2,$3)",
          [ctx.organisationId, agentId, hook.session_id]);
      }
      return;
    }
    case "PreToolUse": {
      if (hook.tool_name === undefined || hook.tool_use_id === undefined) return;
      // X-3/AVW-6: metadata only unless the tenant explicitly opted in.
      const org = await tx.query("select capture_tool_input from organisations where id = $1", [ctx.organisationId]);
      const capture = org.rows[0]?.capture_tool_input === true;
      await appendEvent(tx, {
        ...base, type: "tool.invoked",
        payload: {
          tool_name: hook.tool_name, tool_use_id: hook.tool_use_id,
          ...(capture && hook.tool_input !== undefined ? { input: hook.tool_input } : {}),
        },
      });
      await touch();
      return;
    }
    case "PostToolUse": {
      if (hook.tool_name === undefined || hook.tool_use_id === undefined) return;
      await appendEvent(tx, {
        ...base, type: "tool.returned",
        payload: { tool_name: hook.tool_name, tool_use_id: hook.tool_use_id },
      });
      await touch();
      return;
    }
    case "SubagentStart": {
      const child = await tx.query(
        `insert into agents (organisation_id, project_id, display_name, platform, integration_depth,
           parent_agent_id, status, last_seen_at)
         values ($1,$2,$3,'claude-code','telemetry',$4,'working',now()) returning id`,
        [ctx.organisationId, ctx.projectId, hook.agent_type ?? "subagent", agentId]);
      // Child identity rides a runs row keyed by the hook's agent_id (plan Task 3 decision).
      if (hook.agent_id !== undefined) {
        await tx.query(
          "insert into runs (organisation_id, agent_id, external_session_id) values ($1,$2,$3)",
          [ctx.organisationId, child.rows[0].id, hook.agent_id]);
      }
      await appendEvent(tx, {
        ...base, type: "comm.subagent_spawned",
        payload: { parent_agent_id: agentId, child_agent_id: child.rows[0].id, agent_type: hook.agent_type },
      });
      return;
    }
    case "SubagentStop": {
      if (hook.agent_id === undefined) return;
      const run = await tx.query(
        `update runs set ended_at = now() where external_session_id = $1 and ended_at is null
         returning agent_id`, [hook.agent_id]);
      if (run.rowCount === 0) return;
      const childId: string = run.rows[0].agent_id;
      await tx.query("update agents set status='offline' where id = $1", [childId]);
      await appendEvent(tx, {
        ...base, type: "comm.subagent_returned",
        payload: { parent_agent_id: agentId, child_agent_id: childId },
      });
      return;
    }
    case "Stop": {
      await tx.query(
        "update runs set ended_at = now() where external_session_id = $1 and ended_at is null", [hook.session_id]);
      await tx.query("update agents set status='offline', last_seen_at=now() where id = $1", [agentId]);
      await appendEvent(tx, { ...base, type: "agent.went_offline", payload: { reason: "session_end" } });
      return;
    }
    default:
      // Notification + future events: acked upstream, mapped to nothing (deviation 1).
      return;
  }
}
