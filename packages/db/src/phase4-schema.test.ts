import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, type TestDb } from "./testing.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db.teardown(); });

describe("0005 tasks/briefs/checks schema", () => {
  it("has mcp_tasks and briefs plus the new columns", async () => {
    const t = await db.adminPool.query(
      `select table_name from information_schema.tables where table_schema='public'
       and table_name in ('mcp_tasks','briefs')`);
    expect(t.rowCount).toBe(2);
    const c = await db.adminPool.query(
      `select table_name, column_name from information_schema.columns
       where (table_name='work_items' and column_name='gh_check_run_id')
          or (table_name='organisations' and column_name='capture_tool_input')`);
    expect(c.rowCount).toBe(2);
  });

  it("mcp_tasks and briefs are RLS-protected", async () => {
    const r = await db.adminPool.query(
      `select relname from pg_class where relname in ('mcp_tasks','briefs') and relrowsecurity`);
    expect(r.rowCount).toBe(2);
  });
});
