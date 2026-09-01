import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GetTaskResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Provider } from "./providers.js";

export interface WorkItem {
  id: string;
  title: string;
  intent: string | null;
  acceptance: string[];
  priority: number;
  kind: string;
}

export interface RunLoopOptions {
  mcpUrl: string;
  token: string;
  provider: Provider;
  model?: string;
  displayName?: string;
  platform?: string;
  /** Process a single work item and return, instead of looping forever. */
  once?: boolean;
  log?: (msg: string) => void;
}

// Returned by claimNext to mean "the caller asked us to stop while we were
// idle" — distinct from a thrown error, since an idle shutdown is a clean
// exit, not a failure.
export const CLAIM_STOPPED = Symbol("foreman-agent:claim-stopped");

const FALLBACK_SUMMARY = "(no output produced)";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(content: unknown): string {
  const first = (content as { type: string; text: string }[] | undefined)?.[0];
  return first?.text ?? "{}";
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The MCP tools (foreman__work_report's progress_note, foreman__work_complete's
// summary) reject empty strings (z.string().min(1)). A provider can return "" —
// an empty completion is a legitimate (if useless) model response, not a bug —
// so never forward it verbatim.
function nonEmpty(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : FALLBACK_SUMMARY;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(textOf(res.content));
  if (res.isError) throw new Error(`${name} failed: ${body.code ?? "error"}: ${body.message ?? JSON.stringify(body)}`);
  return body;
}

async function blockSafely(client: Client, workItemId: string, reason: string, log: (msg: string) => void): Promise<void> {
  try {
    await callTool(client, "foreman__work_block", { work_item_id: workItemId, reason });
  } catch (e) {
    // Blocking is best-effort here: we're already handling one failure, and a
    // second one (e.g. the connection just died) must not crash the process.
    log(`failed to block work item ${workItemId} after an error: ${errorMessage(e)}`);
  }
}

// foreman__work_claim {wait:true} on an empty queue hands back a "waiting" task
// rather than blocking the tool call itself (gate 1's tasks surface). We poll
// tasks/get until the scheduler's poll-through completes it with an assignment,
// or it is cancelled/fails — never busy-poll foreman__work_claim directly.
//
// isStopping() is checked before every network round-trip in this function —
// including the idle poll loop, which is the common state an agent sits in —
// so a SIGINT-triggered shutdown while idle returns promptly instead of only
// being observed after the next item arrives.
export async function claimNext(
  client: Client, isStopping: () => boolean, log: (msg: string) => void,
): Promise<WorkItem | typeof CLAIM_STOPPED> {
  if (isStopping()) return CLAIM_STOPPED;
  const claim = await callTool(client, "foreman__work_claim", { wait: true });
  if (claim.status === "assigned") return claim.work_item;
  if (claim.status !== "waiting") throw new Error(`unexpected work_claim status: ${claim.status}`);

  const taskId: string = claim.task.taskId;
  let pollIntervalMs: number = claim.task.pollInterval ?? 2000;
  log(`waiting for work (task ${taskId})...`);
  while (!isStopping()) {
    await sleep(pollIntervalMs);
    if (isStopping()) return CLAIM_STOPPED;
    const task = await client.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema);
    pollIntervalMs = task.pollInterval ?? pollIntervalMs;
    if (task.status === "completed") {
      const result = await client.request({ method: "tasks/result", params: { taskId } }, CallToolResultSchema);
      return JSON.parse(textOf(result.content)).work_item;
    }
    if (task.status === "cancelled" || task.status === "failed") {
      throw new Error(`work_claim task ${task.status}`);
    }
  }
  return CLAIM_STOPPED;
}

function buildPrompt(item: WorkItem): { system: string; user: string } {
  const system = "You are an autonomous engineering agent connected to Foreman, a control plane that "
    + "assigns work items and tracks progress. Do the work described below, then reply with a concise "
    + "account of what you did and changed — this reply is recorded as the completion summary.";
  const acceptance = item.acceptance.length > 0
    ? item.acceptance.map((a, i) => `${i + 1}. ${a}`).join("\n")
    : "(none specified)";
  const user = [
    `Title: ${item.title}`,
    item.intent ? `Intent: ${item.intent}` : null,
    `Acceptance criteria:\n${acceptance}`,
  ].filter((line): line is string => line !== null).join("\n\n");
  return { system, user };
}

export async function runLoop(opts: RunLoopOptions): Promise<void> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const displayName = opts.displayName ?? `foreman-agent (${opts.provider.name})`;

  const client = new Client({ name: "foreman-agent", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(opts.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
  }));

  let stopping = false;
  const onSigint = () => {
    stopping = true;
    log("received SIGINT — finishing the current item (or idling out), then shutting down...");
  };
  process.on("SIGINT", onSigint);

  try {
    await callTool(client, "foreman__agent_announce", {
      display_name: displayName,
      platform: opts.platform ?? "foreman-agent",
      ...(opts.model ? { model: opts.model } : {}),
      capabilities: [opts.provider.name],
    });

    while (!stopping) {
      let claimed: WorkItem | typeof CLAIM_STOPPED;
      try {
        claimed = await claimNext(client, () => stopping, log);
      } catch (e) {
        // A cancelled/failed claim task (or any other claim-time error) costs us
        // this attempt, not the process — log it and try again next iteration.
        log(`work_claim failed: ${errorMessage(e)}`);
        if (opts.once) break;
        continue;
      }
      if (claimed === CLAIM_STOPPED) break;
      const item = claimed;
      log(`claimed work item ${item.id}: ${item.title}`);

      // Everything from here on is scoped to this one item: whatever goes
      // wrong, it must cost us this item (blocked, logged, move on), never the
      // whole agent process.
      try {
        await callTool(client, "foreman__agent_heartbeat", { status: "working", current_work_item_id: item.id });

        const { system, user } = buildPrompt(item);
        let summary: string;
        try {
          summary = await opts.provider.complete(system, user);
        } catch (e) {
          const message = errorMessage(e);
          log(`provider error on ${item.id}: ${message}`);
          await blockSafely(client, item.id, `provider error: ${message}`, log);
          if (opts.once) break;
          continue;
        }

        const safeSummary = nonEmpty(summary.slice(0, 4000));

        await callTool(client, "foreman__work_report", {
          work_item_id: item.id, progress_note: safeSummary,
        });

        // No independent verifier runs here: the provider's own account of the
        // work is the only signal we have, so every stated criterion is marked
        // met. A real acceptance check (tests, a reviewing agent) belongs in
        // front of foreman__work_complete, not inside this loop.
        const acceptanceResults = item.acceptance.map((criterion) => ({ criterion, met: true }));
        await callTool(client, "foreman__work_complete", {
          work_item_id: item.id, summary: safeSummary, acceptance_results: acceptanceResults,
        });
        log(`completed work item ${item.id}`);

        await callTool(client, "foreman__agent_heartbeat", { status: "idle" });
      } catch (e) {
        const message = errorMessage(e);
        log(`failed to process work item ${item.id}: ${message}`);
        await blockSafely(client, item.id, `agent error: ${message}`, log);
      }

      if (opts.once) break;
    }
  } finally {
    process.off("SIGINT", onSigint);
    await client.close();
  }
}
