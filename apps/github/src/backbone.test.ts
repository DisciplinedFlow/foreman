import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { InMemoryKv, EchoCache, type Kv } from "@foreman/github-client";
import type pg from "pg";
import { GithubBackbone } from "./backbone.js";
import { seedGithubApp } from "./testing.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "backbone"));
  await seedGithubApp(db.servicePool, orgId);
  await db.servicePool.query(
    `update projects set gh_repos = array['o/r'], gh_installation_id = 777, gh_project_node_id = 'PVT_x',
       field_map = $2 where id = $1`,
    [projectId, JSON.stringify({
      target_field: { node_id: "F_target", type: "DATE" },
      // no start_field / iteration_field on purpose: those dimensions must be skipped
    })]);
});
afterAll(async () => { await db.teardown(); });

function makeDeps() {
  const order: string[] = [];
  const restCalls: Array<{ method: string; path: string; body: any }> = [];
  const graphqlCalls: Array<{ query: string; vars: any }> = [];
  const gh = {
    rest: async (_a: number, _i: number, method: string, path: string, body?: unknown) => {
      order.push(`rest ${method} ${path}`);
      restCalls.push({ method, path, body });
      return { status: 201, json: { id: 7777, node_id: "I_new", number: 55 } };
    },
    graphql: async (_a: number, _i: number, query: string, vars: Record<string, unknown>) => {
      order.push("graphql");
      graphqlCalls.push({ query, vars });
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_x" } } } as any;
    },
  };
  const kv: Kv = new InMemoryKv();
  const origSet = kv.set.bind(kv);
  kv.set = async (k, v, ttl) => { if (k.startsWith("ghecho:")) order.push("echo.record"); await origSet(k, v, ttl); };
  const echo = new EchoCache(kv);
  const backbone = new GithubBackbone({ pool: db.servicePool as pg.Pool, gh, echo, emitter: new EventEmitter() });
  return { backbone, order, restCalls, graphqlCalls };
}

