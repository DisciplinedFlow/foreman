import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import { createTestDatabase, type TestDb } from "@foreman/db/testing";
import { appendEvent } from "@foreman/db";
import { createControlApp } from "./http.js";

const TOKEN = "control-test-token";

let db: TestDb;
let controlPool: pg.Pool;
let base: string;
let close: () => Promise<unknown>;

function withUser(connUrl: string, user: string): string {
  const u = new URL(connUrl);
  u.username = user;
  u.password = user;
  return u.toString();
}

beforeAll(async () => {
  db = await createTestDatabase();
  controlPool = new pg.Pool({ connectionString: withUser(db.url, "foreman_control"), max: 5 });
  const app = createControlApp({ pool: controlPool, token: TOKEN });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));
});
afterAll(async () => { await close(); await controlPool.end(); await db.teardown(); });

const call = (path: string, init: RequestInit = {}, bearer: string | null = TOKEN) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(bearer !== null ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });

describe("control-plane provisioning (WL-8/WL-9)", () => {
  it("no or wrong bearer -> 401", async () => {
    expect((await call("/tenants", { method: "POST", body: "{}" }, null)).status).toBe(401);
    expect((await call("/tenants", { method: "POST", body: "{}" }, "wrong-token")).status).toBe(401);
  });

  let orgId: string;
  let userId: string;

  it("POST /tenants provisions org + user + owner membership", async () => {
    const res = await call("/tenants", {
      method: "POST",
      body: JSON.stringify({ slug: "acme", tier: "team", owner_email: "owner@acme.test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    orgId = body.organisation_id;
    userId = body.user_id;
    expect(orgId).toBeTruthy();
    expect(userId).toBeTruthy();

    const org = await db.servicePool.query("select slug, tier from organisations where id = $1", [orgId]);
    expect(org.rows[0]).toMatchObject({ slug: "acme", tier: "team" });
    const member = await db.servicePool.query(
      "select role from organisation_members where organisation_id = $1 and user_id = $2", [orgId, userId]);
    expect(member.rows[0]?.role).toBe("owner");
  });

  it("repeat slug -> 409", async () => {
    const res = await call("/tenants", {
      method: "POST",
      body: JSON.stringify({ slug: "acme", tier: "team", owner_email: "someone-else@acme.test" }),
    });
    expect(res.status).toBe(409);
  });

  it("PATCH /tenants/:id updates tier and returns the fresh row", async () => {
    const res = await call(`/tenants/${orgId}`, { method: "PATCH", body: JSON.stringify({ tier: "business" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe("business");
  });

  it("PATCH unknown id -> 404", async () => {
    const res = await call(`/tenants/${crypto.randomUUID()}`, {
      method: "PATCH", body: JSON.stringify({ tier: "free" }),
    });
    expect(res.status).toBe(404);
  });

  it("PATCH malformed id -> 404 JSON, not a raw Postgres 22P02 crash", async () => {
    const res = await call("/tenants/not-a-uuid", { method: "PATCH", body: JSON.stringify({ tier: "free" }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("GET usage with a malformed id -> 404 JSON, not a raw Postgres 22P02 crash", async () => {
    const res = await call("/tenants/not-a-uuid/usage");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("metering run then usage GET returns the four metrics with exact counts", async () => {
    const agentId = crypto.randomUUID();
    // 2 events, 1 distinct agent, 1 completion; the owner membership from
    // provisioning above is the 1 seat.
    await appendEvent(db.servicePool, {
      organisation_id: orgId, agent_id: agentId, type: "agent.heartbeat",
      payload: { status: "working" },
    });
    await appendEvent(db.servicePool, {
      organisation_id: orgId, agent_id: agentId, type: "work.completed",
      payload: { summary: "shipped it", acceptance_results: [] },
    });

    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const meterRes = await call("/metering/run", {
      method: "POST", body: JSON.stringify({ period_start: from, period_end: to }),
    });
    expect(meterRes.status).toBe(200);
    const meterBody = await meterRes.json();
    expect(meterBody.records).toBeGreaterThan(0);

    const usageRes = await call(`/tenants/${orgId}/usage?from=${from.slice(0, 10)}&to=${to.slice(0, 10)}`);
    expect(usageRes.status).toBe(200);
    const usageBody = await usageRes.json();
    const byMetric = Object.fromEntries(usageBody.usage.map((r: { metric: string; value: string }) => [r.metric, Number(r.value)]));
    expect(byMetric).toEqual({
      events_ingested: 2,
      active_agents: 1,
      items_completed: 1,
      seats: 1,
    });
  });
});
