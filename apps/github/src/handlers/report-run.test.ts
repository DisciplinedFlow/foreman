import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { handleSyncJob } from "./index.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "reportrun"));
});
afterAll(async () => { await db.teardown(); });

describe("foreman.report_run handler", () => {
  it("routes to backbone.reportRun with the payload", async () => {
    const wi = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title) values ($1,$2,'x') returning id",
      [orgId, projectId])).rows[0].id;
    const calls: any[] = [];
    const backbone = { reportRun: async (item: any, run: any) => { calls.push([item, run]); } } as any;
    const job: SyncJob = {
      id: "1", organisation_id: orgId, installation_id: 0, delivery_id: "rr-1",
      event_name: "foreman.report_run", action: null, status: "running", attempts: 1,
      payload: { work_item_id: wi, state: "completed", summary: "built it", head_sha: "abc", conclusion: "success" },
    };
    await handleSyncJob(db.servicePool, job, { backbone });
    expect(calls).toEqual([[{ workItemId: wi },
      { state: "completed", summary: "built it", headSha: "abc", conclusion: "success" }]]);
  });
});
