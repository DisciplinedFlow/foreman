/* First-ever browser smoke + the GNT-9 scroll harness (Phase 6 Task 10).
 *
 * Boots: throwaway Postgres DB (seeded: 1 user, 1 project, 2,000 dated work
 * items in a dependency chain, 3 agents) → foreman-api on :3003 → `vite
 * preview` (built app, /api+/auth proxied). Then chromium walks the real UI:
 * login → project → Gantt (virtualisation bound) → Agents → Overview →
 * scripted scroll sampling requestAnimationFrame deltas.
 *
 * Run: pnpm --filter foreman-web test:e2e   (playwright chromium must be installed)
 * Deviation 5: asserts a 30fps floor + ≤80 rendered bars; reports the fps.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";
import { createTestDatabase, seedOrgWithUser } from "@foreman/db/testing";
import { createApp } from "foreman-api/lib";

const API_PORT = 3003;
const WEB_PORT = 4173;

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
const ok = (msg: string) => console.log(`✓ ${msg}`);

async function waitFor(url: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server at ${url} never came up`);
}

async function main(): Promise<void> {
  // ---- seed ----------------------------------------------------------------
  const db = await createTestDatabase();
  const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "smoke");
  const items: string[] = [];
  const values: string[] = [];
  const params: unknown[] = [orgId, projectId];
  for (let i = 0; i < 2000; i++) {
    const start = new Date(Date.UTC(2026, 8, 1 + (i % 200)));
    const end = new Date(start.getTime() + 86400000 * (1 + (i % 5)));
    params.push(`item ${i}`, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
    values.push(`($1,$2,$${params.length - 2},$${params.length - 1},$${params.length})`);
  }
  const inserted = await db.servicePool.query(
    `insert into work_items (organisation_id, project_id, title, start_at, target_at) values ${values.join(",")} returning id`,
    params);
  for (const r of inserted.rows) items.push(r.id);
  // a dependency chain across the first 50 items
  for (let i = 1; i < 50; i++) {
    await db.servicePool.query(
      "insert into work_item_deps (organisation_id, blocked_id, blocker_id) values ($1,$2,$3)",
      [orgId, items[i], items[i - 1]]);
  }
  for (const name of ["smoke-1", "smoke-2", "smoke-3"]) {
    await db.servicePool.query(
      "insert into agents (organisation_id, project_id, display_name, platform, status) values ($1,$2,$3,'claude-code','working')",
      [orgId, projectId, name]);
  }
  ok(`seeded 2000 items, 49 deps, 3 agents (db ${db.url.split("/").pop()})`);

  // ---- servers -------------------------------------------------------------
  const appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  const api = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "smoke", devAuth: true });
  const apiServer = api.listen(API_PORT);
  await new Promise((r) => apiServer.once("listening", r));
  ok(`api on :${API_PORT}`);

  const preview: ChildProcess = spawn(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["exec", "vite", "preview", "--port", String(WEB_PORT), "--strictPort"],
    { cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), stdio: "pipe", shell: true });
  await waitFor(`http://localhost:${WEB_PORT}/`);
  ok(`vite preview on :${WEB_PORT}`);

  const cleanup = async () => {
    preview.kill();
    apiServer.close();
    await appPool.end();
    await db.teardown().catch(() => {});
  };

  try {
    // ---- browser -----------------------------------------------------------
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await page.goto(`http://localhost:${WEB_PORT}/login`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel(/email/i).fill("smoke@test.local");
    await page.getByRole("button", { name: /log in/i }).click();
    await page.waitForURL(`http://localhost:${WEB_PORT}/`);
    ok("login round-trips");

    await page.getByRole("link", { name: "smoke-project" }).click();
    // the SSE stream keeps a connection open, so networkidle never settles —
    // wait for the bars themselves
    await page.waitForSelector("[data-item-id]", { timeout: 15_000 });
    const bars = await page.locator("[data-item-id]").count();
    if (bars === 0) fail("no gantt bars rendered");
    if (bars > 80) fail(`virtualisation broken: ${bars} bars in the DOM at 2,000 rows`);
    ok(`gantt renders ${bars} bars for 2,000 items (virtualised)`);
    const arrows = await page.locator("[data-arrow]").count();
    if (arrows === 0) fail("no dependency arrows rendered");
    ok(`${arrows} dependency arrows visible`);

    // ---- GNT-9 scripted scroll --------------------------------------------
    // NB: passed as a source string — tsx's esbuild transform injects a __name
    // helper that doesn't exist inside the browser context.
    const perf = await page.evaluate(`(async () => {
      const el = document.querySelector('[data-testid="gantt-scroll"]');
      if (el === null) return null;
      const deltas = [];
      let last = performance.now();
      let running = true;
      const sample = (t) => { deltas.push(t - last); last = t; if (running) requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
      const totalH = el.scrollHeight;
      const steps = 90;
      for (let i = 0; i <= steps; i++) {
        el.scrollTop = (totalH * i) / steps;
        await new Promise((r) => setTimeout(r, 33));
      }
      running = false;
      deltas.shift();
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const worst = Math.max(...deltas);
      return { mean, worst, frames: deltas.length };
    })()`) as { mean: number; worst: number; frames: number } | null;
    if (perf === null) fail("gantt scroll container not found");
    const fps = 1000 / perf.mean;
    console.log(`  scroll: mean frame ${perf.mean.toFixed(1)}ms (${fps.toFixed(0)}fps), worst ${perf.worst.toFixed(1)}ms over ${perf.frames} frames`);
    if (perf.mean > 33) fail(`mean frame time ${perf.mean.toFixed(1)}ms breaches the 30fps floor (GNT-9)`);
    ok(`GNT-9 scroll harness: ${fps.toFixed(0)}fps mean (target 60, floor 30)`);

    await page.getByRole("button", { name: "Agents" }).click();
    await page.waitForSelector("table");
    const agentRows = await page.locator("tbody tr").count();
    if (agentRows !== 3) fail(`expected 3 agent rows, saw ${agentRows}`);
    ok("agents tab lists the fleet");

    await page.getByRole("button", { name: "Overview" }).click();
    await page.getByRole("button", { name: /regenerate/i }).waitFor();
    ok("overview tab reachable");

    await page.getByRole("button", { name: "Lifecycle" }).click();
    await page.getByRole("button", { name: /rescan/i }).waitFor();
    ok("lifecycle tab reachable");

    await browser.close();
    console.log("\nBROWSER SMOKE PASSED");
  } finally {
    await cleanup();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
