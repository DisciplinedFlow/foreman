import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { fullSync } from "./full-sync.js";
import { seedGithubApp } from "../testing.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "fullsync"));
  await seedGithubApp(db.servicePool, orgId);
  await db.servicePool.query(
    `update projects set gh_repos = array['o/r'], gh_installation_id = 777, gh_project_node_id = 'PVT_x',
       field_map = $2 where id = $1`,
    [projectId, JSON.stringify({
      start_field: { node_id: "F_start", type: "DATE" },
      target_field: { node_id: "F_target", type: "DATE" },
    })]);
});
afterAll(async () => { await db.teardown(); });

const issue = (nodeId: string, dbid: number, number: number, title: string, parent?: string) => ({
  id: nodeId, fullDatabaseId: dbid, number, title, body: `body of ${title}`, state: "OPEN",
  repository: { nameWithOwner: "o/r" }, parent: parent ? { id: parent } : null,
});

const page1 = {
  node: { items: {
    pageInfo: { hasNextPage: true, endCursor: "cur1" },
    nodes: [
      { id: "ITEM_E", fieldValues: { nodes: [] }, content: issue("I_E", 9001, 1, "Epic") },
      { id: "ITEM_B", fieldValues: { nodes: [
          { date: "2026-09-01", field: { id: "F_start" } },
          { date: "2026-09-15", field: { id: "F_target" } },
        ] }, content: issue("I_B", 9002, 2, "Child B", "I_E") },
    ],
  } },
};
const page2 = {
  node: { items: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      { id: "ITEM_C", fieldValues: { nodes: [] }, content: issue("I_C", 9003, 3, "Blocked C") },
    ],
  } },
};

function makeGh() {
  const restCalls: string[] = [];
  return {
    restCalls,
    graphql: async (_a: number, _i: number, _q: string, vars: Record<string, unknown>) =>
      (vars.cursor ? page2 : page1) as any,
    rest: async (_a: number, _i: number, _m: string, path: string) => {
      restCalls.push(path);
      // B (issue 2) blocks C (issue 3)
      if (path.includes("/issues/3/")) return { status: 200, json: [{ id: 9002 }] };
      return { status: 200, json: [] };
    },
  };
}

async function counts() {
  const w = await db.servicePool.query("select count(*)::int as n from work_items where project_id=$1", [projectId]);
  const d = await db.servicePool.query("select count(*)::int as n from work_item_deps where organisation_id=$1", [orgId]);
  return { items: w.rows[0].n, deps: d.rows[0].n };
}

describe("fullSync", () => {
  it("pages items, upserts linkage, resolves parents, replaces deps; running twice is idempotent", async () => {
    const project = await db.servicePool.query("select * from projects where id=$1", [projectId]);

    const r1 = await fullSync({ tx: db.servicePool, gh: makeGh() }, project.rows[0]);
    expect(r1.items).toBe(3);
    expect(await counts()).toEqual({ items: 3, deps: 1 });

    const rows = await db.servicePool.query(
      "select gh_issue_node_id, gh_item_node_id, gh_issue_id, parent_id, start_at::text, target_at::text from work_items where project_id=$1 order by gh_issue_number", [projectId]);
    const [e, b, c] = rows.rows;
    expect(e.gh_item_node_id).toBe("ITEM_E");
    expect(Number(e.gh_issue_id)).toBe(9001);
    expect(b.parent_id).not.toBeNull();
    const epic = await db.servicePool.query("select id from work_items where gh_issue_node_id='I_E'");
    expect(b.parent_id).toBe(epic.rows[0].id);
    expect(b.start_at).toBe("2026-09-01");
    expect(b.target_at).toBe("2026-09-15");
    const dep = await db.servicePool.query("select blocker_id from work_item_deps where blocked_id=$1", [c.parent_id ?? (await db.servicePool.query("select id from work_items where gh_issue_node_id='I_C'")).rows[0].id]);
    const bId = (await db.servicePool.query("select id from work_items where gh_issue_node_id='I_B'")).rows[0].id;
    expect(dep.rows[0].blocker_id).toBe(bId);

    const events = await db.servicePool.query(
      "select count(*)::int as n from events where type='github.issue_synced' and project_id=$1", [projectId]);
    expect(events.rows[0].n).toBeGreaterThanOrEqual(3);

    // second run: identical table state
    const r2 = await fullSync({ tx: db.servicePool, gh: makeGh() }, project.rows[0]);
    expect(r2.items).toBe(3);
    expect(await counts()).toEqual({ items: 3, deps: 1 });
  });
});
