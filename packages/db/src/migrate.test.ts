import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./testing.js";

describe("migrations", () => {
  it("applies cleanly and is idempotent on re-run", async () => {
    const db = await createTestDatabase();
    try {
      const t = await db.adminPool.query("select count(*)::int as n from schema_migrations");
      expect(t.rows[0].n).toBeGreaterThanOrEqual(2);
      // re-running migrate must apply nothing — createTestDatabase already ran it;
      // covered by rerunMigrations helper returning []
      expect(await db.rerunMigrations()).toEqual([]);
    } finally { await db.teardown(); }
  });
});
