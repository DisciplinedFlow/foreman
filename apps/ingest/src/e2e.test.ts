import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { enqueueWorkItem } from "@foreman/db";
import type pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GetTaskResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp as createMcpApp } from "foreman-mcp/lib";
import { createApp as createApiApp } from "foreman-api/lib";
import { detectStalls } from "foreman-scheduler/lib";
import { generateBrief } from "foreman-gen/lib";
import { createIngestApp } from "./http.js";
import { createAgentToken } from "./auth.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let userId: string;
let token: string;
let ingestUrl: string;
let mcpUrl: string;
let apiUrl: string;
const closers: Array<() => Promise<unknown>> = [];

async function listen(app: { listen(port: number): any }, path: string): Promise<string> {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  closers.push(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}${path}`;
}

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId, userId } = await seedOrgWithUser(db.servicePool, "loopclose"));
  ({ token } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId }));
  ingestUrl = await listen(createIngestApp(db.servicePool as pg.Pool), "/ingest/hook");
  mcpUrl = await listen(createMcpApp(db.servicePool as pg.Pool), "/mcp");
  const appPool = new (await import("pg")).default.Pool({ connectionString: db.appUrl, max: 5 });
  closers.push(() => appPool.end());
  apiUrl = await listen(createApiApp({
    appPool, servicePool: db.servicePool as pg.Pool, secret: "e2e", devAuth: true,
  }), "");
});
afterAll(async () => { for (const c of closers.reverse()) await c(); await db.teardown(); });

const sessionId = crypto.randomUUID();
const postHook = (name: string, extra: object = {}) =>
  fetch(ingestUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: sessionId, cwd: "C:/work/loop-repo", hook_event_name: name, ...extra }),
  });

describe("loop closure: telemetry → stall → resume → claim task → checkpoint → check run → brief", () => {
  it("runs the whole story", async () => {
    // 1. Passive telemetry activates the agent
    await postHook("SessionStart");
    const agent = await db.servicePool.query("select id, status from agents where organisation_id=$1", [orgId]);
    expect(agent.rowCount).toBe(1);

    // 2. Loop fixture: five identical tool calls → stalled (rule B)
    for (let i = 0; i < 5; i++) {
      await postHook("PreToolUse", { tool_name: "Bash", tool_use_id: "loop", tool_input: { c: "npm test" } });
    }
    await detectStalls(db.servicePool as pg.Pool);
    expect((await db.servicePool.query("select status from agents where id=$1", [agent.rows[0].id])).rows[0].status)
      .toBe("stalled");

    // 3. The same token connects over MCP; heartbeat resumes it
    const client = new Client({ name: "loop-agent", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError ?? false).toBe(false);
      return JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
    };
    await call("foreman__agent_announce", { display_name: "loop-agent", platform: "claude-code", capabilities: [] });
    await call("foreman__agent_heartbeat", { status: "working" });
    expect((await db.servicePool.query(
      "select 1 from events where type='agent.resumed' and agent_id=$1", [agent.rows[0].id])).rowCount).toBe(1);

    // 4. Claim as a task: waiting → enqueue → completed
    const waiting = await call("foreman__work_claim", { wait: true });
    expect(waiting.status).toBe("waiting");
    const item = await enqueueWorkItem(db.servicePool, {
      organisationId: orgId, projectId, title: "close the loop", acceptance: ["loop closed"] });
    const polled = await client.request(
      { method: "tasks/get", params: { taskId: waiting.task.taskId } }, GetTaskResultSchema);
    expect(polled.status).toBe("completed");
    const assignment = await client.request(
      { method: "tasks/result", params: { taskId: waiting.task.taskId } }, CallToolResultSchema);
    expect(JSON.parse((assignment.content as any[])[0].text).work_item.id).toBe(item.id);

    // 5. Checkpoint → human answers through the api → agent reads the answer
    const cp = await call("foreman__work_checkpoint", { work_item_id: item.id, question: "merge strategy?" });
    const login = await fetch(`${apiUrl}/auth/dev-login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "loopclose@test.local" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const open = await (await fetch(`${apiUrl}/api/projects/${projectId}/checkpoints`, { headers: { cookie } })).json();
    expect(open.checkpoints.map((c: any) => c.id)).toContain(cp.checkpoint_id);
    const answered = await fetch(`${apiUrl}/api/checkpoints/${cp.checkpoint_id}/answer`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ answer: "squash" }),
    });
    expect(answered.status).toBe(200);
    const cpTask = await client.request(
      { method: "tasks/get", params: { taskId: cp.task.taskId } }, GetTaskResultSchema);
    expect(cpTask.status).toBe("completed");
    const decision = await client.request(
      { method: "tasks/result", params: { taskId: cp.task.taskId } }, CallToolResultSchema);
    expect(JSON.parse((decision.content as any[])[0].text).answer).toBe("squash");

    // 6. Complete with a sha → check-run job queued
    await call("foreman__work_report", { work_item_id: item.id, progress_note: "resuming after decision" });
    await call("foreman__work_complete", {
      work_item_id: item.id, summary: "loop closed", commit_sha: "sha-loop",
      acceptance_results: [{ criterion: "loop closed", met: true }],
    });
    expect((await db.servicePool.query(
      `select 1 from sync_jobs where event_name='foreman.report_run'
       and payload->>'state'='completed' and payload->>'work_item_id'=$1`, [item.id])).rowCount).toBe(1);

    // 7. The brief tells the story: shipped item, no open decisions, no stalled agents
    const brief = await generateBrief(db.servicePool as pg.Pool, projectId);
    expect(brief.content.shipped.map((s) => s.work_item_id)).toContain(item.id);
    expect(brief.content.decisions).toEqual([]);
    expect(brief.content.risks.stalled_agents).toBe(0);
    void userId;
  });
});
