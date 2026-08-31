import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, type TestDb } from "./testing.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db.teardown(); });

describe("0006 directives/overview/delivery schema", () => {
  it("has the new tables and project columns", async () => {
    const t = await db.adminPool.query(
      `select table_name from information_schema.tables where table_schema='public'
       and table_name in ('directives','overview_sections','overview_revisions')`);
    expect(t.rowCount).toBe(3);
    const c = await db.adminPool.query(
      `select column_name from information_schema.columns where table_name='projects'
       and column_name in ('brief_schedule','brief_timezone','brief_webhook_url')`);
    expect(c.rowCount).toBe(3);
  });

  it("new tenant tables are RLS-protected", async () => {
    const r = await db.adminPool.query(
      `select relname from pg_class where relname in ('directives','overview_sections','overview_revisions') and relrowsecurity`);
    expect(r.rowCount).toBe(3);
  });
});
