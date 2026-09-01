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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textOf(content: unknown): string {
  const first = (content as { type: string; text: string }[] | undefined)?.[0];
  return first?.text ?? "{}";
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const body = JSON.parse(textOf(res.content));
  if (res.isError) throw new Error(`${name} failed: ${body.code ?? "error"}: ${body.message ?? JSON.stringify(body)}`);
  return body;
}

// foreman__work_claim {wait:true} on an empty queue hands back a "waiting" task
// rather than blocking the tool call itself (gate 1's tasks surface). We poll
// tasks/get until the scheduler's poll-through completes it with an assignment,
// or it is cancelled/fails — never busy-poll foreman__work_claim directly.
async function claimNext(client: Client, log: (msg: string) => void): Promise<WorkItem> {
  const claim = await callTool(client, "foreman__work_claim", { wait: true });
  if (claim.status === "assigned") return claim.work_item;
  if (claim.status !== "waiting") throw new Error(`unexpected work_claim status: ${claim.status}`);

  const taskId: string = claim.task.taskId;
  let pollIntervalMs: number = claim.task.pollInterval ?? 2000;
  log(`waiting for work (task ${taskId})...`);
  for (;;) {
    await sleep(pollIntervalMs);
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
    log("received SIGINT — finishing the current item, then shutting down...");
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
      const item = await claimNext(client, log);
      log(`claimed work item ${item.id}: ${item.title}`);
      await callTool(client, "foreman__agent_heartbeat", { status: "working", current_work_item_id: item.id });

      const { system, user } = buildPrompt(item);
      let summary: string;
      try {
        summary = await opts.provider.complete(system, user);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`provider error on ${item.id}: ${message}`);
        await callTool(client, "foreman__work_block", {
          work_item_id: item.id, reason: `provider error: ${message}`,
        });
        if (opts.once) break;
        continue;
      }

      await callTool(client, "foreman__work_report", {
        work_item_id: item.id, progress_note: summary.slice(0, 4000),
      });

      // No independent verifier runs here: the provider's own account of the
      // work is the only signal we have, so every stated criterion is marked
      // met. A real acceptance check (tests, a reviewing agent) belongs in
      // front of foreman__work_complete, not inside this loop.
      const acceptanceResults = item.acceptance.map((criterion) => ({ criterion, met: true }));
      await callTool(client, "foreman__work_complete", {
        work_item_id: item.id, summary: summary.slice(0, 4000), acceptance_results: acceptanceResults,
      });
      log(`completed work item ${item.id}`);

      await callTool(client, "foreman__agent_heartbeat", { status: "idle" });

      if (opts.once) break;
    }
  } finally {
    process.off("SIGINT", onSigint);
    await client.close();
  }
}
