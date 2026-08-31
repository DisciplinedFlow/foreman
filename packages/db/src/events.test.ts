import { describe, expect, it } from "vitest";
import { createTestDatabase, seedOrgWithUser } from "./testing.js";
import { appendEvent } from "./events.js";

describe("appendEvent", () => {
  it("writes a validated event and dedupes on idempotency key", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId } = await seedOrgWithUser(db.servicePool, "org-e");
      const evt = { organisation_id: orgId, type: "agent.resumed" as const, payload: {}, idempotency_key: "k1" };
      const first = await appendEvent(db.servicePool, evt);
      expect(first.deduped).toBe(false);
      const second = await appendEvent(db.servicePool, evt);
      expect(second.deduped).toBe(true);
      const n = await db.servicePool.query("select count(*)::int as n from events");
      expect(n.rows[0].n).toBe(1);
    } finally { await db.teardown(); }
  });
  it("rejects invalid payloads", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId } = await seedOrgWithUser(db.servicePool, "org-f");
      await expect(appendEvent(db.servicePool, {
        organisation_id: orgId, type: "work.progressed", payload: { bogus: true },
      } as never)).rejects.toThrow(/note/);
    } finally { await db.teardown(); }
  });
});
