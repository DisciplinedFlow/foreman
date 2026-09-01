import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { claimSyncJob, completeSyncJob, reapStuckSyncJobs } from "./jobs.js";

let db: TestDb;
let orgId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId } = await seedOrgWithUser(db.servicePool, "jobs"));
});
afterAll(async () => { await db.teardown(); });

async function insertJob(overrides: Partial<{ status: string; attempts: number; locked_at: string | null }> = {}): Promise<string> {
  const res = await db.servicePool.query(
    `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload, status, attempts, locked_at)
     values ($1,0,$2,'issues','{}',$3,$4,$5) returning id`,
    [orgId, `job-${Date.now()}-${Math.random()}`, overrides.status ?? "queued", overrides.attempts ?? 0,
     overrides.locked_at ?? null]);
  return res.rows[0].id;
}

describe("claimSyncJob", () => {
  it("stamps locked_at on claim", async () => {
    await insertJob();
    const job = await claimSyncJob(db.servicePool);
    expect(job).not.toBeNull();
    const row = await db.servicePool.query("select locked_at from sync_jobs where id = $1", [job!.id]);
    expect(row.rows[0].locked_at).not.toBeNull();
  });
});

describe("completeSyncJob", () => {
  it("stores last_error and clears locked_at on final failure", async () => {
    const id = await insertJob({ status: "running", attempts: 5, locked_at: new Date().toISOString() });
    await completeSyncJob(db.servicePool, id, false, "boom: handler not wired");
    const row = await db.servicePool.query("select status, last_error, locked_at from sync_jobs where id = $1", [id]);
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].last_error).toBe("boom: handler not wired");
    expect(row.rows[0].locked_at).toBeNull();
  });

  it("clears last_error and locked_at on success", async () => {
    const id = await insertJob({ status: "running", attempts: 1, locked_at: new Date().toISOString() });
    await db.servicePool.query("update sync_jobs set last_error = 'stale' where id = $1", [id]);
    await completeSyncJob(db.servicePool, id, true);
    const row = await db.servicePool.query("select status, last_error, locked_at from sync_jobs where id = $1", [id]);
    expect(row.rows[0].status).toBe("done");
    expect(row.rows[0].last_error).toBeNull();
    expect(row.rows[0].locked_at).toBeNull();
  });
});

describe("reapStuckSyncJobs", () => {
  it("resets a stale running job back to queued and notes the reap", async () => {
    const staleId = await insertJob({
      status: "running", attempts: 2,
      locked_at: new Date(Date.now() - 300_000).toISOString(), // 5 minutes ago
    });
    const freshId = await insertJob({
      status: "running", attempts: 1,
      locked_at: new Date().toISOString(),
    });
    const n = await reapStuckSyncJobs(db.servicePool, 120);
    expect(n).toBe(1);

    const stale = await db.servicePool.query("select status, attempts, last_error, locked_at from sync_jobs where id = $1", [staleId]);
    expect(stale.rows[0].status).toBe("queued");
    expect(stale.rows[0].attempts).toBe(2); // attempts kept
    expect(stale.rows[0].last_error).toBe("reaped: stuck");
    expect(stale.rows[0].locked_at).toBeNull();

    const fresh = await db.servicePool.query("select status from sync_jobs where id = $1", [freshId]);
    expect(fresh.rows[0].status).toBe("running"); // untouched
  });

  it("returns 0 when nothing is stuck", async () => {
    const n = await reapStuckSyncJobs(db.servicePool, 120);
    expect(n).toBe(0);
  });
});
