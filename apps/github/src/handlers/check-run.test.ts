import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { handleSyncJob } from "./index.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let agentId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "checkrun"));
  agentId = (await db.servicePool.query(
    "insert into agents (organisation_id, project_id, display_name, platform) values ($1,$2,'a','test') returning id",
    [orgId, projectId])).rows[0].id;
});
afterAll(async () => { await db.teardown(); });

let seq = 0;
async function seedItem(status: string, checkRunId: number): Promise<string> {
  return (await db.servicePool.query(
    `insert into work_items (organisation_id, project_id, title, status, claimed_by, gh_check_run_id)
     values ($1,$2,'cr item',$3,$4,$5) returning id`,
    [orgId, projectId, status, status === "queued" ? null : agentId, checkRunId])).rows[0].id;
}

function job(identifier: string, checkRunId: number, deliveryId = `cr-${++seq}`): SyncJob {
  return {
    id: String(seq), organisation_id: orgId, installation_id: 777, delivery_id: deliveryId,
    event_name: "check_run", action: "requested_action", status: "running", attempts: 1,
    payload: {
      action: "requested_action",
      check_run: { id: checkRunId },
      requested_action: { identifier },
      installation: { id: 777 },
    },
  };
}

describe("check_run requested_action handler (GHA-5)", () => {
  it("retry requeues a claimed item and appends work.reassigned", async () => {
    const wi = await seedItem("claimed", 101);
    await handleSyncJob(db.servicePool, job("retry", 101));
    const row = await db.servicePool.query("select status, claimed_by from work_items where id=$1", [wi]);
    expect(row.rows[0]).toEqual({ status: "queued", claimed_by: null });
    const e = await db.servicePool.query(
      "select payload from events where type='work.reassigned' and work_item_id=$1", [wi]);
    expect(e.rows[0].payload.by).toBe("check_run:retry");
  });

  it("abort cancels an in_progress item", async () => {
    const wi = await seedItem("in_progress", 102);
    await handleSyncJob(db.servicePool, job("abort", 102));
    const row = await db.servicePool.query("select status from work_items where id=$1", [wi]);
    expect(row.rows[0].status).toBe("cancelled");
    expect((await db.servicePool.query(
      "select 1 from events where type='work.cancelled' and work_item_id=$1", [wi])).rowCount).toBe(1);
  });

  it("abort on a done item leaves it done (event still appended)", async () => {
    const wi = await seedItem("done", 103);
    await handleSyncJob(db.servicePool, job("abort", 103));
    const row = await db.servicePool.query("select status from work_items where id=$1", [wi]);
    expect(row.rows[0].status).toBe("done");
  });

  it("a duplicate delivery id does not double-append", async () => {
    const wi = await seedItem("claimed", 104);
    const j = job("reassign", 104);
    await handleSyncJob(db.servicePool, j);
    await handleSyncJob(db.servicePool, j);
    const e = await db.servicePool.query(
      "select count(*)::int as n from events where type='work.reassigned' and work_item_id=$1", [wi]);
    expect(e.rows[0].n).toBe(1);
  });
});
