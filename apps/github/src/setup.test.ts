import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import type pg from "pg";
import { mountSetup, signState } from "./setup.js";

let db: TestDb;
let orgId: string;
let url: string;
let close: () => Promise<unknown>;
const fetched: Array<{ url: string; method: string }> = [];

const SECRET = "state-secret";

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId } = await seedOrgWithUser(db.servicePool, "setup-org"));
  const app = express();
  mountSetup(app, {
    pool: db.servicePool as pg.Pool,
    secret: SECRET,
    githubBase: "https://gh.test",
    apiBase: "https://api.gh.test",
    publicUrl: "https://foreman.test",
    fetchImpl: (async (u: any, init: any) => {
      fetched.push({ url: String(u), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({
        id: 4242, slug: "foreman-setup-org", pem: "-----FAKE PEM-----",
        webhook_secret: "converted-whsec", client_id: "cid", client_secret: "csec",
      }), { status: 201 });
    }) as typeof fetch,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));
});
afterAll(async () => { await close(); await db.teardown(); });

describe("WL-6 manifest flow", () => {
  it("start page renders the manifest form aimed at the GitHub org", async () => {
    const res = await fetch(`${url}/setup/github/start?org_slug=setup-org&gh_org=acme`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("https://gh.test/organizations/acme/settings/apps/new");
    expect(html).toContain("https://foreman.test/webhook");
    expect(html).toContain("projects_v2_item");
  });

  it("unknown org slug → 404", async () => {
    expect((await fetch(`${url}/setup/github/start?org_slug=nope&gh_org=acme`)).status).toBe(404);
  });

  it("callback converts the code, stores the app, redirects to install", async () => {
    const state = signState(orgId, SECRET);
    const res = await fetch(`${url}/setup/github/callback?code=tmp123&state=${encodeURIComponent(state)}`,
      { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location"))
      .toBe(`https://gh.test/apps/foreman-setup-org/installations/new?state=${encodeURIComponent(state)}`);
    expect(fetched).toEqual([{ url: "https://api.gh.test/app-manifests/tmp123/conversions", method: "POST" }]);
    const row = await db.servicePool.query("select * from github_apps where app_id = 4242");
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]).toMatchObject({
      organisation_id: orgId, slug: "foreman-setup-org",
      private_key_pem: "-----FAKE PEM-----", webhook_secret: "converted-whsec",
      client_id: "cid", client_secret: "csec",
    });
  });

  it("tampered state → 401, nothing stored", async () => {
    const bad = signState(orgId, SECRET).slice(0, -2) + "ff";
    const res = await fetch(`${url}/setup/github/callback?code=x&state=${encodeURIComponent(bad)}`);
    expect(res.status).toBe(401);
  });

  it("install-callback links the installation to the org's app", async () => {
    const state = signState(orgId, SECRET);
    const res = await fetch(`${url}/setup/github/install-callback?installation_id=9977&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    const row = await db.servicePool.query(
      "select app_id, organisation_id from github_installations where installation_id = 9977");
    expect(row.rowCount).toBe(1);
    expect(Number(row.rows[0].app_id)).toBe(4242);
    expect(row.rows[0].organisation_id).toBe(orgId);
  });
});
