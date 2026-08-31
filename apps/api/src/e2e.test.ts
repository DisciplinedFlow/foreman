import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { InMemoryKv, EchoCache, GithubClient, InstallationTokenSource } from "@foreman/github-client";
import {
  claimSyncJob, completeSyncJob, handleSyncJob, GithubBackbone, startFakeGithub,
  type HandlerContext,
} from "foreman-github/lib";
import pg from "pg";
import { createApp } from "./http.js";
import { createEventHub, type EventHub } from "./stream.js";

let db: TestDb;
let appPool: pg.Pool;
let hub: EventHub;
let url: string;
let cookie: string;
let orgId: string;
let projectId: string;
let itemId: string;
let ctx: HandlerContext;
const closers: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "e2e"));
  appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });

  // Project wired for GitHub with a DATE target field.
  await db.servicePool.query(
    `update projects set gh_repos = array['o/r'], gh_installation_id = 777, gh_project_node_id = 'PVT_e2e',
       field_map = $2 where id = $1`,
    [projectId, JSON.stringify({ target_field: { node_id: "F_target", type: "DATE" } })]);
  const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await db.servicePool.query(
    "insert into github_apps (app_id, slug, private_key_pem, webhook_secret) values (1,'e2e',$1,'whsec')", [pem]);
  await db.servicePool.query(
    "insert into github_installations (installation_id, app_id, organisation_id) values (777,1,$1)", [orgId]);
  itemId = (await db.servicePool.query(
    `insert into work_items (organisation_id, project_id, title, gh_item_node_id, start_at, target_at)
     values ($1,$2,'e2e item','ITEM_e2e','2026-09-01','2026-09-10') returning id`,
    [orgId, projectId])).rows[0].id;

  // Fake GitHub + the worker's real backbone.
  const fake = await startFakeGithub();
  closers.push(fake.close);
  const kv = new InMemoryKv();
  const tokens = new InstallationTokenSource({
    kv, apiBase: fake.url,
    getApp: async () => ({ privateKeyPem: pem }),
  });
  const gh = new GithubClient({ tokens, kv, apiBase: fake.url });
  const echo = new EchoCache(kv);
  ctx = {
    echo, gh,
    backbone: new GithubBackbone({ pool: db.servicePool as pg.Pool, gh, echo, emitter: new EventEmitter() }),
  };

  // The api under test.
  hub = await createEventHub(db.servicePool as pg.Pool);
  const app = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "e2e-secret", devAuth: true, hub });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closers.push(() => new Promise((r) => server.close(r)));

  const login = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "e2e@test.local" }),
  });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(async () => {
  for (const c of closers.reverse()) await c();
  await hub.close();
  await appPool.end();
  await db.teardown();
});

async function drain(): Promise<number> {
  let n = 0;
  for (;;) {
    const job = await claimSyncJob(db.servicePool);
    if (job === null) return n;
    const client = await db.servicePool.connect();
    let ok = false;
    try {
      await client.query("begin");
      await handleSyncJob(client, job, ctx);
      await client.query("commit");
      ok = true;
    } finally {
      if (!ok) await client.query("rollback").catch(() => {});
      client.release();
    }
    await completeSyncJob(db.servicePool, job.id, ok);
    n += 1;
  }
}

describe("full-stack round trip", () => {
  it("login → read → drag write-back → worker → SSE confirms", async () => {
    // Reads all come back RLS-scoped.
    const items = await (await fetch(`${url}/api/projects/${projectId}/items`, { headers: { cookie } })).json();
    expect(items.items.length).toBe(1);
    expect((await fetch(`${url}/api/projects/${projectId}/agents`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${url}/api/projects/${projectId}/schedule`, { headers: { cookie } })).status).toBe(200);

    // Open the stream before writing.
    const stream = await fetch(`${url}/api/projects/${projectId}/stream`, { headers: { cookie } });
    expect(stream.status).toBe(200);

    // The "drag": PATCH → 202 → one queued sync job.
    const patch = await fetch(`${url}/api/items/${itemId}/schedule`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ target_at: "2026-09-20" }),
    });
    expect(patch.status).toBe(202);

    // The github worker executes it through the real backbone against fake GitHub.
    expect(await drain()).toBe(1);
    const row = await db.servicePool.query("select target_at::text from work_items where id=$1", [itemId]);
    expect(row.rows[0].target_at).toBe("2026-09-20");

    // work.rescheduled hit the event log → SSE frame with the schedule scope.
    const reader = stream.body!.getReader();
    const deadline = Date.now() + 4000;
    let buf = "";
    let sawSchedule = false;
    while (!sawSchedule && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now())),
      ]);
      if (chunk.done) break;
      buf += new TextDecoder().decode(chunk.value);
      sawSchedule = buf.includes('"schedule"');
    }
    await reader.cancel().catch(() => {});
    expect(sawSchedule).toBe(true);

    // Re-read shows the new date (what the UI's invalidate-refetch would fetch).
    const after = await (await fetch(`${url}/api/projects/${projectId}/items`, { headers: { cookie } })).json();
    expect(after.items[0].target_at.slice(0, 10)).toBe("2026-09-20");
  });
});
