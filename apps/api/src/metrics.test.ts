import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { createApp } from "./http.js";

let db: TestDb;
let a: Awaited<ReturnType<typeof seedOrgWithUser>>;
let b: Awaited<ReturnType<typeof seedOrgWithUser>>;
let appPool: pg.Pool;
let url: string;
let cookie: string;
let cookieB: string;
let close: () => Promise<unknown>;

const NOW = "2026-08-31T12:00:00.000Z";
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3600_000).toISOString();

beforeAll(async () => {
  db = await createTestDatabase();
  a = await seedOrgWithUser(db.servicePool, "metrics");
  appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  const app = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "m", devAuth: true });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));
  const login = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "metrics@test.local" }),
  });
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const ev = (type: string, payload: object, at: string, agentId: string | null = null) =>
    db.servicePool.query(
      `insert into events (organisation_id, project_id, agent_id, type, payload, occurred_at, recorded_at)
       values ($1,$2,$3,$4,$5,$6,$6)`,
      [a.orgId, a.projectId, agentId, type, JSON.stringify(payload), at]);

  // throughput: 2 verdict completions + 1 bare this week; 1 verdict last week
  await ev("work.completed", { summary: "x", acceptance_results: [{ criterion: "c", met: true }] }, ago(24));
  await ev("work.completed", { summary: "y", acceptance_results: [{ criterion: "c", met: true }] }, ago(48));
  await ev("work.completed", { summary: "bare", acceptance_results: [] }, ago(30));
  await ev("work.completed", { summary: "old", acceptance_results: [{ criterion: "c", met: true }] }, ago(24 * 9));

  // stall detection: flagged 90s after last transition
  const agent = (await db.servicePool.query(
    "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'m-agent','test') returning id",
    [a.orgId, a.projectId])).rows[0].id;
  await ev("agent.stalled", { threshold_sec: 60, last_transition_at: ago(2.025) }, ago(2), agent); // 90s gap
  await ev("agent.heartbeat", { status: "working" }, ago(1), agent); // active in 24h

  // briefs: 1 generated + delivered in window
  await ev("brief.generated", { brief_id: "00000000-0000-0000-0000-000000000001", window_start: ago(48), window_end: ago(24) }, ago(24));
  await ev("brief.delivered", { brief_id: "00000000-0000-0000-0000-000000000001", channel: "webhook" }, ago(24));

  // open checkpoint
  const wi = (await db.servicePool.query(
    "insert into work_items (organisation_id, project_id, title) values ($1,$2,'m-item') returning id",
    [a.orgId, a.projectId])).rows[0].id;
  await db.servicePool.query(
    `insert into checkpoints (organisation_id, project_id, work_item_id, agent_id, question)
     values ($1,$2,$3,$4,'metrics q')`, [a.orgId, a.projectId, wi, agent]);

  // cost: 2.00 this week, 0.50 previous week
  await db.servicePool.query(
    "insert into runs (organisation_id, agent_id, cost_usd, started_at) values ($1,$2,2.00,$3)",
    [a.orgId, agent, ago(24)]);
  await db.servicePool.query(
    "insert into runs (organisation_id, agent_id, cost_usd, started_at) values ($1,$2,0.50,$3)",
    [a.orgId, agent, ago(24 * 9)]);

  // one lease expiry in window
  await ev("work.lease_expired", { agent_id: agent }, ago(3));

  // GitHub-connected project variant: merged-and-reviewed throughput.
  b = await seedOrgWithUser(db.servicePool, "metrics-gh");
  await db.servicePool.query("update projects set gh_installation_id = 987654 where id = $1", [b.projectId]);
  const loginB = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "metrics-gh@test.local" }),
  });
  cookieB = loginB.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const evB = (type: string, payload: object, at: string, workItemId: string | null = null) =>
    db.servicePool.query(
      `insert into events (organisation_id, project_id, work_item_id, type, payload, occurred_at, recorded_at)
       values ($1,$2,$3,$4,$5,$6,$6)`,
      [b.orgId, b.projectId, workItemId, type, JSON.stringify(payload), at]);

  const wiA = (await db.servicePool.query(
    "insert into work_items (organisation_id, project_id, title) values ($1,$2,'gh-item-a') returning id",
    [b.orgId, b.projectId])).rows[0].id;
  const wiB = (await db.servicePool.query(
    "insert into work_items (organisation_id, project_id, title) values ($1,$2,'gh-item-b') returning id",
    [b.orgId, b.projectId])).rows[0].id;

  // both completed this week with acceptance verdicts
  await evB("work.completed", { summary: "a", acceptance_results: [{ criterion: "c", met: true }] }, ago(20), wiA);
  await evB("work.completed", { summary: "b", acceptance_results: [{ criterion: "c", met: true }] }, ago(18), wiB);

  // item A: merged + approved review (same work item, both this week)
  await evB("github.pr_merged", { gh_repo: "o/r", pr_number: 1, pr_url: "https://gh.test/o/r/pull/1" }, ago(16), wiA);
  await evB("github.pr_reviewed", {
    gh_repo: "o/r", pr_number: 1, pr_url: "https://gh.test/o/r/pull/1",
    review_id: 1, reviewer: "octoreviewer", state: "approved",
  }, ago(15), wiA);

  // item B: merged only, no review
  await evB("github.pr_merged", { gh_repo: "o/r", pr_number: 2, pr_url: "https://gh.test/o/r/pull/2" }, ago(14), wiB);
});
afterAll(async () => { await close(); await appPool.end(); await db.teardown(); });

