import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { runOnce, type Projection, type EventRow } from "./runner.js";

let db: TestDb;
let orgId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId } = await seedOrgWithUser(db.servicePool, "runner"));
});
afterAll(async () => { await db.teardown(); });

async function seedEvents(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.servicePool.query(
      "insert into events (organisation_id, type, payload, occurred_at) values ($1,'agent.heartbeat','{}',now())", [orgId]);
  }
}

function recorder(name: string): { proj: Projection; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    proj: {
      name,
      handles: (t) => t === "agent.heartbeat",
      apply: async (_tx, events: EventRow[]) => { seen.push(...events.map((e) => e.id)); },
    },
  };
}

describe("projection runner", () => {
  it("advances the cursor: second runOnce sees only new events", async () => {
    const { proj, seen } = recorder("rec-a");
    await seedEvents(3);
    await runOnce(db.servicePool as any, [proj]);
    expect(seen.length).toBe(3);
    await runOnce(db.servicePool as any, [proj]);
    expect(seen.length).toBe(3);
    await seedEvents(2);
    await runOnce(db.servicePool as any, [proj]);
    expect(seen.length).toBe(5);
  });

  it("is replayable: cursor reset to 0 re-yields every event in order", async () => {
    const { proj, seen } = recorder("rec-a");
    await runOnce(db.servicePool as any, [proj]);
    const before = [...seen];
    seen.length = 0;
    await db.servicePool.query("update projection_cursors set last_event_id = 0 where name = 'rec-a'");
    await runOnce(db.servicePool as any, [proj]);
    expect(seen.length).toBeGreaterThanOrEqual(before.length + 5);
    expect(seen).toEqual([...seen].sort((a, b) => Number(a) - Number(b)));
  });

  it("a throwing projection leaves the cursor put and retries the same batch", async () => {
    let attempts = 0;
    const failing: Projection = {
      name: "rec-fail",
      handles: () => true,
      apply: async () => { attempts += 1; throw new Error("kaboom"); },
    };
    await expect(runOnce(db.servicePool as any, [failing])).rejects.toThrow("kaboom");
    const cur = await db.servicePool.query("select last_event_id from projection_cursors where name='rec-fail'");
    expect(Number(cur.rows[0].last_event_id)).toBe(0);
    await expect(runOnce(db.servicePool as any, [failing])).rejects.toThrow("kaboom");
    expect(attempts).toBe(2);
  });
});
