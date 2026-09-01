import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { claimSyncJob, completeSyncJob, handleSyncJob } from "foreman-github/lib";
import { createApp as createMcpApp } from "foreman-mcp/lib";
import { createApp } from "./http.js";

let db: TestDb;
let orgId: string;
let projectId: string;
let url: string;
let mcpUrl: string;
let cookie: string;
let csrf: string;
const closers: Array<() => Promise<unknown>> = [];

const mut = () => ({ cookie, "x-csrf-token": csrf });

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "phase8"));
  await db.servicePool.query(
    "insert into github_apps (app_id, slug, private_key_pem, webhook_secret) values (8,'p8','pem','whs')");
  await db.servicePool.query(
    "insert into github_installations (installation_id, app_id, organisation_id, account_login) values (8888,8,$1,'acme')",
    [orgId]);

  const appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  closers.push(() => appPool.end());
  const app = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "p8", devAuth: true });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closers.push(() => new Promise((r) => server.close(r)));

  const mcp = createMcpApp(db.servicePool as pg.Pool);
  const mcpServer = mcp.listen(0);
  await new Promise((r) => mcpServer.once("listening", r));
  mcpUrl = `http://127.0.0.1:${(mcpServer.address() as { port: number }).port}/mcp`;
  closers.push(() => new Promise((r) => mcpServer.close(r)));

  const login = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "phase8@test.local" }),
  });
  cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  csrf = (await login.json()).csrf_token;
});
afterAll(async () => { for (const c of closers.reverse()) await c(); await db.teardown(); });

describe("phase 8 self-service loop", () => {
  it("settings → create via worker → agent works it → metrics → export", async () => {
    // 1. link repos + installation via the settings api (no SQL)
    const patch = await fetch(`${url}/api/projects/${projectId}/settings`, {
      method: "PATCH", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ gh_repos: ["acme/app"], gh_installation_id: 8888 }),
    });
    expect(patch.status).toBe(200);

    // 2. new item → 202 → github worker creates it (stub backbone doing the local insert)
    const post = await fetch(`${url}/api/projects/${projectId}/items`, {
      method: "POST", headers: { "content-type": "application/json", ...mut() },
      body: JSON.stringify({ title: "self-service item", acceptance: ["done right"] }),
    });
    expect(post.status).toBe(202);
    const job = await claimSyncJob(db.servicePool);
    expect(job?.event_name).toBe("foreman.create_item");
    const backbone = {
      createWorkItem: async (_p: any, item: any) => {
        const { enqueueWorkItem } = await import("@foreman/db");
        return { workItemId: (await enqueueWorkItem(db.servicePool, {
          organisationId: orgId, projectId, title: item.title, acceptance: item.acceptance ?? [] })).id };
      },
    } as any;
    await handleSyncJob(db.servicePool, job!, { backbone });
    await completeSyncJob(db.servicePool, job!.id, true);

    // 3. mint a token via the api; a real agent announces and completes the item
    const mint = await fetch(`${url}/api/projects/${projectId}/tokens`, { method: "POST", headers: mut() });
    const { token } = await mint.json();
    const client = new Client({ name: "p8-agent", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError ?? false).toBe(false);
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
    await call("foreman__agent_announce", { display_name: "p8-agent", platform: "test", capabilities: [] });
    const claim = await call("foreman__work_claim", {});
    expect(claim.work_item.title).toBe("self-service item");
    await call("foreman__work_complete", {
      work_item_id: claim.work_item.id, summary: "done",
      acceptance_results: [{ criterion: "done right", met: true }],
    });

    // 4. metrics reflect the supervised completion. The project is GitHub-connected
    // (step 1 set gh_installation_id), so throughput now measures merged-and-reviewed
    // PRs rather than bare acceptance verdicts — and this loop never merges a PR.
    const metrics = await (await fetch(`${url}/api/projects/${projectId}/metrics`, { headers: { cookie } })).json();
    expect(metrics.supervised_throughput.method).toBe("merged and reviewed");
    expect(metrics.supervised_throughput.this_week).toBe(0);
    expect(metrics.supervised_throughput.all_completions_this_week).toBe(1);
    expect(metrics.active_agents_24h).toBe(1);

    // 5. export carries the whole story
    const lines = (await (await fetch(`${url}/api/projects/${projectId}/export`, { headers: { cookie } })).text())
      .trim().split("\n").map((l) => JSON.parse(l));
    const types = new Set(lines.map((l) => l.type));
    for (const t of ["project.updated", "work.created", "work.claimed", "work.completed"]) {
      expect(types.has(t)).toBe(true);
    }
  });
});
