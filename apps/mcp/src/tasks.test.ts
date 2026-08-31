import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GetTaskResultSchema, CancelTaskResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { enqueueWorkItem } from "@foreman/db";
import type pg from "pg";
import { createAgentToken } from "./auth.js";
import { createApp } from "./http.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let url: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "tasks"));
  const app = createApp(db.servicePool as pg.Pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  close = () => new Promise((r) => server.close(r));
});
afterAll(async () => { await close(); await db.teardown(); });

async function connect(): Promise<{ client: Client; call: (name: string, args: Record<string, unknown>) => Promise<any> }> {
  const { token } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId });
  const client = new Client({ name: "task-agent", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError ?? false).toBe(false);
    return JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
  };
  await call("foreman__agent_announce", { display_name: "task-agent", platform: "test", capabilities: [] });
  return { client, call };
}

const tasksGet = (client: Client, taskId: string) =>
  client.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema);
const tasksResult = (client: Client, taskId: string) =>
  client.request({ method: "tasks/result", params: { taskId } }, CallToolResultSchema);
const tasksCancel = (client: Client, taskId: string) =>
  client.request({ method: "tasks/cancel", params: { taskId } }, CancelTaskResultSchema);

describe("MCP tasks surface", () => {
  it("claim {wait:true} on empty queue → working task; enqueue → poll-through completes with the assignment", async () => {
    const { client, call } = await connect();
    const waiting = await call("foreman__work_claim", { wait: true });
    expect(waiting.status).toBe("waiting");
    const taskId: string = waiting.task.taskId;
    expect(taskId.length).toBeGreaterThan(30);
    expect(waiting.task.status).toBe("working");

    expect((await tasksGet(client, taskId)).status).toBe("working");

    const item = await enqueueWorkItem(db.servicePool, {
      organisationId: orgId, projectId, title: "task-claimed item", acceptance: [] });
    const polled = await tasksGet(client, taskId);
    expect(polled.status).toBe("completed");

    const result = await tasksResult(client, taskId);
    const payload = JSON.parse((result.content as any[])[0].text);
    expect(payload.work_item.id).toBe(item.id);
    const row = await db.servicePool.query("select status, claimed_by from work_items where id=$1", [item.id]);
    expect(row.rows[0].status).toBe("claimed");
  });

  it("another agent's token cannot see the task (no existence oracle)", async () => {
    const a = await connect();
    const waiting = await a.call("foreman__work_claim", { wait: true });
    const b = await connect();
    await expect(tasksGet(b.client, waiting.task.taskId)).rejects.toThrow(/not found/i);
  });

  it("tasks/cancel stops a waiting claim; the item stays unclaimed by it", async () => {
    const { client, call } = await connect();
    const waiting = await call("foreman__work_claim", { wait: true });
    const cancelled = await tasksCancel(client, waiting.task.taskId);
    expect(cancelled.status).toBe("cancelled");
    await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "post-cancel", acceptance: [] });
    expect((await tasksGet(client, waiting.task.taskId)).status).toBe("cancelled");
  });

  it("checkpoint task: input_required until the human answers, then completed with the answer", async () => {
    const { client, call } = await connect();
    await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "cp item", acceptance: [] });
    const claim = await call("foreman__work_claim", {});
    expect(claim.status).toBe("assigned");
    // the queue may hand us an older leftover item — checkpoint whatever we claimed
    const cp = await call("foreman__work_checkpoint", { work_item_id: claim.work_item.id, question: "ship it?" });
    expect(cp.task.status).toBe("input_required");

    expect((await tasksGet(client, cp.task.taskId)).status).toBe("input_required");
    await db.servicePool.query(
      "update checkpoints set status='answered', answer='ship it', answered_at=now() where id=$1", [cp.checkpoint_id]);
    expect((await tasksGet(client, cp.task.taskId)).status).toBe("completed");
    const result = await tasksResult(client, cp.task.taskId);
    expect(JSON.parse((result.content as any[])[0].text).answer).toBe("ship it");
  });

  it("work_complete enqueues a foreman.report_run job with completed state (GHA-5)", async () => {
    const { call } = await connect();
    await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "check-run item", acceptance: [] });
    const claim = await call("foreman__work_claim", {});
    expect(claim.status).toBe("assigned");
    await call("foreman__work_complete", {
      work_item_id: claim.work_item.id, summary: "built", acceptance_results: [], commit_sha: "sha-1",
    });
    const job = await db.servicePool.query(
      `select payload from sync_jobs where event_name='foreman.report_run'
       and payload->>'work_item_id' = $1 and payload->>'state' = 'completed'`, [claim.work_item.id]);
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].payload.head_sha).toBe("sha-1");
    expect(job.rows[0].payload.conclusion).toBe("success");
  });

  it("context_get serves published overview sections (§3.2 loop)", async () => {
    const { call } = await connect();
    await db.servicePool.query(
      `insert into overview_sections (project_id, organisation_id, section_id, version, content, sources, evidence_hash, generator)
       values ($1,$2,'shipped',1,'we shipped a rate limiter','[{"type":"work_item","ref":"x"}]','h','{"llm":"extractive"}')`,
      [projectId, orgId]);
    const ctx = await call("foreman__context_get", { sections: ["shipped"] });
    expect(ctx.sections).toEqual([{ section_id: "shipped", content: "we shipped a rate limiter", pinned: false }]);
    expect(ctx.counts).toBeDefined();
  });

  it("heartbeat drains undelivered directives oldest-first, exactly once (AVW-5)", async () => {
    const { call } = await connect();
    const hello = await call("foreman__agent_announce", { display_name: "directed", platform: "test", capabilities: [] });
    await db.servicePool.query(
      `insert into directives (organisation_id, project_id, agent_id, kind, payload, created_at)
       values ($1,$2,$3,'pause','{}', now() - interval '2 minutes'),
              ($1,$2,$3,'message','{"message":"wrap up"}', now() - interval '1 minute')`,
      [orgId, projectId, hello.agent_id]);
    const beat = await call("foreman__agent_heartbeat", { status: "working" });
    expect(beat.directives.map((d: any) => d.kind)).toEqual(["pause", "message"]);
    expect(beat.directives[1].payload).toEqual({ message: "wrap up" });
    const again = await call("foreman__agent_heartbeat", { status: "working" });
    expect(again.directives).toEqual([]);
    const rows = await db.servicePool.query(
      "select delivered_at from directives where agent_id=$1", [hello.agent_id]);
    expect(rows.rows.every((r: any) => r.delivered_at !== null)).toBe(true);
  });

  it("heartbeat from a stalled agent flips it to working and appends agent.resumed", async () => {
    const { call } = await connect();
    const hello = await call("foreman__agent_announce", { display_name: "stall-me", platform: "test", capabilities: [] });
    await db.servicePool.query("update agents set status='stalled' where id=$1", [hello.agent_id]);
    await call("foreman__agent_heartbeat", { status: "working" });
    const agent = await db.servicePool.query("select status from agents where id=$1", [hello.agent_id]);
    expect(agent.rows[0].status).toBe("working");
    const e = await db.servicePool.query(
      "select 1 from events where type='agent.resumed' and agent_id=$1", [hello.agent_id]);
    expect(e.rowCount).toBe(1);
  });
});