describe("GithubBackbone", () => {
  it("createWorkItem posts the issue with type Bug for kind bug and persists gh_issue_id", async () => {
    const { backbone, restCalls } = makeDeps();
    const item = await backbone.createWorkItem({ projectId }, { title: "broken", intent: "boom", kind: "bug" });
    expect(restCalls[0]).toMatchObject({
      method: "POST", path: "/repos/o/r/issues",
      body: { title: "broken", body: "boom", type: "Bug" },
    });
    const row = await db.servicePool.query("select * from work_items where id=$1", [item.workItemId]);
    expect(Number(row.rows[0].gh_issue_id)).toBe(7777);
    expect(row.rows[0].gh_issue_node_id).toBe("I_new");
    expect(row.rows[0].gh_issue_number).toBe(55);
    const e = await db.servicePool.query(
      "select 1 from events where type='github.issue_synced' and work_item_id=$1", [item.workItemId]);
    expect(e.rowCount).toBe(1);
  });

  it("linkParent sends the child's database id, not the number", async () => {
    const { backbone, restCalls } = makeDeps();
    const ins = async (n: number, dbid: number) => (await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title, gh_issue_number, gh_issue_id, gh_repo)
       values ($1,$2,'x',$3,$4,'o/r') returning id`, [orgId, projectId, n, dbid])).rows[0].id;
    const parentId = await ins(10, 9010);
    const childId = await ins(11, 9011);
    await backbone.linkParent({ workItemId: childId }, { workItemId: parentId });
    expect(restCalls[0]).toMatchObject({
      method: "POST", path: "/repos/o/r/issues/10/sub_issues", body: { sub_issue_id: 9011 },
    });
    const row = await db.servicePool.query("select parent_id from work_items where id=$1", [childId]);
    expect(row.rows[0].parent_id).toBe(parentId);
  });

  it("addDependency posts blocked_by with the blocker's database id and upserts the dep", async () => {
    const { backbone, restCalls } = makeDeps();
    const ins = async (n: number, dbid: number) => (await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title, gh_issue_number, gh_issue_id, gh_repo)
       values ($1,$2,'x',$3,$4,'o/r') returning id`, [orgId, projectId, n, dbid])).rows[0].id;
    const blockedId = await ins(20, 9020);
    const blockerId = await ins(21, 9021);
    await backbone.addDependency({ workItemId: blockedId }, { workItemId: blockerId });
    expect(restCalls[0]).toMatchObject({
      method: "POST", path: "/repos/o/r/issues/20/dependencies/blocked_by", body: { issue_id: 9021 },
    });
    const dep = await db.servicePool.query(
      "select source from work_item_deps where blocked_id=$1 and blocker_id=$2", [blockedId, blockerId]);
    expect(dep.rows[0].source).toBe("foreman");
  });

  it("updateSchedule echo-records before the GraphQL call, sends a date value, skips unmapped dims", async () => {
    const { backbone, order, graphqlCalls } = makeDeps();
    const r = await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title, gh_item_node_id)
       values ($1,$2,'sched','ITEM_s') returning id`, [orgId, projectId]);
    await backbone.updateSchedule({ workItemId: r.rows[0].id },
      { targetAt: "2026-09-15", startAt: "2026-09-01", iterationId: "it_9" });
    // start + iteration are unmapped → exactly one echo.record + one graphql, in that order
    expect(order).toEqual(["echo.record", "graphql"]);
    expect(graphqlCalls[0]!.vars).toMatchObject({
      projectId: "PVT_x", itemId: "ITEM_s", fieldId: "F_target", value: { date: "2026-09-15" },
    });
    const row = await db.servicePool.query("select target_at::text, start_at from work_items where id=$1", [r.rows[0].id]);
    expect(row.rows[0].target_at).toBe("2026-09-15");
    expect(row.rows[0].start_at).toBeNull();
    const e = await db.servicePool.query(
      "select 1 from events where type='work.rescheduled' and work_item_id=$1", [r.rows[0].id]);
    expect(e.rowCount).toBe(1);
  });

  it("reportRun creates the check run with head_sha, ≤3 constrained actions, then PATCHes in place", async () => {
    const { backbone, restCalls } = makeDeps();
    const wi = (await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title, gh_issue_number, gh_repo)
       values ($1,$2,'Implement rate limiter',30,'o/r') returning id`, [orgId, projectId])).rows[0].id;

    await backbone.reportRun({ workItemId: wi }, { state: "in_progress", summary: "3/5 criteria", headSha: "abc123" });
    expect(restCalls[0]!.method).toBe("POST");
    expect(restCalls[0]!.path).toBe("/repos/o/r/check-runs");
    const body = restCalls[0]!.body;
    expect(body.head_sha).toBe("abc123");
    expect(body.status).toBe("in_progress");
    expect(body.actions.length).toBeLessThanOrEqual(3);
    for (const a of body.actions) {
      expect(a.label.length).toBeLessThanOrEqual(20);
      expect(a.description.length).toBeLessThanOrEqual(40);
      expect(a.identifier.length).toBeLessThanOrEqual(20);
    }
    const row = await db.servicePool.query("select gh_check_run_id from work_items where id=$1", [wi]);
    expect(Number(row.rows[0].gh_check_run_id)).toBe(7777);

    await backbone.reportRun({ workItemId: wi }, { state: "completed", conclusion: "success", summary: "done" });
    expect(restCalls[1]!.method).toBe("PATCH");
    expect(restCalls[1]!.path).toBe("/repos/o/r/check-runs/7777");
    expect(restCalls[1]!.body.conclusion).toBe("success");
    expect(restCalls[1]!.body.actions).toBeUndefined();

    const e = await db.servicePool.query(
      "select count(*)::int as n from events where type='github.check_updated' and work_item_id=$1", [wi]);
    expect(e.rows[0].n).toBe(2);
  });

  it("reportRun without a repo or sha is a no-op", async () => {
    const { backbone, restCalls } = makeDeps();
    const noRepo = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title) values ($1,$2,'local only') returning id",
      [orgId, projectId])).rows[0].id;
    await backbone.reportRun({ workItemId: noRepo }, { state: "completed", headSha: "abc" });
    const noSha = (await db.servicePool.query(
      "insert into work_items (organisation_id, project_id, title, gh_repo) values ($1,$2,'no sha yet','o/r') returning id",
      [orgId, projectId])).rows[0].id;
    await backbone.reportRun({ workItemId: noSha }, { state: "in_progress" });
    expect(restCalls.length).toBe(0);
  });
});