describe("activity series (12w x 7d, deterministic)", () => {
  let c: Awaited<ReturnType<typeof seedOrgWithUser>>;
  let d: Awaited<ReturnType<typeof seedOrgWithUser>>;
  let cookieC: string;
  let cookieD: string;

  beforeAll(async () => {
    c = await seedOrgWithUser(db.servicePool, "activity");
    d = await seedOrgWithUser(db.servicePool, "activity-gh");
    await db.servicePool.query("update projects set gh_installation_id = 111222 where id = $1", [d.projectId]);

    const loginC = await fetch(`${url}/auth/dev-login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "activity@test.local" }),
    });
    cookieC = loginC.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");
    const loginD = await fetch(`${url}/auth/dev-login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "activity-gh@test.local" }),
    });
    cookieD = loginD.headers.getSetCookie().map((v) => v.split(";")[0]).join("; ");

    // Window is [now-2016h, now); day 0 = the calendar day of now-2016h (oldest),
    // day 83 = the calendar day right before now's calendar day (newest).
    // hoursAgo -> day index: 2013h -> 0, 1053h -> 40, 21h -> 83.
    const evAt = (orgId: string, projectId: string, type: string, h: number) =>
      db.servicePool.query(
        `insert into events (organisation_id, project_id, type, payload, occurred_at, recorded_at)
         values ($1,$2,$3,'{}',$4,$4)`,
        [orgId, projectId, type, ago(h)]);

    for (const [type, orgId, projectId] of [
      ["work.completed", c.orgId, c.projectId],
      ["github.pr_merged", d.orgId, d.projectId],
    ] as const) {
      await evAt(orgId, projectId, type, 2013); // day 0
      await evAt(orgId, projectId, type, 2013);
      await evAt(orgId, projectId, type, 1053); // day 40
      await evAt(orgId, projectId, type, 21); // day 83
      await evAt(orgId, projectId, type, 21);
      await evAt(orgId, projectId, type, 21);
      await evAt(orgId, projectId, type, 2); // today (excluded: partial day)
      await evAt(orgId, projectId, type, 2040); // before window (excluded)
    }
    // noise: the other type of event shouldn't be counted for either project
    await evAt(c.orgId, c.projectId, "github.pr_merged", 1053);
    await evAt(d.orgId, d.projectId, "work.completed", 1053);
  });

  const expectedCells = () => {
    const cells = new Array(84).fill(0);
    cells[0] = 2; cells[40] = 1; cells[83] = 3;
    return cells;
  };

  it("counts work.completed per day for non-GitHub-connected projects", async () => {
    const res = await fetch(`${url}/api/projects/${c.projectId}/metrics/activity?now=${encodeURIComponent(NOW)}`,
      { headers: { cookie: cookieC } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ weeks: 12, cells: expectedCells(), source: "completed" });
  });

  it("counts github.pr_merged per day for GitHub-connected projects", async () => {
    const res = await fetch(`${url}/api/projects/${d.projectId}/metrics/activity?now=${encodeURIComponent(NOW)}`,
      { headers: { cookie: cookieD } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ weeks: 12, cells: expectedCells(), source: "merged" });
  });

  it("cross-org 404s", async () => {
    const res = await fetch(`${url}/api/projects/${d.projectId}/metrics/activity`, { headers: { cookie: cookieC } });
    expect(res.status).toBe(404);
  });
});

describe("metrics (PRD §1.7, deterministic)", () => {
  it("returns the exact golden object for the pinned now", async () => {
    const res = await fetch(`${url}/api/projects/${a.projectId}/metrics?now=${encodeURIComponent(NOW)}`,
      { headers: { cookie } });
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m).toEqual({
      supervised_throughput: {
        this_week: 2, last_week: 1, all_completions_this_week: 3,
        method: "completions with acceptance verdicts",
        merged_this_week: 0, reviewed_and_merged_this_week: 0,
      },
      stall_detection: { median_ms: 90000, p95_ms: 90000, samples: 1 },
      active_agents_24h: 1,
      open_decisions: 1,
      briefs_7d: { generated: 1, delivered: 1 },
      cost_7d: { usd: "2.00", previous_usd: "0.50" },
      lease_expiries_7d: 1,
    });
  });

  it("cross-org 404s", async () => {
    const other = await seedOrgWithUser(db.servicePool, "metrics-b");
    const res = await fetch(`${url}/api/projects/${other.projectId}/metrics`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("GitHub-connected project reports merged-and-reviewed throughput", async () => {
    const res = await fetch(`${url}/api/projects/${b.projectId}/metrics?now=${encodeURIComponent(NOW)}`,
      { headers: { cookie: cookieB } });
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m).toEqual({
      supervised_throughput: {
        this_week: 1, last_week: 0, all_completions_this_week: 2,
        method: "merged and reviewed",
        merged_this_week: 2, reviewed_and_merged_this_week: 1,
      },
      stall_detection: null,
      active_agents_24h: 0,
      open_decisions: 0,
      briefs_7d: { generated: 0, delivered: 0 },
      cost_7d: { usd: "0.00", previous_usd: "0.00" },
      lease_expiries_7d: 0,
    });
  });
});
