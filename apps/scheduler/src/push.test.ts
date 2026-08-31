import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import type pg from "pg";
import { ExtractiveLlm } from "foreman-gen/lib";
import { runPushOnce } from "./push.js";

let db: TestDb;
let orgId: string;
let repoProjectId: string;
let plainProjectId: string;

const llm = new ExtractiveLlm();
const deps = () => ({ llm });

async function completeEvent(projectId: string, title: string): Promise<void> {
  const wi = (await db.servicePool.query(
    "insert into work_items (organisation_id, project_id, title, status) values ($1,$2,$3,'done') returning id",
    [orgId, projectId, title])).rows[0].id;
  await db.servicePool.query(
    `insert into events (organisation_id, project_id, work_item_id, type, payload, occurred_at)
     values ($1,$2,$3,'work.completed','{"summary":"done","acceptance_results":[]}',now())`,
    [orgId, projectId, wi]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  const seeded = await seedOrgWithUser(db.servicePool, "push");
  orgId = seeded.orgId;
  repoProjectId = seeded.projectId;
  await db.servicePool.query(
    "update projects set gh_repos=array['o/r'], gh_installation_id=777 where id=$1", [repoProjectId]);
  plainProjectId = (await db.servicePool.query(
    "insert into projects (organisation_id, name) values ($1,'plain') returning id", [orgId])).rows[0].id;
});
afterAll(async () => { await db.teardown(); });

describe("event-driven regen push (OVW-2)", () => {
  it("a completion regenerates the overview and enqueues one lifecycle scan", async () => {
    await completeEvent(repoProjectId, "pushed feature");
    const r = await runPushOnce(db.servicePool as pg.Pool, deps());
    expect(r.projects).toEqual([repoProjectId]);
    const section = await db.servicePool.query(
      "select content from overview_sections where project_id=$1 and section_id='shipped'", [repoProjectId]);
    expect(section.rows[0].content).toContain("pushed feature");
    const jobs = await db.servicePool.query(
      "select 1 from sync_jobs where event_name='foreman.lifecycle_scan'");
    expect(jobs.rowCount).toBe(1);
  });

  it("no new events → nothing happens (cursor advanced)", async () => {
    const r = await runPushOnce(db.servicePool as pg.Pool, deps());
    expect(r.projects).toEqual([]);
  });

  it("non-completion events advance the cursor without regen", async () => {
    await db.servicePool.query(
      `insert into events (organisation_id, project_id, type, payload, occurred_at)
       values ($1,$2,'agent.heartbeat','{}',now())`, [orgId, repoProjectId]);
    const r = await runPushOnce(db.servicePool as pg.Pool, deps());
    expect(r.projects).toEqual([]);
    const r2 = await runPushOnce(db.servicePool as pg.Pool, deps());
    expect(r2.projects).toEqual([]);
  });

  it("a project without repos regenerates the overview but gets no scan job", async () => {
    await completeEvent(plainProjectId, "plain feature");
    const before = await db.servicePool.query(
      "select count(*)::int as n from sync_jobs where event_name='foreman.lifecycle_scan'");
    const r = await runPushOnce(db.servicePool as pg.Pool, deps());
    expect(r.projects).toEqual([plainProjectId]);
    const after = await db.servicePool.query(
      "select count(*)::int as n from sync_jobs where event_name='foreman.lifecycle_scan'");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await db.servicePool.query(
      "select 1 from overview_sections where project_id=$1 and section_id='shipped'", [plainProjectId])).rowCount).toBe(1);
  });

  it("two completions in one batch → one regen pass, one scan job", async () => {
    const before = await db.servicePool.query(
      "select count(*)::int as n from sync_jobs where event_name='foreman.lifecycle_scan'");
    await completeEvent(repoProjectId, "burst one");
    await completeEvent(repoProjectId, "burst two");
    const r = await runPushOnce(db.servicePool as pg.Pool, deps());
    expect(r.projects).toEqual([repoProjectId]);
    const after = await db.servicePool.query(
      "select count(*)::int as n from sync_jobs where event_name='foreman.lifecycle_scan'");
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    const section = await db.servicePool.query(
      "select content from overview_sections where project_id=$1 and section_id='shipped'", [repoProjectId]);
    expect(section.rows[0].content).toContain("burst one");
    expect(section.rows[0].content).toContain("burst two");
  });
});
