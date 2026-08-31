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

let csrfA: string;

async function login(email: string): Promise<string> {
  const res = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  csrfA = (await res.json()).csrf_token;
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

// WL-5: every mutation needs the double-submit pair.
const mut = () => ({ cookie: cookieA, "x-csrf-token": csrfA });

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
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
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
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
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
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
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
      method: "POST", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ answer: "x" }),
    });
    expect(answer.status).toBe(200);
    const row = await db.servicePool.query("select status, answer, answered_by from checkpoints where id=$1", [cp]);
    expect(row.rows[0]).toMatchObject({ status: "answered", answer: "x", answered_by: a.userId });
    expect((await db.servicePool.query(
      "select 1 from events where type='human.decided' and payload->>'checkpoint_id'=$1", [cp])).rowCount).toBe(1);

    const again = await fetch(`${url}/api/checkpoints/${cp}/answer`, {
      method: "POST", headers: { "content-type": "application/json", ...mut() },
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
      method: "POST", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ answer: "nope" }),
    });
    expect(forbidden.status).toBe(404);
  });

  it("directives: create pause (201 + row + human.directed); message without text → 400; other org → 404", async () => {
    const ag = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'dir-agent','test') returning id",
      [a.orgId, a.projectId])).rows[0].id;
    const res = await fetch(`${url}/api/agents/${ag}/directives`, {
      method: "POST", headers: { "content-type": "application/json", ...mut() },
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
      method: "POST", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ kind: "message" }),
    });
    expect(bad.status).toBe(400);

    const bAg = (await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'b-dir','test') returning id",
      [b.orgId, b.projectId])).rows[0].id;
    const forbidden = await fetch(`${url}/api/agents/${bAg}/directives`, {
      method: "POST", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ kind: "pause" }),
    });
    expect(forbidden.status).toBe(404);
  });

  it("priority PATCH updates and appends work.reprioritised with from/to", async () => {
    const wi = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title, priority) values ($1,$2,'prio',100) returning id",
      [a.orgId, a.projectId])).rows[0].id;
    const res = await fetch(`${url}/api/items/${wi}/priority`, {
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ priority: 5 }),
    });
    expect(res.status).toBe(200);
    expect((await db.servicePool.query("select priority from work_items where id=$1", [wi])).rows[0].priority).toBe(5);
    const e = await db.servicePool.query(
      "select payload from events where type='work.reprioritised' and work_item_id=$1", [wi]);
    expect(e.rows[0].payload).toEqual({ from: 100, to: 5 });
  });

  it("briefs are listed newest-first with delivery status (BRF-6)", async () => {
    const briefId = (await db.servicePool.query(
      `insert into briefs (organisation_id, project_id, window_start, window_end, content)
       values ($1,$2,'2026-08-30','2026-08-31','{"window":{}}') returning id`, [a.orgId, a.projectId])).rows[0].id;
    await db.servicePool.query(
      `insert into events (organisation_id, project_id, type, payload, occurred_at)
       values ($1,$2,'brief.delivered',$3,now())`,
      [a.orgId, a.projectId, JSON.stringify({ brief_id: briefId, channel: "webhook" })]);
    const res = await get(`/api/projects/${a.projectId}/briefs`, cookieA);
    const { briefs } = await res.json();
    expect(briefs.length).toBe(1);
    expect(briefs[0].content).toEqual({ window: {} });
    expect(briefs[0].delivered).toEqual(["webhook"]);
  });

  it("overview: regenerate → list → human override bumps version and pins", async () => {
    await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title, status) values ($1,$2,'ov item','in_progress')",
      [a.orgId, a.projectId]);
    const regen = await fetch(`${url}/api/projects/${a.projectId}/overview/regenerate`, {
      method: "POST", headers: mut() });
    expect(regen.status).toBe(200);
    const { regenerated } = await regen.json();
    expect(regenerated).toContain("in_flight");

    const list = await (await get(`/api/projects/${a.projectId}/overview`, cookieA)).json();
    const inFlight = list.sections.find((s: any) => s.section_id === "in_flight");
    expect(inFlight.version).toBe(1);
    expect(inFlight.sources.length).toBeGreaterThan(0);

    const put = await fetch(`${url}/api/projects/${a.projectId}/overview/in_flight`, {
      method: "PUT", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ content: "our edit", pinned: true }),
    });
    expect(put.status).toBe(200);
    const after = await (await get(`/api/projects/${a.projectId}/overview`, cookieA)).json();
    const edited = after.sections.find((s: any) => s.section_id === "in_flight");
    expect(edited).toMatchObject({ content: "our edit", pinned: true, human_authored: true, version: 2 });
    expect((await db.servicePool.query(
      "select 1 from events where type='human.overrode' and payload->>'subject'='overview:in_flight'")).rowCount).toBe(1);

    const bad = await fetch(`${url}/api/projects/${a.projectId}/overview/nonsense`, {
      method: "PUT", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ pinned: true }),
    });
    expect(bad.status).toBe(400);

    // OVW-2: the revision trail carries both the generated and the human version
    const revs = await (await get(`/api/projects/${a.projectId}/overview/in_flight/revisions`, cookieA)).json();
    expect(revs.revisions.length).toBeGreaterThanOrEqual(2);
    expect(revs.revisions[0].content).toBe("our edit");
    expect(revs.revisions[0].caused_by).toBe("human");
  });

  it("settings PATCH round-trips every field, validates, and appends project.updated", async () => {
    await db.servicePool.query(
      "insert into github_apps (app_id, slug, private_key_pem, webhook_secret) values (11,'set','pem','whs') on conflict do nothing");
    await db.servicePool.query(
      "insert into github_installations (installation_id, app_id, organisation_id, account_login) values (1111,11,$1,'acme') on conflict do nothing",
      [a.orgId]);

    const inst = await (await get(`/api/orgs/${a.orgId}/installations`, cookieA)).json();
    expect(inst.installations.map((i: any) => Number(i.installation_id))).toContain(1111);

    const res = await fetch(`${url}/api/projects/${a.projectId}/settings`, {
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({
        gh_repos: ["acme/app"], gh_installation_id: 1111, gh_project_node_id: "PVT_set",
        wip_limit: 25, stall_threshold_sec: 300,
        brief_schedule: "daily", brief_timezone: "Europe/Amsterdam",
        brief_webhook_url: "https://hooks.test/x", brief_email: "pm@acme.test",
      }),
    });
    expect(res.status).toBe(200);
    const { project } = await res.json();
    expect(project).toMatchObject({
      gh_repos: ["acme/app"], gh_project_node_id: "PVT_set", wip_limit: 25,
      stall_threshold_sec: 300, brief_schedule: "daily", brief_timezone: "Europe/Amsterdam",
      brief_webhook_url: "https://hooks.test/x", brief_email: "pm@acme.test",
    });
    const e = await db.servicePool.query(
      "select payload from events where type='project.updated' and project_id=$1", [a.projectId]);
    expect(e.rows[0].payload.fields).toContain("brief_timezone");

    const badTz = await fetch(`${url}/api/projects/${a.projectId}/settings`, {
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ brief_timezone: "Mars/Olympus" }),
    });
    expect(badTz.status).toBe(400);

    const foreignInst = await fetch(`${url}/api/projects/${a.projectId}/settings`, {
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ gh_installation_id: 999999 }),
    });
    expect(foreignInst.status).toBe(400);

    const crossOrg = await fetch(`${url}/api/projects/${b.projectId}/settings`, {
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ wip_limit: 5 }),
    });
    expect(crossOrg.status).toBe(404);
  });

  it("lifecycle read computes gaps; scan POST enqueues; cross-org 404s (LFC-4)", async () => {
    const ep = async (method: string, path: string, over: object) => db.servicePool.query(
      `insert into endpoints (organisation_id, project_id, gh_repo, method, path, state, evidence, in_spec, has_impl, has_test)
       values ($1,$2,'o/r',$3,$4,$5,$6,$7,$8,$9)`,
      [a.orgId, a.projectId, method, path,
        (over as any).state ?? "implemented", "[]",
        (over as any).in_spec ?? false, (over as any).has_impl ?? true, (over as any).has_test ?? false]);
    await ep("GET", "/lc/a", { has_test: false });                       // untested + unspecced
    await ep("POST", "/lc/b", { in_spec: true, has_impl: false, state: "planned" }); // unimplemented
    await ep("PUT", "/lc/c", { in_spec: true, has_test: true, state: "tested" });    // clean

    const res = await (await get(`/api/projects/${a.projectId}/lifecycle`, cookieA)).json();
    expect(res.endpoints.length).toBe(3);
    expect(res.gaps).toEqual({ untested: 1, unimplemented: 1, unspecced: 1 });

    const scan = await fetch(`${url}/api/projects/${a.projectId}/lifecycle/scan`, { method: "POST", headers: mut() });
    expect(scan.status).toBe(202);
    expect((await db.servicePool.query(
      "select 1 from sync_jobs where event_name='foreman.lifecycle_scan'")).rowCount).toBe(1);

    const forbidden = await fetch(`${url}/api/projects/${b.projectId}/lifecycle/scan`, { method: "POST", headers: mut() });
    expect(forbidden.status).toBe(404);
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
