import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { createApp } from "./http.js";

let db: TestDb;
let appPool: pg.Pool;
let a: Awaited<ReturnType<typeof seedOrgWithUser>>;
let url: string;
let close: () => Promise<unknown>;
let cookie: string;
let csrf: string;

beforeAll(async () => {
  db = await createTestDatabase();
  a = await seedOrgWithUser(db.servicePool, "csrf");
  appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  const app = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "s", devAuth: true });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));

  const login = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "csrf@test.local" }),
  });
  const setCookies = login.headers.getSetCookie();
  cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  csrf = (await login.json()).csrf_token;
  expect(csrf.length).toBeGreaterThan(30);
});
afterAll(async () => { await close(); await appPool.end(); await db.teardown(); });

const item = async () => (await db.servicePool.query(
  "insert into work_items (organisation_id, project_id, title) values ($1,$2,'csrf item') returning id",
  [a.orgId, a.projectId])).rows[0].id;

const patch = (wi: string, headers: Record<string, string>) =>
  fetch(`${url}/api/items/${wi}/priority`, {
    method: "PATCH", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ priority: 1 }),
  });

describe("WL-5 csrf + origin", () => {
  it("mutation without the csrf header → 403", async () => {
    expect((await patch(await item(), { cookie })).status).toBe(403);
  });

  it("mutation with matching header+cookie passes", async () => {
    expect((await patch(await item(), { cookie, "x-csrf-token": csrf })).status).toBe(200);
  });

  it("mismatched token → 403", async () => {
    expect((await patch(await item(), { cookie, "x-csrf-token": "f".repeat(64) })).status).toBe(403);
  });

  it("cross-site Origin → 403 even with a valid token", async () => {
    expect((await patch(await item(), {
      cookie, "x-csrf-token": csrf, origin: "https://evil.test",
    })).status).toBe(403);
  });

  it("same-origin Origin header passes; GETs never require the token", async () => {
    expect((await patch(await item(), {
      cookie, "x-csrf-token": csrf, origin: url,
    })).status).toBe(200);
    const res = await fetch(`${url}/api/orgs`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});
