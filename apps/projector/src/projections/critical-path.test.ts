import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { computeSchedule, criticalPathProjection } from "./critical-path.js";
import { runOnce } from "../runner.js";

describe("computeSchedule (golden)", () => {
  it("CPM over A(2d)→B(3d)→D(1d), A→C(1d)→D", () => {
    const { rows, cycle } = computeSchedule([
      { id: "A", start_at: "2026-09-01", target_at: "2026-09-03", deps: [] },
      { id: "B", start_at: "2026-09-03", target_at: "2026-09-06", deps: ["A"] },
      { id: "C", start_at: null, target_at: null, deps: ["A"] },
      { id: "D", start_at: "2026-09-08", target_at: "2026-09-09", deps: ["B", "C"] },
    ]);
    expect(cycle).toEqual([]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.A).toMatchObject({ earliest_start: 0, earliest_finish: 2, latest_start: 0, latest_finish: 2, slack: 0, critical: true });
    expect(by.B).toMatchObject({ earliest_start: 2, earliest_finish: 5, latest_start: 2, latest_finish: 5, slack: 0, critical: true });
    expect(by.C).toMatchObject({ earliest_start: 2, earliest_finish: 3, latest_start: 4, latest_finish: 5, slack: 2, critical: false });
    expect(by.D).toMatchObject({ earliest_start: 5, earliest_finish: 6, latest_start: 5, latest_finish: 6, slack: 0, critical: true });
  });

  it("a 2-node cycle returns its members and no schedule rows", () => {
    const { rows, cycle } = computeSchedule([
      { id: "X", start_at: null, target_at: null, deps: ["Y"] },
      { id: "Y", start_at: null, target_at: null, deps: ["X"] },
    ]);
    expect(rows).toEqual([]);
    expect(cycle.sort()).toEqual(["X", "Y"]);
  });
});

describe("criticalPathProjection (integration)", () => {
  let db: TestDb;
  let orgId: string;
  let projectId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "cpm"));
  });
  afterAll(async () => { await db.teardown(); });

  it("projects proj_schedule rows from events, and replays identically from 0", async () => {
    const ins = async (title: string, start: string | null, target: string | null) =>
      (await db.servicePool.query(
        `insert into work_items (organisation_id, project_id, title, start_at, target_at)
         values ($1,$2,$3,$4,$5) returning id`, [orgId, projectId, title, start, target])).rows[0].id;
    const a = await ins("A", "2026-09-01", "2026-09-03");
    const b = await ins("B", "2026-09-03", "2026-09-06");
    const d = await ins("D", "2026-09-08", "2026-09-09");
    await db.servicePool.query(
      "insert into work_item_deps (organisation_id, blocked_id, blocker_id) values ($1,$2,$3),($1,$4,$5)",
      [orgId, b, a, d, b]);
    await db.servicePool.query(
      "insert into events (organisation_id, project_id, work_item_id, type, payload, occurred_at) values ($1,$2,$3,'work.created','{}',now())",
      [orgId, projectId, a]);

    await runOnce(db.servicePool as any, [criticalPathProjection]);
    const rows = await db.servicePool.query(
      "select work_item_id, earliest_start, earliest_finish, slack, critical from proj_schedule where project_id=$1 order by earliest_start", [projectId]);
    expect(rows.rowCount).toBe(3);
    expect(rows.rows.every((r: any) => r.critical)).toBe(true);
    const health = await db.servicePool.query(
      "select has_dep_cycle from proj_project_health where project_id=$1", [projectId]);
    expect(health.rows[0].has_dep_cycle).toBe(false);

    const snapshot = JSON.stringify(rows.rows);
    await db.servicePool.query("update projection_cursors set last_event_id = 0 where name = $1",
      [criticalPathProjection.name]);
    await runOnce(db.servicePool as any, [criticalPathProjection]);
    const again = await db.servicePool.query(
      "select work_item_id, earliest_start, earliest_finish, slack, critical from proj_schedule where project_id=$1 order by earliest_start", [projectId]);
    expect(JSON.stringify(again.rows)).toBe(snapshot);
  });
});
