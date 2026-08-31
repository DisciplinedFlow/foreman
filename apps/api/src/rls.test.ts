import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { withUser } from "./rls.js";

let db: TestDb;
let appPool: pg.Pool;
let a: Awaited<ReturnType<typeof seedOrgWithUser>>;
let b: Awaited<ReturnType<typeof seedOrgWithUser>>;

beforeAll(async () => {
  db = await createTestDatabase();
  a = await seedOrgWithUser(db.servicePool, "rls-a");
  b = await seedOrgWithUser(db.servicePool, "rls-b");
  appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
});
afterAll(async () => { await appPool.end(); await db.teardown(); });

describe("withUser RLS scoping", () => {
  it("user A sees org A's projects and not org B's", async () => {
    const rows = await withUser(appPool, a.userId, async (tx) =>
      (await tx.query("select id from projects")).rows.map((r: any) => r.id));
    expect(rows).toContain(a.projectId);
    expect(rows).not.toContain(b.projectId);
  });
  it("the GUC does not leak across withUser calls on the same pool", async () => {
    await withUser(appPool, a.userId, async () => {});
    const rows = await withUser(appPool, b.userId, async (tx) =>
      (await tx.query("select id from projects")).rows.map((r: any) => r.id));
    expect(rows).toEqual([b.projectId]);
  });
});
