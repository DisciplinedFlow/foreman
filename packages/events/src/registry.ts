import { z } from "zod";

const uuid = z.string().uuid();
const str = z.string().min(1);

export const registry = {
  "agent.announced": z.object({ display_name: str, platform: str, model: z.string().optional(), capabilities: z.array(z.string()).default([]) }).strict(),
  "agent.heartbeat": z.object({ status: str, current_tool: z.string().optional(), current_work_item_id: uuid.optional() }).strict(),
  "agent.went_offline": z.object({ reason: z.string().optional() }).strict(),
  "agent.stalled": z.object({ threshold_sec: z.number().int(), last_transition_at: z.string() }).strict(),
  "agent.resumed": z.object({}).strict(),
  "agent.errored": z.object({ message: str }).strict(),

  "work.created": z.object({ title: str, kind: str, priority: z.number().int() }).strict(),
  "work.enqueued": z.object({ priority: z.number().int() }).strict(),
  "work.claimed": z.object({ agent_id: uuid, lease_expires_at: z.string() }).strict(),
  "work.progressed": z.object({ note: str, percent: z.number().min(0).max(100).optional() }).strict(),
  "work.blocked": z.object({ reason: str, blocked_on: z.string().optional() }).strict(),
  "work.unblocked": z.object({}).strict(),
  "work.checkpoint_requested": z.object({ checkpoint_id: uuid, question: str, options: z.array(z.string()).optional(), context: z.string().optional() }).strict(),
  "work.checkpoint_answered": z.object({ checkpoint_id: uuid, answer: str, answered_by: z.string() }).strict(),
  "work.completed": z.object({ summary: str, acceptance_results: z.array(z.object({ criterion: str, met: z.boolean() }).strict()), pr_url: z.string().optional(), commit_sha: z.string().optional() }).strict(),
  "work.failed": z.object({ reason: str }).strict(),
  "work.cancelled": z.object({ by: str }).strict(),
  "work.lease_expired": z.object({ agent_id: uuid }).strict(),
  "work.reprioritised": z.object({ from: z.number().int(), to: z.number().int() }).strict(),
  "work.reassigned": z.object({ by: str, reason: z.string().optional() }).strict(),
  "work.rescheduled": z.object({ start_at: z.string().optional(), target_at: z.string().optional(), iteration_id: z.string().optional() }).strict(),

  "comm.message_sent": z.object({ from_agent_id: uuid, to_agent_id: uuid.optional(), broadcast_scope: z.enum(["project","organisation"]).optional(), message: str }).strict(),
  "comm.subagent_spawned": z.object({ parent_agent_id: uuid, child_agent_id: uuid, agent_type: z.string().optional() }).strict(),
  "comm.subagent_returned": z.object({ parent_agent_id: uuid, child_agent_id: uuid }).strict(),

  "tool.invoked": z.object({ tool_name: str, tool_use_id: str, input: z.record(z.unknown()).optional() }).strict(),
  "tool.returned": z.object({ tool_name: str, tool_use_id: str, duration_ms: z.number().int().optional(), is_error: z.boolean().optional() }).strict(),
  "tool.denied": z.object({ tool_name: str, tool_use_id: str, reason: z.string().optional() }).strict(),

  "github.issue_synced": z.object({ gh_repo: str, gh_issue_number: z.number().int(), gh_issue_node_id: str }).strict(),
  "github.pr_opened": z.object({ gh_repo: str, pr_number: z.number().int(), pr_url: str }).strict(),
  "github.pr_merged": z.object({ gh_repo: str, pr_number: z.number().int(), pr_url: str, merge_sha: z.string().optional() }).strict(),
  "github.check_updated": z.object({ gh_repo: str, check_run_id: z.number().int(), status: str, conclusion: z.string().optional() }).strict(),
  "github.project_item_changed": z.object({ gh_item_node_id: str, field_node_id: z.string().optional(), from: z.unknown().optional(), to: z.unknown().optional() }).strict(),

  "repo.endpoint_discovered": z.object({ method: str, path: str, framework: z.string().optional() }).strict(),
  "repo.endpoint_state_changed": z.object({ method: str, path: str, from: str, to: str }).strict(),
  "deploy.succeeded": z.object({ environment: z.string().optional(), sha: z.string().optional() }).strict(),
  "deploy.failed": z.object({ environment: z.string().optional(), sha: z.string().optional(), reason: z.string().optional() }).strict(),

  "overview.regenerated": z.object({ version: z.number().int(), sections: z.array(z.string()) }).strict(),
  "brief.generated": z.object({ brief_id: uuid, window_start: z.string(), window_end: z.string() }).strict(),
  "brief.delivered": z.object({ brief_id: uuid, channel: str }).strict(),

  "human.directed": z.object({ actor_user_id: uuid, target: str, directive: str }).strict(),
  "human.decided": z.object({ actor_user_id: uuid, checkpoint_id: uuid, answer: str }).strict(),
  "human.overrode": z.object({ actor_user_id: uuid, subject: str, note: z.string().optional() }).strict(),
} as const;

export type EventType = keyof typeof registry;
export const EVENT_TYPES = Object.keys(registry) as EventType[];
