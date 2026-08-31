import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { enqueueReconcileJobs } from "@foreman/db";
import { InMemoryKv, EchoCache, GithubClient, InstallationTokenSource } from "@foreman/github-client";
import type pg from "pg";
import { createReceiver } from "./receiver.js";
import { claimSyncJob, completeSyncJob } from "./jobs.js";
import { handleSyncJob, type HandlerContext } from "./handlers/index.js";
import { GithubBackbone } from "./backbone.js";
import { startFakeGithub, type RecordedRequest } from "./fake-github.js";
import { signedHeaders } from "./testing.js";

const SECRET = "whsec-rt";

let db: TestDb;
let orgId: string;
let projectId: string;
let webhookUrl: string;
let fakeUrl: string;
let requests: RecordedRequest[];
let closers: Array<() => Promise<unknown>> = [];
let gh: GithubClient;
let echo: EchoCache;
let backbone: GithubBackbone;

const outboundGraphql = () => requests.filter((r) => r.path === "/graphql").length;

async function drain(ctx: HandlerContext): Promise<void> {
  for (;;) {
    const job = await claimSyncJob(db.servicePool);
    if (job === null) return;
    const client = await db.servicePool.connect();
    let ok = false;
    try {
      await client.query("begin");
      await handleSyncJob(client, job, ctx);
      await client.query("commit");
      ok = true;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    await completeSyncJob(db.servicePool, job.id, ok);
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "roundtrip"));
  await db.servicePool.query(
    `update projects set gh_repos = array['o/r'], gh_installation_id = 777, gh_project_node_id = 'PVT_x',
       field_map = $2 where id = $1`,
    [projectId, JSON.stringify({ target_field: { node_id: "F_target", type: "DATE" } })]);

  const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await db.servicePool.query(
    "insert into github_apps (app_id, slug, private_key_pem, webhook_secret) values (1,'rt',$1,$2)", [pem, SECRET]);
  await db.servicePool.query(
    "insert into github_installations (installation_id, app_id, organisation_id) values (777,1,$1)", [orgId]);

  const fake = await startFakeGithub();
  fakeUrl = fake.url;
  requests = fake.requests;
  closers.push(fake.close);

  const receiver = createReceiver({ pool: db.servicePool as pg.Pool });
  const server = receiver.listen(0);
  await new Promise((r) => server.once("listening", r));
  webhookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/webhook`;
  closers.push(() => new Promise((r) => server.close(r)));

  const kv = new InMemoryKv();
  const tokens = new InstallationTokenSource({
    kv, apiBase: fakeUrl,
    getApp: async (appId) => {
      const r = await db.servicePool.query("select private_key_pem from github_apps where app_id=$1", [appId]);
      return { privateKeyPem: r.rows[0].private_key_pem };
    },
  });
  gh = new GithubClient({ tokens, kv, apiBase: fakeUrl });
  echo = new EchoCache(kv);
  backbone = new GithubBackbone({ pool: db.servicePool as pg.Pool, gh, echo, emitter: new EventEmitter() });
});
afterAll(async () => { for (const c of closers) await c(); await db.teardown(); });

const webhook = (event: string, payload: object) => {
  const body = JSON.stringify({ installation: { id: 777 }, ...payload });
  return fetch(webhookUrl, { method: "POST", body, headers: signedHeaders(SECRET, body, { "x-github-event": event }) });
};

describe("round-trip with echo suppression (SPEC §9 week-7 done-when)", () => {
  it("inbound → outbound → reflected echo → non-echo, no loops", async () => {
    // 1. Inbound: issues.opened
    const res = await webhook("issues", {
      action: "opened",
      repository: { full_name: "o/r" },
      issue: { id: 8001, node_id: "I_rt1", number: 42, title: "round trip", body: "loop me", state: "open" },
    });
    expect(res.status).toBe(200);
    await drain({ echo, gh });
    const w = await db.servicePool.query("select * from work_items where gh_issue_node_id='I_rt1'");
    expect(w.rowCount).toBe(1);
    const workItemId: string = w.rows[0].id;
    expect((await db.servicePool.query(
      "select 1 from events where type='github.issue_synced' and work_item_id=$1", [workItemId])).rowCount).toBe(1);

    // Link the project item (projects_v2_item.created)
    await webhook("projects_v2_item", {
      action: "created",
      projects_v2_item: { node_id: "ITEM_rt1", project_node_id: "PVT_x", content_node_id: "I_rt1" },
    });
    await drain({ echo, gh });
    expect((await db.servicePool.query(
      "select gh_item_node_id from work_items where id=$1", [workItemId])).rows[0].gh_item_node_id).toBe("ITEM_rt1");

    // 2. Outbound: schedule write-back hits exactly one GraphQL mutation
    expect(outboundGraphql()).toBe(0);
    await backbone.updateSchedule({ workItemId }, { targetAt: "2026-09-15" });
    expect(outboundGraphql()).toBe(1);
    expect((await db.servicePool.query(
      "select target_at::text from work_items where id=$1", [workItemId])).rows[0].target_at).toBe("2026-09-15");

    // 3. Echo: GitHub reflects our own write back — event appended, row untouched, NO new outbound
    await webhook("projects_v2_item", {
      action: "edited",
      projects_v2_item: { node_id: "ITEM_rt1", project_node_id: "PVT_x", content_node_id: "I_rt1" },
      changes: { field_value: { field_node_id: "F_target", field_type: "date", from: null, to: { date: "2026-09-15" } } },
    });
    await drain({ echo, gh });
    expect(outboundGraphql()).toBe(1); // zero additional outbound calls
    expect((await db.servicePool.query(
      "select target_at::text from work_items where id=$1", [workItemId])).rows[0].target_at).toBe("2026-09-15");
    expect((await db.servicePool.query(
      "select count(*)::int as n from events where type='github.project_item_changed'")).rows[0].n).toBeGreaterThanOrEqual(1);

    // 4. Non-echo: a human moved the date — row updates, still no outbound (one-way flow)
    await webhook("projects_v2_item", {
      action: "edited",
      projects_v2_item: { node_id: "ITEM_rt1", project_node_id: "PVT_x", content_node_id: "I_rt1" },
      changes: { field_value: { field_node_id: "F_target", field_type: "date", from: { date: "2026-09-15" }, to: { date: "2026-10-01" } } },
    });
    await drain({ echo, gh });
    expect(outboundGraphql()).toBe(1);
    expect((await db.servicePool.query(
      "select target_at::text from work_items where id=$1", [workItemId])).rows[0].target_at).toBe("2026-10-01");
  });

  it("reconciliation cron: enqueue + drain routes foreman.reconcile to fullSync", async () => {
    const n = await enqueueReconcileJobs(db.servicePool);
    expect(n).toBe(2); // foreman.reconcile + foreman.lifecycle_scan (Phase 6)
    const itemsQueriesBefore = requests.filter((r) => r.path === "/graphql" && r.body?.query?.includes("items(")).length;
    await drain({ echo, gh });
    const itemsQueriesAfter = requests.filter((r) => r.path === "/graphql" && r.body?.query?.includes("items(")).length;
    expect(itemsQueriesAfter).toBe(itemsQueriesBefore + 1);
    const job = await db.servicePool.query(
      "select status from sync_jobs where event_name='foreman.reconcile' order by id desc limit 1");
    expect(job.rows[0].status).toBe("done");
  });
});
