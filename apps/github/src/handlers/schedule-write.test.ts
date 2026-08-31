import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { handleSyncJob } from "./index.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "schedwrite"));
});
afterAll(async () => { await db.teardown(); });

describe("foreman.schedule_write handler", () => {
  it("routes to backbone.updateSchedule with the payload dates", async () => {
    const wi = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title) values ($1,$2,'x') returning id",
      [orgId, projectId])).rows[0].id;
    const calls: any[] = [];
    const backbone = { updateSchedule: async (item: any, s: any) => { calls.push([item, s]); } } as any;
    const job: SyncJob = {
      id: "1", organisation_id: orgId, installation_id: 0, delivery_id: "sw-1",
      event_name: "foreman.schedule_write", action: null, status: "running", attempts: 1,
      payload: { work_item_id: wi, start_at: "2026-09-02", target_at: "2026-09-20" },
    };
    await handleSyncJob(db.servicePool, job, { backbone });
    expect(calls).toEqual([[{ workItemId: wi }, { startAt: "2026-09-02", targetAt: "2026-09-20" }]]);
  });

  it("missing backbone in ctx → warn and return, no throw", async () => {
    const job: SyncJob = {
      id: "2", organisation_id: orgId, installation_id: 0, delivery_id: "sw-2",
      event_name: "foreman.schedule_write", action: null, status: "running", attempts: 1,
      payload: { work_item_id: "00000000-0000-0000-0000-000000000000", target_at: "2026-09-20" },
    };
    await expect(handleSyncJob(db.servicePool, job, {})).resolves.toBeUndefined();
  });
});
