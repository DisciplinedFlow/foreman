import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { createApp } from "./http.js";

let db: TestDb;
let appPool: pg.Pool;
let a: Awaited<ReturnType<typeof seedOrgWithUser>>;
let b: Awaited<ReturnType<typeof seedOrgWithUser>>;
let url: string;
let close: () => Promise<unknown>;
let cookieA: string;

async function login(email: string): Promise<string> {
  const res = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const get = (path: string, cookie?: string) =>
  fetch(`${url}${path}`, { headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  db = await createTestDatabase();
  a = await seedOrgWithUser(db.servicePool, "api-a");
  b = await seedOrgWithUser(db.servicePool, "api-b");
  appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  const app = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "test-secret", devAuth: true });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));
  cookieA = await login("api-a@test.local");
});
afterAll(async () => { await close(); await appPool.end(); await db.teardown(); });

describe("api routes", () => {
  it("dev-login: unknown email → 404", async () => {
    const res = await fetch(`${url}/auth/dev-login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@test.local" }),
    });
    expect(res.status).toBe(404);
  });

  it("no cookie → 401", async () => {
    expect((await get("/api/orgs")).status).toBe(401);
  });

  it("orgs are RLS-scoped to the logged-in user", async () => {
    const res = await get("/api/orgs", cookieA);
    expect(res.status).toBe(200);
    const { orgs } = await res.json();
    expect(orgs.map((o: any) => o.id)).toEqual([a.orgId]);
  });

  it("another org's project → 404", async () => {
    expect((await get(`/api/projects/${b.projectId}`, cookieA)).status).toBe(404);
  });

  it("project detail carries health (null when no projection yet)", async () => {
    const res = await get(`/api/projects/${a.projectId}`, cookieA);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.project.id).toBe(a.projectId);
    expect(body.health).toBeNull();
  });

  it("items returns work items and deps", async () => {
    const w = async (title: string) => (await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title, start_at, target_at)
       values ($1,$2,$3,'2026-09-01','2026-09-03') returning id`, [a.orgId, a.projectId, title])).rows[0].id;
    const w1 = await w("one"); const w2 = await w("two");
    await db.servicePool.query(
      "insert into work_item_deps (organisation_id, blocked_id, blocker_id) values ($1,$2,$3)", [a.orgId, w2, w1]);
    const res = await get(`/api/projects/${a.projectId}/items`, cookieA);
    const body = await res.json();
    expect(body.items.map((i: any) => i.title).sort()).toEqual(["one", "two"]);
    expect(body.deps).toEqual([{ blocked_id: w2, blocker_id: w1 }]);
  });

  it("agents joins claimed item and latest run", async () => {
    const ag = (await db.servicePool.query(
      `insert into agents (organisation_id, project_id, display_name, platform, model, status)
       values ($1,$2,'worker-1','claude-code','claude-fable-5','working') returning id`,
      [a.orgId, a.projectId])).rows[0].id;
    const wi = (await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title, status, claimed_by)
       values ($1,$2,'claimed item','claimed',$3) returning id`, [a.orgId, a.projectId, ag])).rows[0].id;
    await db.servicePool.query(
      `insert into runs (organisation_id, agent_id, work_item_id, external_session_id, tokens_in, tokens_out, cost_usd)
       values ($1,$2,$3,'sess-1',1000,500,0.1234)`, [a.orgId, ag, wi]);
    const res = await get(`/api/projects/${a.projectId}/agents`, cookieA);
    const { agents } = await res.json();
    expect(agents.length).toBe(1);
    expect(agents[0]).toMatchObject({
      display_name: "worker-1", platform: "claude-code", status: "working",
      work_item_title: "claimed item", external_session_id: "sess-1",
    });
    expect(Number(agents[0].cost_usd)).toBeCloseTo(0.1234);
  });

  it("schedule returns proj_schedule rows", async () => {
    const wi = (await db.servicePool.query(
      "select id from work_items where project_id=$1 limit 1", [a.projectId])).rows[0].id;
    await db.servicePool.query(
      `insert into proj_schedule (work_item_id, organisation_id, project_id, earliest_start, earliest_finish, latest_start, latest_finish, slack, critical)
       values ($1,$2,$3,0,2,0,2,0,true)`, [wi, a.orgId, a.projectId]);
    const res = await get(`/api/projects/${a.projectId}/schedule`, cookieA);
    const { schedule } = await res.json();
    expect(schedule.length).toBe(1);
    expect(schedule[0]).toMatchObject({ work_item_id: wi, critical: true, slack: 0 });
  });
});
