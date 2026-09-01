import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { handleSyncJob } from "./index.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "dispatch"));
});
afterAll(async () => { await db.teardown(); });

function jobFor(eventName: string): SyncJob {
  return {
    id: "1", organisation_id: orgId, installation_id: 0, delivery_id: `d-${eventName}`,
    event_name: eventName, action: null, status: "running", attempts: 1,
    payload: { project_id: projectId },
  };
}

describe("handleSyncJob: unwired backbone-dependent handlers fail loudly", () => {
  it.each([
    ["foreman.create_item", "create_item handler not wired"],
    ["foreman.report_run", "report_run handler not wired"],
    ["foreman.schedule_write", "schedule_write handler not wired"],
  ])("%s throws when ctx.backbone is undefined", async (eventName, message) => {
    await expect(handleSyncJob(db.servicePool, jobFor(eventName), {})).rejects.toThrow(message);
  });
});
