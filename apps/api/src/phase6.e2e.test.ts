import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { handleSyncJob, claimSyncJob, completeSyncJob } from "foreman-github/lib";
import { generateBrief, deliverBrief } from "foreman-gen/lib";
import { createApp } from "./http.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let url: string;
let cookie: string;
let csrf: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "phase6"));
  await db.servicePool.query(
    "update projects set gh_repos=array['o/r'], gh_installation_id=777, brief_email='pm@test.local' where id=$1",
    [projectId]);
  await db.servicePool.query(
    "insert into github_apps (app_id, slug, private_key_pem, webhook_secret) values (1,'p6','pem','whs')");
  await db.servicePool.query(
    "insert into github_installations (installation_id, app_id, organisation_id) values (777,1,$1)", [orgId]);

  const appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  const app = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "p6", devAuth: true });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = async () => { await new Promise((r) => server.close(r)); await appPool.end(); };

  const login = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "phase6@test.local" }),
  });
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  csrf = (await login.json()).csrf_token;
});
afterAll(async () => { await close(); await db.teardown(); });

describe("phase 6: hardened mutations, lifecycle to UI read, dual-channel briefs", () => {
  it("csrf-protected scan enqueue → github worker scans → lifecycle read shows states + gaps", async () => {
    // enqueue through the hardened api
    const scan = await fetch(`${url}/api/projects/${projectId}/lifecycle/scan`, {
      method: "POST", headers: { cookie, "x-csrf-token": csrf },
    });
    expect(scan.status).toBe(202);

    // drain with a stubbed github
    const files: Record<string, string> = {
      "openapi.json": JSON.stringify({ openapi: "3", paths: { "/pets": { get: {}, post: {} } } }),
      "src/app.ts": `app.post("/pets", async (req, res) => {\n  const p = await save(req.body);\n  res.json(p);\n});`,
      "tests/app.test.ts": `request(app).post("/pets")`,
    };
    const gh = {
      graphql: (async () => ({})) as any,
      rest: async (_a: number, _i: number, _m: string, path: string) => {
        if (path.includes("/git/trees/")) {
          return { status: 200, json: { tree: Object.keys(files).map((p) => ({ path: p, type: "blob" })) } };
        }
        const m = /\/contents\/(.+)$/.exec(path);
        const body = m !== null ? files[decodeURIComponent(m[1]!)] : undefined;
        return body === undefined ? { status: 404, json: {} }
          : { status: 200, json: { content: Buffer.from(body).toString("base64") } };
      },
    };
    const job = await claimSyncJob(db.servicePool);
    expect(job?.event_name).toBe("foreman.lifecycle_scan");
    await handleSyncJob(db.servicePool, job!, { gh });
    await completeSyncJob(db.servicePool, job!.id, true);

    const res = await (await fetch(`${url}/api/projects/${projectId}/lifecycle`, { headers: { cookie } })).json();
    const by = Object.fromEntries(res.endpoints.map((e: any) => [`${e.method} ${e.path}`, e.state]));
    expect(by["GET /pets"]).toBe("planned");
    expect(by["POST /pets"]).toBe("tested");
    expect(res.gaps.unimplemented).toBe(1);
  });

  it("a mutation without the csrf pair is rejected outright", async () => {
    const res = await fetch(`${url}/api/projects/${projectId}/lifecycle/scan`, {
      method: "POST", headers: { cookie },
    });
    expect(res.status).toBe(403);
  });

  it("brief generates once and delivers to webhook AND email; status surfaces in the list", async () => {
    const hits: string[] = [];
    await db.servicePool.query(
      "update projects set brief_webhook_url='https://hooks.test/b' where id=$1", [projectId]);
    const brief = await generateBrief(db.servicePool as pg.Pool, projectId);
    const sent: string[] = [];
    const channels = await deliverBrief(db.servicePool as pg.Pool, brief, {
      fetchImpl: (async (u: any) => { hits.push(String(u)); return new Response("{}", { status: 200 }); }) as typeof fetch,
      mailer: { send: async (to) => { sent.push(to); } },
    });
    expect(channels.sort()).toEqual(["email", "webhook"]);
    expect(hits).toEqual(["https://hooks.test/b"]);
    expect(sent).toEqual(["pm@test.local"]);

    const list = await (await fetch(`${url}/api/projects/${projectId}/briefs`, { headers: { cookie } })).json();
    expect(list.briefs[0].delivered.sort()).toEqual(["email", "webhook"]);
  });

  it("sealed app keys round-trip through the crypto seam", async () => {
    const { sealPem, openPem } = await import("foreman-github/lib");
    const key = crypto.randomBytes(32).toString("hex");
    const sealed = sealPem("-----KEY-----", key);
    await db.servicePool.query("update github_apps set private_key_pem=$1 where app_id=1", [sealed]);
    const row = await db.servicePool.query("select private_key_pem from github_apps where app_id=1");
    expect(row.rows[0].private_key_pem.startsWith("enc:v1:")).toBe(true);
    expect(openPem(row.rows[0].private_key_pem, key)).toBe("-----KEY-----");
  });
});
