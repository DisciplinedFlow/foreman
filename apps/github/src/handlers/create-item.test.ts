import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { handleSyncJob } from "./index.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "createitem"));
});
afterAll(async () => { await db.teardown(); });

describe("foreman.create_item handler", () => {
  it("routes to backbone.createWorkItem with the payload", async () => {
    const calls: any[] = [];
    const backbone = { createWorkItem: async (p: any, item: any) => { calls.push([p, item]); return { workItemId: "w" }; } } as any;
    const job: SyncJob = {
      id: "1", organisation_id: orgId, installation_id: 0, delivery_id: "ci-1",
      event_name: "foreman.create_item", action: null, status: "running", attempts: 1,
      payload: { project_id: projectId, title: "gh item", intent: "please", kind: "bug", priority: 5, acceptance: ["ok"] },
    };
    await handleSyncJob(db.servicePool, job, { backbone });
    expect(calls).toEqual([[{ projectId },
      { title: "gh item", intent: "please", kind: "bug", priority: 5, acceptance: ["ok"] }]]);
  });
});
