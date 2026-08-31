import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import type pg from "pg";
import { assembleBrief, generateBrief } from "./brief.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let agentId: string;
let shippedId: string;
let blockedId: string;
let checkpointId: string;

const T0 = "2026-08-30T00:00:00.000Z";
const T1 = "2026-08-31T00:00:00.000Z";

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "brief"));
  agentId = (await db.servicePool.query(
    "insert into agents (organisation_id, project_id, display_name, platform, status) values ($1,$2,'briefly','test','stalled') returning id",
    [orgId, projectId])).rows[0].id;

  const item = async (title: string, status: string) => (await db.servicePool.query(
    "insert into work_items (organisation_id, project_id, title, status) values ($1,$2,$3,$4) returning id",
    [orgId, projectId, title, status])).rows[0].id;
  shippedId = await item("shipped thing", "done");
  await item("wip thing", "in_progress");
  blockedId = await item("stuck thing", "blocked");

  // shipped: work.completed inside the window; one outside
  await db.servicePool.query(
    `insert into events (organisation_id, project_id, work_item_id, type, payload, occurred_at, recorded_at)
     values ($1,$2,$3,'work.completed','{"summary":"done","acceptance_results":[]}','2026-08-30T12:00:00Z','2026-08-30T12:00:00Z')`,
    [orgId, projectId, shippedId]);
  await db.servicePool.query(
    `insert into events (organisation_id, project_id, work_item_id, type, payload, occurred_at, recorded_at)
     values ($1,$2,$3,'work.blocked','{"reason":"waiting on креds"}','2026-08-30T13:00:00Z','2026-08-30T13:00:00Z')`,
    [orgId, projectId, blockedId]);
  await db.servicePool.query(
    `insert into events (organisation_id, project_id, work_item_id, type, payload, occurred_at, recorded_at)
     values ($1,$2,$3,'work.lease_expired','{"agent_id":"${"00000000-0000-0000-0000-000000000000"}"}','2026-08-30T14:00:00Z','2026-08-30T14:00:00Z')`,
    [orgId, projectId, shippedId]);

  checkpointId = (await db.servicePool.query(
    `insert into checkpoints (organisation_id, project_id, work_item_id, agent_id, question)
     values ($1,$2,$3,$4,'which db?') returning id`, [orgId, projectId, blockedId, agentId])).rows[0].id;

  // cost: one run in window, one before
  await db.servicePool.query(
    `insert into runs (organisation_id, agent_id, cost_usd, started_at) values ($1,$2,1.5,'2026-08-30T10:00:00Z')`,
    [orgId, agentId]);
  await db.servicePool.query(
    `insert into runs (organisation_id, agent_id, cost_usd, started_at) values ($1,$2,0.25,'2026-08-29T10:00:00Z')`,
    [orgId, agentId]);

  await db.servicePool.query(
    `insert into proj_schedule (work_item_id, organisation_id, project_id, earliest_start, earliest_finish, latest_start, latest_finish, slack, critical)
     values ($1,$2,$3,0,6,0,6,0,true)`, [shippedId, orgId, projectId]);
  await db.servicePool.query(
    `insert into proj_project_health (project_id, organisation_id, has_dep_cycle) values ($1,$2,false)`,
    [projectId, orgId]);
});
afterAll(async () => { await db.teardown(); });

describe("assembleBrief (BRF-2/5/7)", () => {
  it("assembles every §6.3 section from the fixture", async () => {
    const b = await assembleBrief(db.servicePool, projectId, { start: T0, end: T1 });
    expect(b.shipped).toEqual([{ work_item_id: shippedId, title: "shipped thing", completed_at: "2026-08-30T12:00:00.000Z" }]);
    expect(b.in_flight.map((i) => i.title)).toEqual(["wip thing"]);
    expect(b.blocked.map((i) => [i.title, i.reason])).toEqual([["stuck thing", "waiting on креds"]]);
    expect(b.decisions.map((d) => d.checkpoint_id)).toEqual([checkpointId]);
    expect(b.cost).toEqual({ window_usd: "1.50", previous_window_usd: "0.25" });
    expect(b.forecast.horizon_days).toBe(6);
    expect(b.forecast.previous_horizon_days).toBeNull();
    expect(b.risks).toEqual({ stalled_agents: 1, expired_leases: 1, dep_cycle: false });
  });

  it("is byte-identical on re-assembly (BRF-7)", async () => {
    const a = await assembleBrief(db.servicePool, projectId, { start: T0, end: T1 });
    const b = await assembleBrief(db.servicePool, projectId, { start: T0, end: T1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("generateBrief stores the content, chains windows, and the stored row re-assembles byte-identically", async () => {
    const first = await generateBrief(db.servicePool as pg.Pool, projectId, new Date(T1));
    expect(first.window_start.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    const re = await assembleBrief(db.servicePool, projectId,
      { start: first.window_start.toISOString(), end: first.window_end.toISOString() });
    // jsonb normalizes key order, so the stored row is compared structurally;
    // the byte-identity guarantee is the assemble-vs-assemble test above.
    expect(re).toEqual(first.content);

    const e = await db.servicePool.query("select 1 from events where type='brief.generated'");
    expect(e.rowCount).toBe(1);

    const second = await generateBrief(db.servicePool as pg.Pool, projectId, new Date("2026-09-01T00:00:00Z"));
    expect(second.window_start.toISOString()).toBe(T1);
    expect(second.content.forecast.previous_horizon_days).toBe(6);
  });
});
