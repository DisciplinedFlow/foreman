import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import type pg from "pg";
import { createReceiver } from "./receiver.js";
import { claimSyncJob, completeSyncJob } from "./jobs.js";
import { signedHeaders, seedGithubApp } from "./testing.js";

let db: TestDb;
let orgId: string;
let url: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId } = await seedOrgWithUser(db.servicePool, "receiver"));
  await seedGithubApp(db.servicePool, orgId);
  const app = createReceiver({ pool: db.servicePool as pg.Pool });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  url = `http://127.0.0.1:${port}/webhook`;
  close = () => new Promise((r) => server.close(r));
});
afterAll(async () => { await close(); await db.teardown(); });

const post = (body: string, headers: Record<string, string>) =>
  fetch(url, { method: "POST", body, headers });

describe("webhook receiver (GHA-2)", () => {
  it("valid signature + known installation → 200, one sync_jobs row with the org id", async () => {
    const body = JSON.stringify({ action: "opened", installation: { id: 777 }, issue: { number: 1 } });
    const res = await post(body, signedHeaders("whsec", body));
    expect(res.status).toBe(200);
    const rows = await db.servicePool.query("select * from sync_jobs where event_name='issues'");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].organisation_id).toBe(orgId);
    expect(rows.rows[0].action).toBe("opened");
  });

  it("tampered body → 401, no extra rows", async () => {
    const body = JSON.stringify({ action: "opened", installation: { id: 777 } });
    const headers = signedHeaders("whsec", body);
    const res = await post(body.replace("opened", "closed"), headers);
    expect(res.status).toBe(401);
  });

  it("same X-GitHub-Delivery twice → second is deduped, still one row", async () => {
    const body = JSON.stringify({ action: "labeled", installation: { id: 777 } });
    const headers = signedHeaders("whsec", body, { "x-github-event": "issues2" });
    expect((await post(body, headers)).status).toBe(200);
    const second = await post(body, headers);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ deduped: true });
    const rows = await db.servicePool.query("select 1 from sync_jobs where event_name='issues2'");
    expect(rows.rowCount).toBe(1);
  });

  it("unknown installation → 202 unrouted, no rows", async () => {
    const body = JSON.stringify({ action: "opened", installation: { id: 999999 } });
    const res = await post(body, signedHeaders("whsec", body, { "x-github-event": "issues3" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ unrouted: true });
    const rows = await db.servicePool.query("select 1 from sync_jobs where event_name='issues3'");
    expect(rows.rowCount).toBe(0);
  });

  it("claim/complete: two queued jobs claim in id order, third claim → null", async () => {
    await db.servicePool.query("delete from sync_jobs");
    for (const n of [1, 2]) {
      const body = JSON.stringify({ action: `a${n}`, installation: { id: 777 } });
      await post(body, signedHeaders("whsec", body, { "x-github-event": "queue-test" }));
    }
    const j1 = await claimSyncJob(db.servicePool);
    const j2 = await claimSyncJob(db.servicePool);
    expect(j1).not.toBeNull();
    expect(j2).not.toBeNull();
    expect(Number(j1!.id)).toBeLessThan(Number(j2!.id));
    expect(j1!.status).toBe("running");
    expect(await claimSyncJob(db.servicePool)).toBeNull();
    await completeSyncJob(db.servicePool, j1!.id, true);
    await completeSyncJob(db.servicePool, j2!.id, false);
    const s = await db.servicePool.query("select id, status from sync_jobs order by id");
    expect(s.rows.map((r: any) => r.status)).toEqual(["done", "queued"]);
  });
});
