import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import type pg from "pg";
import { createIngestApp } from "./http.js";
import { createAgentToken } from "./auth.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let token: string;
let url: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "ingest"));
  ({ token } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId }));
  const app = createIngestApp(db.servicePool as pg.Pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ingest/hook`;
  close = () => new Promise((r) => server.close(r));
});
afterAll(async () => { await close(); await db.teardown(); });

const sessionId = crypto.randomUUID();

const post = (body: object, bearer: string | null = token) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });

const hook = (name: string, extra: object = {}) => ({
  session_id: sessionId, transcript_path: "/tmp/t.json", cwd: "C:/work/my-repo",
  permission_mode: "default", hook_event_name: name, ...extra,
});

describe("ingest hook receiver (AGT-4)", () => {
  it("no or bad bearer → 401", async () => {
    expect((await post(hook("SessionStart"), null)).status).toBe(401);
    expect((await post(hook("SessionStart"), "fmn_agt_wrong")).status).toBe(401);
  });

  it("malformed JSON body -> JSON 500, not Express's HTML default (catch-all error middleware)", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{not json",
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("a thrown/rejected error inside the async handler -> JSON 500, never crashes the process", async () => {
    // Stand-in for a real DB error inside authenticate(): a pool whose query always rejects.
    const throwingPool = { query: () => Promise.reject(new Error("boom")) } as unknown as pg.Pool;
    const app = createIngestApp(throwingPool);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const throwUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/ingest/hook`;
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await fetch(throwUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer whatever" },
        body: JSON.stringify(hook("SessionStart")),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(await res.json()).toEqual({ error: "internal" });
      // give any stray unhandledRejection a tick to surface before asserting none did
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await new Promise((r) => server.close(r));
    }
  });

  it("SessionStart creates a telemetry agent, opens a run, appends agent.announced", async () => {
    const res = await post(hook("SessionStart"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const agent = await db.servicePool.query(
      "select id, integration_depth, platform, display_name, status from agents where organisation_id=$1", [orgId]);
    expect(agent.rowCount).toBe(1);
    expect(agent.rows[0]).toMatchObject({
      integration_depth: "telemetry", platform: "claude-code", display_name: "my-repo", status: "working",
    });
    const run = await db.servicePool.query(
      "select 1 from runs where external_session_id=$1 and ended_at is null", [sessionId]);
    expect(run.rowCount).toBe(1);
    expect((await db.servicePool.query(
      "select 1 from events where type='agent.announced' and agent_id=$1", [agent.rows[0].id])).rowCount).toBe(1);
  });

  it("PreToolUse drops tool_input by default (X-3) and keeps it when the org opts in", async () => {
    await post(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tu-1", tool_input: { command: "rm -rf /" } }));
    const e1 = await db.servicePool.query(
      "select payload from events where type='tool.invoked' and payload->>'tool_use_id'='tu-1'");
    expect(e1.rowCount).toBe(1);
    expect(e1.rows[0].payload.input).toBeUndefined();

    await db.servicePool.query("update organisations set capture_tool_input=true where id=$1", [orgId]);
    await post(hook("PreToolUse", { tool_name: "Bash", tool_use_id: "tu-2", tool_input: { command: "ls" } }));
    const e2 = await db.servicePool.query(
      "select payload from events where type='tool.invoked' and payload->>'tool_use_id'='tu-2'");
    expect(e2.rows[0].payload.input).toEqual({ command: "ls" });
    await db.servicePool.query("update organisations set capture_tool_input=false where id=$1", [orgId]);
  });

  it("PostToolUse appends tool.returned", async () => {
    await post(hook("PostToolUse", { tool_name: "Bash", tool_use_id: "tu-1" }));
    expect((await db.servicePool.query(
      "select 1 from events where type='tool.returned' and payload->>'tool_use_id'='tu-1'")).rowCount).toBe(1);
  });

  it("SubagentStart/Stop create the child agent and both comm events", async () => {
    await post(hook("SubagentStart", { agent_id: "sub-abc", agent_type: "Explore" }));
    const child = await db.servicePool.query(
      "select id, parent_agent_id, display_name from agents where display_name='Explore'");
    expect(child.rowCount).toBe(1);
    expect(child.rows[0].parent_agent_id).not.toBeNull();
    expect((await db.servicePool.query(
      "select 1 from events where type='comm.subagent_spawned'")).rowCount).toBe(1);

    await post(hook("SubagentStop", { agent_id: "sub-abc", agent_type: "Explore" }));
    expect((await db.servicePool.query(
      "select 1 from events where type='comm.subagent_returned'")).rowCount).toBe(1);
  });

  it("Stop closes the run and takes the agent offline", async () => {
    await post(hook("Stop"));
    const run = await db.servicePool.query(
      "select ended_at from runs where external_session_id=$1", [sessionId]);
    expect(run.rows[0].ended_at).not.toBeNull();
    const agent = await db.servicePool.query(
      "select status from agents where organisation_id=$1 and display_name='my-repo'", [orgId]);
    expect(agent.rows[0].status).toBe("offline");
    expect((await db.servicePool.query(
      "select 1 from events where type='agent.went_offline'")).rowCount).toBe(1);
  });

  it("Notification and unknown events ack 200 with no event; malformed payloads still 200 (observe-only)", async () => {
    const before = await db.servicePool.query("select count(*)::int as n from events where organisation_id=$1", [orgId]);
    expect((await post(hook("Notification", { message: "hi" }))).status).toBe(200);
    expect((await post(hook("SomeFutureEvent"))).status).toBe(200);
    expect((await post({ garbage: true })).status).toBe(200);
    const after = await db.servicePool.query("select count(*)::int as n from events where organisation_id=$1", [orgId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
