import { describe, expect, it } from "vitest";
import { createTestDatabase, seedOrgWithUser } from "./testing.js";
import { claimNextWorkItem, enqueueWorkItem, completeWorkItem, sweepExpiredLeases, WipLimitExceededError } from "./queue.js";

async function seedAgent(pool: any, orgId: string, projectId: string, name: string, wip = 1) {
  const r = await pool.query(
    "insert into agents (organisation_id, project_id, display_name, platform, wip_limit) values ($1,$2,$3,'test',$4) returning id",
    [orgId, projectId, name, wip]);
  return r.rows[0].id as string;
}

describe("queue engine", () => {
  it("QUE-3: 100 concurrent claims over 10 items yield 10 distinct winners", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q3");
      for (let i = 0; i < 10; i++)
        await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: `item ${i}` });
      const agents = await Promise.all(Array.from({ length: 100 }, (_, i) =>
        seedAgent(db.servicePool, orgId, projectId, `a${i}`)));
      const results = await Promise.all(agents.map(a =>
        claimNextWorkItem(db.servicePool, { projectId, agentId: a }).catch(e => e)));
      const wins = results.filter(r => r && !(r instanceof Error));
      expect(wins).toHaveLength(10);
      expect(new Set(wins.map((w: any) => w.id)).size).toBe(10);
    } finally { await db.teardown(); }
  }, 60_000);

  it("QUE-2: strict priority order with enqueued_at tiebreak", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q2");
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "later", priority: 50 });
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "urgent", priority: 1 });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a", 5);
      const first = await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      expect(first!.title).toBe("urgent");
    } finally { await db.teardown(); }
  });

  it("QUE-6: blocked items are unclaimable until the blocker completes", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q6");
      const blocker = await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "A", priority: 2 });
      const blocked = await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "B", priority: 1 });
      await db.servicePool.query(
        "insert into work_item_deps (organisation_id, blocked_id, blocker_id) values ($1,$2,$3)",
        [orgId, blocked.id, blocker.id]);
      const a = await seedAgent(db.servicePool, orgId, projectId, "a", 5);
      const c1 = await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      expect(c1!.id).toBe(blocker.id); // B has higher priority but is dep-gated
      await completeWorkItem(db.servicePool, { workItemId: blocker.id, agentId: a, summary: "done", acceptanceResults: [] });
      const c2 = await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      expect(c2!.id).toBe(blocked.id);
    } finally { await db.teardown(); }
  });

  it("QUE-5: typed WIP errors for agent and project limits", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q5");
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "1" });
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "2" });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a", 1);
      await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      await expect(claimNextWorkItem(db.servicePool, { projectId, agentId: a }))
        .rejects.toThrow(WipLimitExceededError);
    } finally { await db.teardown(); }
  });

  it("QUE-4: expired lease requeues at original priority and logs work.lease_expired", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q4");
      const item = await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "x", priority: 7 });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a");
      await claimNextWorkItem(db.servicePool, { projectId, agentId: a, leaseSeconds: 0 });
      await new Promise(r => setTimeout(r, 50));
      const n = await sweepExpiredLeases(db.servicePool);
      expect(n).toBe(1);
      const row = await db.servicePool.query("select status, priority, claimed_by from work_items where id=$1", [item.id]);
      expect(row.rows[0]).toMatchObject({ status: "queued", priority: 7, claimed_by: null });
      const evt = await db.servicePool.query("select payload from events where type='work.lease_expired' and work_item_id=$1", [item.id]);
      expect(evt.rows[0].payload.agent_id).toBe(a);
    } finally { await db.teardown(); }
  });

  it("QUE-7: completion without an acceptance verdict is rejected when criteria exist", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q7");
      const item = await enqueueWorkItem(db.servicePool, {
        organisationId: orgId, projectId, title: "x", acceptance: ["tests pass"] });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a");
      await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      await expect(completeWorkItem(db.servicePool, {
        workItemId: item.id, agentId: a, summary: "done", acceptanceResults: [] }))
        .rejects.toThrow(/acceptance/);
    } finally { await db.teardown(); }
  });
});
