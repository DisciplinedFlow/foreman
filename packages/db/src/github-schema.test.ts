import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "./testing.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db.teardown(); });

describe("0004 github sync schema", () => {
  it("has the new tables and work_items.gh_issue_id", async () => {
    const t = await db.adminPool.query(
      `select table_name from information_schema.tables where table_schema='public'
       and table_name in ('github_apps','github_installations','github_deliveries','sync_jobs','projection_cursors','proj_schedule','proj_project_health')`);
    expect(t.rowCount).toBe(7);
    const c = await db.adminPool.query(
      `select 1 from information_schema.columns where table_name='work_items' and column_name='gh_issue_id'`);
    expect(c.rowCount).toBe(1);
  });

  it("notifies foreman_events on event insert", async () => {
    const { orgId } = await seedOrgWithUser(db.adminPool, "notify-test");
    const client = await db.adminPool.connect();
    try {
      const got = new Promise<string>((res) => client.on("notification", (m) => res(m.channel)));
      await client.query("listen foreman_events");
      await db.adminPool.query(
        `insert into events (organisation_id, type, payload, occurred_at) values ($1,'agent.heartbeat','{}',now())`, [orgId]);
      expect(await got).toBe("foreman_events");
    } finally { client.release(); }
  });

  it("denies foreman_app access to github_apps (credential table)", async () => {
    const pg = (await import("pg")).default;
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    await expect(app.query("select * from github_apps")).rejects.toThrow(/permission denied/);
    await app.end();
  });
});
