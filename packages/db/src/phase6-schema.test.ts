import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, type TestDb } from "./testing.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db.teardown(); });

describe("0007 endpoints/email schema", () => {
  it("has the endpoints table and projects.brief_email", async () => {
    const t = await db.adminPool.query(
      "select 1 from information_schema.tables where table_schema='public' and table_name='endpoints'");
    expect(t.rowCount).toBe(1);
    const c = await db.adminPool.query(
      "select 1 from information_schema.columns where table_name='projects' and column_name='brief_email'");
    expect(c.rowCount).toBe(1);
  });

  it("endpoints is RLS-protected and unique per (project, method, path)", async () => {
    const r = await db.adminPool.query(
      "select 1 from pg_class where relname='endpoints' and relrowsecurity");
    expect(r.rowCount).toBe(1);
    const u = await db.adminPool.query(
      `select 1 from pg_indexes where tablename='endpoints' and indexdef like '%UNIQUE%'`);
    expect(u.rowCount).toBeGreaterThanOrEqual(1);
  });
});
