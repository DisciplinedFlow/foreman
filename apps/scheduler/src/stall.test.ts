import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import type pg from "pg";
import { detectStalls } from "./stall.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "stall"));
  await db.servicePool.query("update projects set stall_threshold_sec = 5 where id = $1", [projectId]);
});
afterAll(async () => { await db.teardown(); });

async function makeAgent(name: string): Promise<string> {
  return (await db.servicePool.query(
    `insert into agents (organisation_id, project_id, display_name, platform, status, last_seen_at)
     values ($1,$2,$3,'test','working',now()) returning id`, [orgId, projectId, name])).rows[0].id;
}

const insertEvent = (agentId: string, type: string, payload: object, recordedAgo = "0 seconds") =>
  db.servicePool.query(
    `insert into events (organisation_id, project_id, agent_id, type, payload, occurred_at, recorded_at)
     values ($1,$2,$3,$4,$5,now(),now() - $6::interval)`,
    [orgId, projectId, agentId, type, JSON.stringify(payload), recordedAgo]);

describe("detectStalls (AVW-3)", () => {
  it("rule A: a working agent silent past the project threshold is stalled", async () => {
    const a = await makeAgent("silent");
    await insertEvent(a, "agent.heartbeat", { status: "working" }, "10 seconds");
    const n = await detectStalls(db.servicePool as pg.Pool);
    expect(n).toBeGreaterThanOrEqual(1);
    const row = await db.servicePool.query("select status from agents where id=$1", [a]);
    expect(row.rows[0].status).toBe("stalled");
    const e = await db.servicePool.query(
      "select payload from events where type='agent.stalled' and agent_id=$1", [a]);
    expect(e.rowCount).toBe(1);
    expect(e.rows[0].payload.threshold_sec).toBe(5);
  });

  it("rule A: an agent under threshold is untouched", async () => {
    const a = await makeAgent("fresh");
    await insertEvent(a, "agent.heartbeat", { status: "working" });
    await detectStalls(db.servicePool as pg.Pool);
    const row = await db.servicePool.query("select status from agents where id=$1", [a]);
    expect(row.rows[0].status).toBe("working");
  });

  it("rule B: five identical tool calls stall the agent despite recent activity", async () => {
    const a = await makeAgent("looper");
    for (let i = 0; i < 5; i++) {
      await insertEvent(a, "tool.invoked", { tool_name: "Bash", tool_use_id: "same", input: { command: "npm test" } });
    }
    await detectStalls(db.servicePool as pg.Pool);
    const row = await db.servicePool.query("select status from agents where id=$1", [a]);
    expect(row.rows[0].status).toBe("stalled");
  });

  it("rule B: four identical plus one different does NOT stall", async () => {
    const a = await makeAgent("varied");
    for (let i = 0; i < 4; i++) {
      await insertEvent(a, "tool.invoked", { tool_name: "Bash", tool_use_id: "same", input: { command: "npm test" } });
    }
    await insertEvent(a, "tool.invoked", { tool_name: "Read", tool_use_id: "diff", input: { file: "a.ts" } });
    await detectStalls(db.servicePool as pg.Pool);
    const row = await db.servicePool.query("select status from agents where id=$1", [a]);
    expect(row.rows[0].status).toBe("working");
  });

  it("a second pass never re-flags an already-stalled agent", async () => {
    const before = await db.servicePool.query("select count(*)::int as n from events where type='agent.stalled'");
    await detectStalls(db.servicePool as pg.Pool);
    const after = await db.servicePool.query("select count(*)::int as n from events where type='agent.stalled'");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
