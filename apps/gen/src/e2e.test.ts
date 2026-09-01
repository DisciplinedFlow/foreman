import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { enqueueWorkItem } from "@foreman/db";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp as createApiApp } from "foreman-api/lib";
import { createApp as createMcpApp, createAgentToken } from "foreman-mcp/lib";
import { generateBrief } from "./brief.js";
import { deliverBrief } from "./deliver.js";
import { briefDue } from "./schedule.js";
import { regenerateOverview } from "./overview.js";
import { ExtractiveLlm } from "./llm.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let apiUrl: string;
let cookie: string;
let csrf: string;
let mcpCall: (name: string, args: Record<string, unknown>) => Promise<any>;
let mcpClient: Client;
const webhookHits: any[] = [];
const closers: Array<() => Promise<unknown>> = [];

async function listen(app: { listen(port: number): any }): Promise<string> {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  closers.push(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "phase5"));

  // recording webhook target
  const hookApp = express();
  hookApp.use(express.json());
  hookApp.post("/brief", (req, res) => { webhookHits.push(req.body); res.json({}); });
  const hookUrl = await listen(hookApp);
  await db.servicePool.query(
    "update projects set brief_schedule='daily', brief_timezone='Europe/Amsterdam', brief_webhook_url=$2 where id=$1",
    [projectId, `${hookUrl}/brief`]);

  const appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  closers.push(() => appPool.end());
  apiUrl = await listen(createApiApp({
    appPool, servicePool: db.servicePool as pg.Pool, secret: "p5", devAuth: true }));
  const login = await fetch(`${apiUrl}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "phase5@test.local" }),
  });
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  csrf = (await login.json()).csrf_token;

  const mcpUrl = await listen(createMcpApp(db.servicePool as pg.Pool));
  const { token } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId });
  mcpClient = new Client({ name: "phase5-agent", version: "0.0.1" });
  await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  mcpCall = async (name, args) => {
    const r = await mcpClient.callTool({ name, arguments: args });
    expect(r.isError ?? false).toBe(false);
    return JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
  };
});
afterAll(async () => { for (const c of closers.reverse()) await c(); await db.teardown(); });

describe("phase 5 loop: direct the fleet, understand the project, briefs arrive", () => {
  it("directive round-trip: api pause → heartbeat drains it", async () => {
    const hello = await mcpCall("foreman__agent_announce",
      { display_name: "phase5-agent", platform: "test", capabilities: [] });
    const res = await fetch(`${apiUrl}/api/agents/${hello.agent_id}/directives`, {
      method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ kind: "pause" }),
    });
    expect(res.status).toBe(201);
    const beat = await mcpCall("foreman__agent_heartbeat", { status: "working" });
    expect(beat.directives.map((d: any) => d.kind)).toEqual(["pause"]);
    const row = await db.servicePool.query(
      "select delivered_at from directives where agent_id=$1", [hello.agent_id]);
    expect(row.rows[0].delivered_at).not.toBeNull();
  });

  it("complete → overview regenerates; pinned human edit survives; context_get closes the loop", async () => {
    await enqueueWorkItem(db.servicePool, {
      organisationId: orgId, projectId, title: "phase5 feature", acceptance: [] });
    const claim = await mcpCall("foreman__work_claim", {});
    expect(claim.status).toBe("assigned");
    await mcpCall("foreman__work_complete", {
      work_item_id: claim.work_item.id, summary: "shipped it", acceptance_results: [] });

    const llm = new ExtractiveLlm();
    const r = await regenerateOverview(db.servicePool as pg.Pool, projectId, { llm, causedBy: "manual" });
    expect(r.regenerated).toContain("shipped");
    const section = await db.servicePool.query(
      "select sources from overview_sections where project_id=$1 and section_id='shipped'", [projectId]);
    expect(section.rows[0].sources.some((s: any) => s.ref === claim.work_item.id)).toBe(true);

    // human edit + pin via the api, then churn + regenerate twice → intact
    const put = await fetch(`${apiUrl}/api/projects/${projectId}/overview/shipped`, {
      method: "PUT", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
      body: JSON.stringify({ content: "OUR VERSION", pinned: true }),
    });
    expect(put.status).toBe(200);
    for (let i = 0; i < 2; i++) {
      await enqueueWorkItem(db.servicePool, {
        organisationId: orgId, projectId, title: `churn ${i}`, acceptance: [] });
      const c = await mcpCall("foreman__work_claim", {});
      await mcpCall("foreman__work_complete", {
        work_item_id: c.work_item.id, summary: "x", acceptance_results: [] });
      await regenerateOverview(db.servicePool as pg.Pool, projectId, { llm });
    }
    const after = await db.servicePool.query(
      "select content, pinned from overview_sections where project_id=$1 and section_id='shipped'", [projectId]);
    expect(after.rows[0]).toEqual({ content: "OUR VERSION", pinned: true });

    const ctx = await mcpCall("foreman__context_get", { sections: ["shipped"] });
    expect(ctx.sections[0].content).toBe("OUR VERSION");
  });

  it("scheduled brief fires in local time and arrives at the webhook", async () => {
    // Window end must land after the real occurred_at of the work.completed
    // events written earlier in this suite (those use the db's now(), not a
    // mock clock) — so it is derived from wall-clock time, not hardcoded, or
    // this test time-bombs once the real clock catches up to a fixed date.
    // Noon UTC is always >=07:00 local in Europe/Amsterdam (CET or CEST), and
    // "+24h" guarantees a calendar day strictly after every event above.
    const windowEnd = new Date(Date.now() + 24 * 60 * 60 * 1000);
    windowEnd.setUTCHours(12, 0, 0, 0);
    expect(briefDue("daily", "Europe/Amsterdam", null, windowEnd)).toBe(true);
    const brief = await generateBrief(db.servicePool as pg.Pool, projectId, windowEnd);
    const channels = await deliverBrief(db.servicePool as pg.Pool, brief, {});
    expect(channels).toEqual(["webhook"]);
    expect(webhookHits.length).toBe(1);
    expect(webhookHits[0].brief_id).toBe(brief.id);
    expect(webhookHits[0].content.shipped.length).toBeGreaterThanOrEqual(3);
    expect((await db.servicePool.query(
      "select 1 from events where type='brief.delivered' and payload->>'brief_id'=$1", [brief.id])).rowCount).toBe(1);
    // and it is not due again the same local day
    const sameLocalDayLater = new Date(windowEnd.getTime() + 4 * 60 * 60 * 1000);
    expect(briefDue("daily", "Europe/Amsterdam", brief.window_end, sameLocalDayLater)).toBe(false);
  });
});
