/* SPEC §10 load harness (Phase 7 Task 2). Assertions are exits.
 *
 *   1. Claim atomicity: 100 SDK clients churn 2,000 items to done; exactly
 *      2,000 work.claimed events (no double claims).
 *   2. p95 event→SSE < 2s during churn (deviation 1: report→frame is the
 *      honest ingest→UI proxy; the UI's follow-up GET is milliseconds).
 *   3. Rate backpressure at 2×: the 80% bucket admits ≤81 of 200 parallel
 *      calls, every excess throws RateLimitedError, nothing hangs.
 *
 * Run: pnpm --filter foreman-mcp test:load
 */
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestDatabase, seedOrgWithUser } from "@foreman/db/testing";
import { enqueueWorkItem } from "@foreman/db";
import { GithubClient, InMemoryKv, RateLimitedError } from "@foreman/github-client";
import { createApp as createApiApp, createEventHub } from "foreman-api/lib";
import { createApp as createMcpApp, createAgentToken } from "./../src/lib.js";

const N_AGENTS = 100;
const N_ITEMS = 2000;
const N_WAVE2 = 500;
const N_SAMPLES = 30;

function fail(msg: string): never { console.error(`✗ ${msg}`); process.exit(1); }
const ok = (msg: string) => console.log(`✓ ${msg}`);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function main(): Promise<void> {
  const db = await createTestDatabase();
  const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "load");
  await db.servicePool.query("update projects set wip_limit = 500 where id = $1", [projectId]);

  // servers
  const mcp = createMcpApp(db.servicePool as pg.Pool);
  const mcpServer = mcp.listen(0);
  await new Promise((r) => mcpServer.once("listening", r));
  const mcpUrl = `http://127.0.0.1:${(mcpServer.address() as { port: number }).port}/mcp`;

  const appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  const hub = await createEventHub(db.servicePool as pg.Pool);
  const api = createApiApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "load", devAuth: true, hub });
  const apiServer = api.listen(0);
  await new Promise((r) => apiServer.once("listening", r));
  const apiUrl = `http://127.0.0.1:${(apiServer.address() as { port: number }).port}`;

  // ---- seed 2,000 items ----------------------------------------------------
  const t0 = Date.now();
  for (let batch = 0; batch < N_ITEMS; batch += 500) {
    const values: string[] = [];
    const params: unknown[] = [orgId, projectId];
    for (let i = batch; i < Math.min(batch + 500, N_ITEMS); i++) {
      params.push(`load item ${i}`);
      values.push(`($1,$2,$${params.length},'queued')`);
    }
    await db.servicePool.query(
      `insert into work_items (organisation_id, project_id, title, status) values ${values.join(",")}`, params);
  }
  ok(`seeded ${N_ITEMS} items in ${Date.now() - t0}ms`);

  // ---- 100 agents ----------------------------------------------------------
  const agents: Array<{ client: Client; call: (n: string, a: Record<string, unknown>) => Promise<any> }> = [];
  for (let i = 0; i < N_AGENTS; i++) {
    const { token } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId });
    const client = new Client({ name: `load-${i}`, version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      if (r.isError === true) throw new Error(`${name} errored: ${(r.content as any[])[0]?.text}`);
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
    await call("foreman__agent_announce", { display_name: `load-${i}`, platform: "load", capabilities: [] });
    agents.push({ client, call });
  }
  ok(`${N_AGENTS} agents announced`);

  // ---- wave 1: churn to empty (claim atomicity) ----------------------------
  const t1 = Date.now();
  let completed = 0;
  await Promise.all(agents.map(async ({ call }) => {
    let empties = 0;
    while (empties < 2) {
      const claim = await call("foreman__work_claim", {});
      if (claim.status === "assigned") {
        empties = 0;
        await call("foreman__work_complete", {
          work_item_id: claim.work_item.id, summary: "load done", acceptance_results: [] });
        completed += 1;
      } else {
        empties += 1;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }));
  const wave1ms = Date.now() - t1;

  const notDone = await db.servicePool.query(
    "select count(*)::int as n from work_items where project_id=$1 and status <> 'done'", [projectId]);
  if (notDone.rows[0].n !== 0) fail(`${notDone.rows[0].n} items not done after churn`);
  const claims = await db.servicePool.query(
    "select count(*)::int as n from events where project_id=$1 and type='work.claimed'", [projectId]);
  if (claims.rows[0].n !== N_ITEMS) fail(`claim atomicity broken: ${claims.rows[0].n} work.claimed events for ${N_ITEMS} items`);
  ok(`wave 1: ${completed} completions by ${N_AGENTS} agents in ${(wave1ms / 1000).toFixed(1)}s ` +
    `(${(N_ITEMS / (wave1ms / 1000)).toFixed(0)} claims/sec), exactly ${N_ITEMS} work.claimed events`);

  // ---- wave 2: p95 report→SSE ---------------------------------------------
  const login = await fetch(`${apiUrl}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "load@test.local" }),
  });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const stream = await fetch(`${apiUrl}/api/projects/${projectId}/stream`, { headers: { cookie } });
  if (stream.status !== 200) fail(`sse stream refused: ${stream.status}`);

  const frames: Array<{ at: number; id: number }> = [];
  const reader = stream.body!.getReader();
  void (async () => {
    let buf = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buf += new TextDecoder().decode(chunk.value);
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sep); buf = buf.slice(sep + 2);
        const idLine = raw.split("\n").find((l) => l.startsWith("id: "));
        if (idLine !== undefined) frames.push({ at: Date.now(), id: Number(idLine.slice(4)) });
      }
    }
  })();

  for (let i = 0; i < N_WAVE2; i++) {
    await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: `wave2 ${i}`, acceptance: [] });
  }
  const churners = agents.slice(0, 20);
  const sampler = agents[20]!;
  const churn = Promise.all(churners.map(async ({ call }) => {
    let empties = 0;
    while (empties < 2) {
      const claim = await call("foreman__work_claim", {});
      if (claim.status === "assigned") {
        empties = 0;
        await call("foreman__work_report", { work_item_id: claim.work_item.id, progress_note: "churning" });
        await call("foreman__work_complete", {
          work_item_id: claim.work_item.id, summary: "done", acceptance_results: [] });
      } else { empties += 1; await new Promise((r) => setTimeout(r, 25)); }
    }
  }));

  // serialized samples while churn runs: report → first frame with a NEW id
  const latencies: number[] = [];
  const sampleItem = await enqueueWorkItem(db.servicePool, {
    organisationId: orgId, projectId, title: "sampler item", acceptance: [] });
  // sampler claims until it gets ITS item (any item works — it just needs one to report on)
  let sClaim = await sampler.call("foreman__work_claim", {});
  while (sClaim.status !== "assigned") { await new Promise((r) => setTimeout(r, 25)); sClaim = await sampler.call("foreman__work_claim", {}); }
  void sampleItem;
  for (let s = 0; s < N_SAMPLES; s++) {
    const lastId = frames.length > 0 ? frames[frames.length - 1]!.id : 0;
    const sendAt = Date.now();
    await sampler.call("foreman__work_report", { work_item_id: sClaim.work_item.id, progress_note: `sample ${s}` });
    // the report's event is committed; the next frame with a newer cursor covers it
    const deadline = Date.now() + 5000;
    let arrival: number | null = null;
    while (arrival === null && Date.now() < deadline) {
      const hit = frames.find((f) => f.at >= sendAt && f.id > lastId);
      if (hit !== undefined) arrival = hit.at;
      else await new Promise((r) => setTimeout(r, 10));
    }
    if (arrival === null) fail(`sample ${s}: no SSE frame within 5s of report`);
    latencies.push(arrival - sendAt);
    await new Promise((r) => setTimeout(r, 50));
  }
  await churn;
  await reader.cancel().catch(() => {});

  const p50 = pct(latencies, 50), p95 = pct(latencies, 95), max = Math.max(...latencies);
  console.log(`  event→sse: p50 ${p50}ms · p95 ${p95}ms · max ${max}ms over ${latencies.length} samples (churn: 20 agents)`);
  if (p95 >= 2000) fail(`p95 event→sse ${p95}ms breaches the 2s bar (§10)`);
  ok(`p95 event→sse ${p95}ms < 2000ms`);

  // ---- rate backpressure at 2× --------------------------------------------
  const kv = new InMemoryKv();
  let fetches = 0;
  const gh = new GithubClient({
    tokens: { token: async () => "ghs_load" } as any, kv, apiBase: "https://gh.load",
    fetchImpl: (async () => {
      fetches += 1;
      return new Response("{}", { status: 200, headers: {
        "x-ratelimit-limit": "100", "x-ratelimit-remaining": "99",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } });
    }) as typeof fetch,
  });
  await gh.rest(1, 9, "GET", "/prime"); // observe the limit
  const results = await Promise.allSettled(
    Array.from({ length: 200 }, (_, i) => gh.rest(1, 9, "GET", `/burst/${i}`)));
  const rejected = results.filter((r) => r.status === "rejected");
  const nonRate = rejected.filter((r) => !((r as PromiseRejectedResult).reason instanceof RateLimitedError));
  if (nonRate.length > 0) fail(`unexpected error kinds under backpressure: ${nonRate.length}`);
  if (fetches > 81) fail(`bucket admitted ${fetches} calls; 80% of 100 allows ≤81 including the primer`);
  ok(`backpressure at 2×: ${fetches - 1}/200 admitted, ${rejected.length} rejected as RateLimitedError, none hung`);

  console.log("\nLOAD HARNESS PASSED (§10)");
  await hub.close();
  mcpServer.close();
  apiServer.close();
  await appPool.end();
  await db.teardown().catch(() => {});
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
