import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import { scanLifecycle } from "./scan.js";
import { handleSyncJob } from "../handlers/index.js";
import { seedGithubApp } from "../testing.js";
import type { SyncJob } from "../jobs.js";

let db: TestDb;
let orgId: string;
let projectId: string;

const EXPRESS_SRC = `
const app = require("express")();
app.get('/health', (req, res) => res.json({ ok: true }));
app.post("/users", async (req, res) => {
  const u = await createUser(req.body);
  res.status(201).json(u);
});
`;
const EXPRESS_SRC_V2 = `
const app = require("express")();
app.post("/users", async (req, res) => {
  const u = await createUser(req.body);
  res.status(201).json(u);
});
`;
const SPEC = JSON.stringify({ openapi: "3.0.0", paths: { "/users": { get: {}, post: {} } } });
const TEST_SRC = `it("creates", () => request(app).post("/users").expect(201));`;

function ghStub(files: Record<string, string>) {
  return {
    graphql: (async () => ({})) as any,
    rest: async (_a: number, _i: number, _m: string, path: string) => {
      if (path.includes("/git/trees/")) {
        return { status: 200, json: { tree: Object.keys(files).map((p) => ({ path: p, type: "blob" })) } };
      }
      const m = /\/contents\/(.+)$/.exec(path);
      const file = m !== null ? files[decodeURIComponent(m[1]!)] : undefined;
      if (file === undefined) return { status: 404, json: {} };
      return { status: 200, json: { content: Buffer.from(file).toString("base64") } };
    },
  };
}

const FILES = {
  "openapi.json": SPEC,
  "src/server.ts": EXPRESS_SRC,
  "tests/server.test.ts": TEST_SRC,
};

async function project() {
  return (await db.servicePool.query("select * from projects where id=$1", [projectId])).rows[0];
}

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "lifecycle"));
  await seedGithubApp(db.servicePool, orgId);
  await db.servicePool.query(
    "update projects set gh_repos=array['o/r'], gh_installation_id=777 where id=$1", [projectId]);
  await db.servicePool.query(
    "insert into work_items (organisation_id, project_id, title) values ($1,$2,'implement POST /users endpoint')",
    [orgId, projectId]);
});
afterAll(async () => { await db.teardown(); });

describe("scanLifecycle (LFC-1/2/3)", () => {
  it("routes rails and java files to their extractors", async () => {
    const files = {
      "config/routes.rb": `Rails.application.routes.draw do\n  get "ping", to: "x#y"\nend`,
      "src/main/java/OrderController.java":
        `@RequestMapping("/api/v1")\npublic class C {\n  @PostMapping("/orders")\n  public void create() { svc.go(); }\n}`,
    };
    const { orgId: o2, projectId: p2 } = await seedOrgWithUser(db.servicePool, "lc-mixed");
    await seedGithubApp(db.servicePool, o2, 2, 888);
    await db.servicePool.query(
      "update projects set gh_repos=array['m/x'], gh_installation_id=888 where id=$1", [p2]);
    const proj = (await db.servicePool.query("select * from projects where id=$1", [p2])).rows[0];
    const r = await scanLifecycle(db.servicePool, ghStub(files) as any, proj);
    expect(r.found).toBe(2);
    const rows = await db.servicePool.query(
      "select method, path from endpoints where project_id=$1 order by path", [p2]);
    expect(rows.rows.map((x: any) => `${x.method} ${x.path}`)).toEqual(["POST /api/v1/orders", "GET /ping"]);
  });

  it("first scan produces evidence-backed states", async () => {
    const r = await scanLifecycle(db.servicePool, ghStub(FILES) as any, await project());
    expect(r.found).toBe(3); // GET /users (spec), POST /users, GET /health
    const rows = await db.servicePool.query(
      "select method, path, state, in_spec, has_impl, has_test, evidence, work_item_ids from endpoints where project_id=$1 order by path, method",
      [projectId]);
    const by = Object.fromEntries(rows.rows.map((r: any) => [`${r.method} ${r.path}`, r]));
    expect(by["GET /health"]).toMatchObject({ state: "stubbed", in_spec: false, has_impl: true });
    expect(by["GET /users"]).toMatchObject({ state: "planned", in_spec: true, has_impl: false });
    expect(by["POST /users"]).toMatchObject({ state: "tested", in_spec: true, has_impl: true, has_test: true });
    expect(by["POST /users"].evidence.some((e: any) => e.kind === "impl" && e.ref === "src/server.ts")).toBe(true);
    expect(by["POST /users"].work_item_ids.length).toBe(1); // LFC-3 heuristic
    expect((await db.servicePool.query(
      "select 1 from events where type='lifecycle.scanned' and project_id=$1", [projectId])).rowCount).toBe(1);
  });

  it("a second identical scan changes nothing", async () => {
    const r = await scanLifecycle(db.servicePool, ghStub(FILES) as any, await project());
    expect(r.changed).toBe(0);
  });

  it("a vanished endpoint becomes deprecated", async () => {
    const r = await scanLifecycle(db.servicePool,
      ghStub({ ...FILES, "src/server.ts": EXPRESS_SRC_V2 }) as any, await project());
    expect(r.changed).toBeGreaterThanOrEqual(1);
    const row = await db.servicePool.query(
      "select state from endpoints where project_id=$1 and path='/health'", [projectId]);
    expect(row.rows[0].state).toBe("deprecated");
  });

  it("deployment_status success promotes implemented/tested endpoints (LFC-5)", async () => {
    // restore /health etc. then deploy
    await scanLifecycle(db.servicePool, ghStub(FILES) as any, await project());
    const job: SyncJob = {
      id: "d1", organisation_id: orgId, installation_id: 777, delivery_id: "dep-1",
      event_name: "deployment_status", action: "created", status: "running", attempts: 1,
      payload: {
        action: "created",
        deployment_status: { state: "success" },
        deployment: { id: 4321, sha: "deadbeef" },
        repository: { full_name: "o/r" },
        installation: { id: 777 },
      },
    };
    await handleSyncJob(db.servicePool, job, {});
    const rows = await db.servicePool.query(
      "select method, path, state from endpoints where project_id=$1 order by path, method", [projectId]);
    const by = Object.fromEntries(rows.rows.map((r: any) => [`${r.method} ${r.path}`, r.state]));
    expect(by["POST /users"]).toBe("deployed");
    expect(by["GET /users"]).toBe("planned"); // spec-only never deploys
    expect((await db.servicePool.query(
      "select 1 from events where type='deploy.succeeded' and project_id=$1", [projectId])).rowCount).toBe(1);
  });
});
