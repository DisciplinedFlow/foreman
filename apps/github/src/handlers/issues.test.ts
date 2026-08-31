import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { handleSyncJob } from "./index.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "handlers"));
  await db.servicePool.query("update projects set gh_repos = array['o/r'] where id = $1", [projectId]);
});
afterAll(async () => { await db.teardown(); });

let seq = 0;
function job(eventName: string, action: string, payload: object, deliveryId = `d-${++seq}`): SyncJob {
  return {
    id: String(seq), organisation_id: orgId, installation_id: 777, delivery_id: deliveryId,
    event_name: eventName, action, payload: { action, ...payload }, status: "running", attempts: 1,
  };
}

const issue = (over: object = {}) => ({
  installation: { id: 777 },
  repository: { full_name: "o/r" },
  issue: {
    id: 5001, node_id: "I_node1", number: 42, title: "fix the bug", body: "it broke",
    state: "open", type: { name: "Bug" }, ...over,
  },
});

describe("inbound issues handler", () => {
  it("opened creates a work item with linkage columns + appends github.issue_synced", async () => {
    await handleSyncJob(db.servicePool, job("issues", "opened", issue()));
    const w = await db.servicePool.query("select * from work_items where gh_issue_node_id='I_node1'");
    expect(w.rowCount).toBe(1);
    expect(w.rows[0]).toMatchObject({
      title: "fix the bug", intent: "it broke", status: "queued", kind: "bug",
      gh_issue_number: 42, gh_repo: "o/r", project_id: projectId,
    });
    expect(Number(w.rows[0].gh_issue_id)).toBe(5001);
    const e = await db.servicePool.query(
      "select 1 from events where type='github.issue_synced' and work_item_id=$1", [w.rows[0].id]);
    expect(e.rowCount).toBe(1);
  });

  it("same delivery id twice: event deduped, row not duplicated", async () => {
    const j = job("issues", "opened", issue({ node_id: "I_node2", number: 43, id: 5002 }));
    await handleSyncJob(db.servicePool, j);
    await handleSyncJob(db.servicePool, j);
    const w = await db.servicePool.query("select 1 from work_items where gh_issue_node_id='I_node2'");
    expect(w.rowCount).toBe(1);
    const e = await db.servicePool.query(
      "select 1 from events where type='github.issue_synced' and payload->>'gh_issue_number'='43'");
    expect(e.rowCount).toBe(1);
  });

  it("closed on an in_progress item leaves status alone but appends the event", async () => {
    await handleSyncJob(db.servicePool, job("issues", "opened", issue({ node_id: "I_node3", number: 44, id: 5003 })));
    await db.servicePool.query("update work_items set status='in_progress' where gh_issue_node_id='I_node3'");
    await handleSyncJob(db.servicePool, job("issues", "closed", issue({ node_id: "I_node3", number: 44, id: 5003, state: "closed" })));
    const w = await db.servicePool.query("select status from work_items where gh_issue_node_id='I_node3'");
    expect(w.rows[0].status).toBe("in_progress");
    const e = await db.servicePool.query(
      "select count(*)::int as n from events where type='github.issue_synced' and payload->>'gh_issue_number'='44'");
    expect(e.rows[0].n).toBe(2);
  });

  it("closed on a queued item flips it to done", async () => {
    await handleSyncJob(db.servicePool, job("issues", "opened", issue({ node_id: "I_node4", number: 45, id: 5004 })));
    await handleSyncJob(db.servicePool, job("issues", "closed", issue({ node_id: "I_node4", number: 45, id: 5004, state: "closed" })));
    const w = await db.servicePool.query("select status from work_items where gh_issue_node_id='I_node4'");
    expect(w.rows[0].status).toBe("done");
  });

  it("issue from an untracked repo appends nothing and is not an error", async () => {
    await handleSyncJob(db.servicePool, job("issues", "opened",
      { ...issue({ node_id: "I_other" }), repository: { full_name: "other/repo" } }));
    const w = await db.servicePool.query("select 1 from work_items where gh_issue_node_id='I_other'");
    expect(w.rowCount).toBe(0);
  });

  it("pr_merged with 'Fixes #42' links the work item", async () => {
    await handleSyncJob(db.servicePool, job("pull_request", "closed", {
      installation: { id: 777 },
      repository: { full_name: "o/r" },
      pull_request: { number: 7, merged: true, html_url: "https://gh.test/o/r/pull/7",
        merge_commit_sha: "abc123", body: "Fixes #42" },
    }));
    const w = await db.servicePool.query("select id from work_items where gh_issue_number=42 and gh_repo='o/r'");
    const e = await db.servicePool.query("select work_item_id from events where type='github.pr_merged'");
    expect(e.rowCount).toBe(1);
    expect(e.rows[0].work_item_id).toBe(w.rows[0].id);
  });
});
