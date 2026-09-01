import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { handleSyncJob } from "./index.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "reviews"));
  await db.servicePool.query("update projects set gh_repos = array['o/r'] where id = $1", [projectId]);
});
afterAll(async () => { await db.teardown(); });

let seq = 0;
async function seedWorkItem(issueNumber: number): Promise<string> {
  return (await db.servicePool.query(
    `insert into work_items (organisation_id, project_id, title, gh_repo, gh_issue_number)
     values ($1,$2,'linked item','o/r',$3) returning id`,
    [orgId, projectId, issueNumber])).rows[0].id;
}

function job(
  eventName: string, action: string, payload: object, deliveryId = `rv-${++seq}`,
): SyncJob {
  return {
    id: String(seq), organisation_id: orgId, installation_id: 777, delivery_id: deliveryId,
    event_name: eventName, action, payload: { action, ...payload }, status: "running", attempts: 1,
  };
}

const reviewPayload = (over: object = {}) => ({
  installation: { id: 777 },
  repository: { full_name: "o/r" },
  review: { id: 9001, state: "approved", user: { login: "octoreviewer" }, html_url: "https://gh.test/o/r/pull/7#review-9001" },
  pull_request: { number: 7, html_url: "https://gh.test/o/r/pull/7", body: "Fixes #42" },
  ...over,
});

describe("inbound pull_request_review handler", () => {
  it("submitted + approved + body 'Fixes #42' links the seeded work item", async () => {
    const wi = await seedWorkItem(42);
    await handleSyncJob(db.servicePool, job("pull_request_review", "submitted", reviewPayload()));
    const e = await db.servicePool.query(
      "select work_item_id, payload from events where type='github.pr_reviewed' and payload->>'review_id'='9001'");
    expect(e.rowCount).toBe(1);
    expect(e.rows[0].work_item_id).toBe(wi);
    expect(e.rows[0].payload).toMatchObject({
      gh_repo: "o/r", pr_number: 7, pr_url: "https://gh.test/o/r/pull/7",
      review_id: 9001, reviewer: "octoreviewer", state: "approved",
    });
  });

  it("changes_requested with no body match appends event with null work_item_id", async () => {
    await handleSyncJob(db.servicePool, job("pull_request_review", "submitted", reviewPayload({
      review: { id: 9002, state: "changes_requested", user: { login: "octoreviewer" }, html_url: "https://gh.test/o/r/pull/8#review-9002" },
      pull_request: { number: 8, html_url: "https://gh.test/o/r/pull/8", body: "no linkage here" },
    })));
    const e = await db.servicePool.query(
      "select work_item_id, payload from events where type='github.pr_reviewed' and payload->>'review_id'='9002'");
    expect(e.rowCount).toBe(1);
    expect(e.rows[0].work_item_id).toBeNull();
    expect(e.rows[0].payload.state).toBe("changes_requested");
  });

  it("dismissed action appends no event", async () => {
    await handleSyncJob(db.servicePool, job("pull_request_review", "dismissed", reviewPayload({
      review: { id: 9003, state: "dismissed", user: { login: "octoreviewer" }, html_url: "https://gh.test/o/r/pull/9#review-9003" },
      pull_request: { number: 9, html_url: "https://gh.test/o/r/pull/9", body: null },
    })));
    const e = await db.servicePool.query(
      "select 1 from events where type='github.pr_reviewed' and payload->>'review_id'='9003'");
    expect(e.rowCount).toBe(0);
  });

  it("review on an untracked repo appends nothing", async () => {
    await handleSyncJob(db.servicePool, job("pull_request_review", "submitted", reviewPayload({
      repository: { full_name: "other/repo" },
      review: { id: 9004, state: "approved", user: { login: "octoreviewer" }, html_url: "https://gh.test/other/repo/pull/1#review-9004" },
    })));
    const e = await db.servicePool.query(
      "select 1 from events where type='github.pr_reviewed' and payload->>'review_id'='9004'");
    expect(e.rowCount).toBe(0);
  });

  it("same delivery id twice: event deduped", async () => {
    const j = job("pull_request_review", "submitted", reviewPayload({
      review: { id: 9005, state: "commented", user: { login: "octoreviewer" }, html_url: "https://gh.test/o/r/pull/10#review-9005" },
      pull_request: { number: 10, html_url: "https://gh.test/o/r/pull/10", body: null },
    }));
    await handleSyncJob(db.servicePool, j);
    await handleSyncJob(db.servicePool, j);
    const e = await db.servicePool.query(
      "select count(*)::int as n from events where type='github.pr_reviewed' and payload->>'review_id'='9005'");
    expect(e.rows[0].n).toBe(1);
  });
});
