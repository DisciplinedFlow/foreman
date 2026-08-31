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

  it("PATCH schedule enqueues a foreman.schedule_write sync job (202)", async () => {
    const wi = (await db.servicePool.query(
      "select id from work_items where project_id=$1 limit 1", [a.projectId])).rows[0].id;
    const res = await fetch(`${url}/api/items/${wi}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ target_at: "2026-09-20" }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true });
    const job = await db.servicePool.query(
      "select payload, organisation_id from sync_jobs where event_name='foreman.schedule_write'");
    expect(job.rowCount).toBe(1);
    expect(job.rows[0].organisation_id).toBe(a.orgId);
    expect(job.rows[0].payload).toEqual({ work_item_id: wi, target_at: "2026-09-20" });
  });

  it("PATCH schedule on another org's item → 404, no job", async () => {
    const wi = (await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title) values ($1,$2,'b item') returning id`,
      [b.orgId, b.projectId])).rows[0].id;
    const res = await fetch(`${url}/api/items/${wi}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ target_at: "2026-09-20" }),
    });
    expect(res.status).toBe(404);
    const jobs = await db.servicePool.query(
      "select 1 from sync_jobs where event_name='foreman.schedule_write' and organisation_id=$1", [b.orgId]);
    expect(jobs.rowCount).toBe(0);
  });

  it("PATCH schedule with a malformed date → 400", async () => {
    const wi = (await db.servicePool.query(
      "select id from work_items where project_id=$1 limit 1", [a.projectId])).rows[0].id;
    const res = await fetch(`${url}/api/items/${wi}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ target_at: "soon" }),
    });
    expect(res.status).toBe(400);
  });

  it("checkpoints: open ones listed; answering flips + appends human.decided; twice → 409; other org → 404", async () => {
    const ag = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'cp-agent','test') returning id",
      [a.orgId, a.projectId])).rows[0].id;
    const wi = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title) values ($1,$2,'cp target') returning id",
      [a.orgId, a.projectId])).rows[0].id;
    const cp = (await db.servicePool.query(
      `insert into checkpoints (organisation_id, project_id, work_item_id, agent_id, question, options)
       values ($1,$2,$3,$4,'pick one','["x","y"]') returning id`, [a.orgId, a.projectId, wi, ag])).rows[0].id;

    const list = await (await get(`/api/projects/${a.projectId}/checkpoints`, cookieA)).json();
    expect(list.checkpoints.map((c: any) => c.id)).toContain(cp);
    expect(list.checkpoints.find((c: any) => c.id === cp).work_item_title).toBe("cp target");

    const answer = await fetch(`${url}/api/checkpoints/${cp}/answer`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ answer: "x" }),
    });
    expect(answer.status).toBe(200);
    const row = await db.servicePool.query("select status, answer, answered_by from checkpoints where id=$1", [cp]);
    expect(row.rows[0]).toMatchObject({ status: "answered", answer: "x", answered_by: a.userId });
    expect((await db.servicePool.query(
      "select 1 from events where type='human.decided' and payload->>'checkpoint_id'=$1", [cp])).rowCount).toBe(1);

    const again = await fetch(`${url}/api/checkpoints/${cp}/answer`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ answer: "y" }),
    });
    expect(again.status).toBe(409);

    const bAgent = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'b-agent','test') returning id",
      [b.orgId, b.projectId])).rows[0].id;
    const bWi = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title) values ($1,$2,'b wi') returning id",
      [b.orgId, b.projectId])).rows[0].id;
    const bCp = (await db.servicePool.query(
      `insert into checkpoints (organisation_id, project_id, work_item_id, agent_id, question)
       values ($1,$2,$3,$4,'b question') returning id`, [b.orgId, b.projectId, bWi, bAgent])).rows[0].id;
    const forbidden = await fetch(`${url}/api/checkpoints/${bCp}/answer`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ answer: "nope" }),
    });
    expect(forbidden.status).toBe(404);
  });

  it("directives: create pause (201 + row + human.directed); message without text → 400; other org → 404", async () => {
    const ag = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'dir-agent','test') returning id",
      [a.orgId, a.projectId])).rows[0].id;
    const res = await fetch(`${url}/api/agents/${ag}/directives`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ kind: "pause" }),
    });
    expect(res.status).toBe(201);
    const row = await db.servicePool.query("select kind, created_by, delivered_at from directives where agent_id=$1", [ag]);
    expect(row.rows[0]).toMatchObject({ kind: "pause", created_by: a.userId, delivered_at: null });
    const e = await db.servicePool.query(
      "select payload from events where type='human.directed' and payload->>'target'=$1", [ag]);
    expect(e.rowCount).toBe(1);
    expect(e.rows[0].payload.directive).toBe("pause");

    const bad = await fetch(`${url}/api/agents/${ag}/directives`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ kind: "message" }),
    });
    expect(bad.status).toBe(400);

    const bAg = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'b-dir','test') returning id",
      [b.orgId, b.projectId])).rows[0].id;
    const forbidden = await fetch(`${url}/api/agents/${bAg}/directives`, {
      method: "POST", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ kind: "pause" }),
    });
    expect(forbidden.status).toBe(404);
  });

  it("priority PATCH updates and appends work.reprioritised with from/to", async () => {
    const wi = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title, priority) values ($1,$2,'prio',100) returning id",
      [a.orgId, a.projectId])).rows[0].id;
    const res = await fetch(`${url}/api/items/${wi}/priority`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ priority: 5 }),
    });
    expect(res.status).toBe(200);
    expect((await db.servicePool.query("select priority from work_items where id=$1", [wi])).rows[0].priority).toBe(5);
    const e = await db.servicePool.query(
      "select payload from events where type='work.reprioritised' and work_item_id=$1", [wi]);
    expect(e.rows[0].payload).toEqual({ from: 100, to: 5 });
  });

  it("briefs are listed newest-first", async () => {
    await db.servicePool.query(
      `insert into briefs (organisation_id, project_id, window_start, window_end, content)
       values ($1,$2,'2026-08-30','2026-08-31','{"window":{}}')`, [a.orgId, a.projectId]);
    const res = await get(`/api/projects/${a.projectId}/briefs`, cookieA);
    const { briefs } = await res.json();
    expect(briefs.length).toBe(1);
    expect(briefs[0].content).toEqual({ window: {} });
  });

  it("comm-graph aggregates spawn events into weighted edges", async () => {
    const parent = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'parent','test') returning id",
      [a.orgId, a.projectId])).rows[0].id;
    const child = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform, parent_agent_id) values ($1,$2,'child','test',$3) returning id",
      [a.orgId, a.projectId, parent])).rows[0].id;
    for (let i = 0; i < 2; i++) {
      await db.servicePool.query(
        `insert into events (organisation_id, project_id, agent_id, type, payload, occurred_at)
         values ($1,$2,$3,'comm.subagent_spawned',$4,now())`,
        [a.orgId, a.projectId, parent, JSON.stringify({ parent_agent_id: parent, child_agent_id: child })]);
    }
    const res = await get(`/api/projects/${a.projectId}/comm-graph`, cookieA);
    const graph = await res.json();
    expect(graph.nodes.map((n: any) => n.id)).toContain(parent);
    const edge = graph.edges.find((e: any) => e.from === parent && e.to === child);
    expect(edge).toMatchObject({ kind: "spawn", count: 2 });
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
