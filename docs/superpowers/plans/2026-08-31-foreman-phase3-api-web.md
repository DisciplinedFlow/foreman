# Foreman Phase 3 — API BFF + React UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the fleet visible — `apps/api` (REST + SSE BFF reading projections under RLS) and `apps/web` (React UI with the Agent View table and a custom virtualised SVG Gantt: bars, dependency arrows, critical path, drag-to-reschedule writing back through the Phase 2 sync path), plus the GitHub App manifest-flow onboarding endpoints deferred from Phase 2.

**Architecture:** `apps/api` is a thin Express BFF. Every user-facing read runs as the `foreman_app` role inside a transaction with `set_config('app.user_id', …, true)` so **RLS does the tenant scoping, not query WHERE clauses**. Writes from the UI never touch GitHub: the schedule PATCH enqueues a `sync_jobs` row (`foreman.schedule_write`) that the existing `apps/github` worker executes through `GithubBackbone.updateSchedule` — credentials stay in the github service (SPEC §1.1). Live updates are one SSE stream per project fed by the 0004 `foreman_events` NOTIFY trigger, resumable with `Last-Event-ID`. `apps/web` is Vite + React; the Gantt is a pure layout engine (date→x, windowing, orthogonal arrow routing — unit-testable without a DOM) under a thin SVG component.

**Tech Stack:** TypeScript strict ESM, Node ≥22, Express 4, `pg`, `zod` (all already in the workspace). New: React 18.3, Vite ^6, react-router-dom ^6.28, and for tests `@testing-library/react` ^16 + `jsdom` under the existing Vitest 3.

**Spec:** `docs/SPEC-Foreman.md` §1.1 (`foreman-api` reads projections), §1.3 (one-way rule), §7 (frontend notes), §5.6/WL-6 (manifest flow); `docs/PRD-Foreman.md` §2.3 (GNT-1..9), §2.4 (AVW-1..7). Phase 2 plan: `docs/superpowers/plans/2026-08-31-foreman-phase2-github-sync.md`.

## Global Constraints

Everything from the Phase 1/2 plans still holds (event-per-mutation, X-6 parameterised SQL only, X-2 idempotency, WL-7 RLS guard, conventional commits, one commit per green TDD cycle). New for Phase 3:

- **RLS is the authorisation layer** (§2.3): `apps/api` queries run as `foreman_app` with the `app.user_id` GUC set `local` per transaction. The service role is used ONLY for the SSE NOTIFY listener connection and session-cookie user lookup — never to serve user-visible rows.
- **One-way rule** (§1.3): `apps/api` reads core tables + `proj_*` and writes only `sync_jobs` (and nothing in `apps/web` talks to Postgres). `apps/api` holds **no GitHub credentials** — the manifest/onboarding endpoints live in `apps/github`, which owns all GitHub credentials (§1.1).
- **SSE per §7**: one stream per open project; messages are *invalidation deltas* (`{scope, last_event_id}`), not raw events; reconnect resumes from `Last-Event-ID`. (Deviation 3 below.)
- **Cookies**: session cookie is `HttpOnly; SameSite=Lax; Path=/` from day one. `__Host-` prefix, `Secure`, Origin validation and CSRF tokens arrive with hosted deployment (WL-5 is a hosted-multi-tenant concern; dev login is env-gated — deviation 1).
- **Gantt is custom SVG** (§1.2): no Gantt library, no chart library. Layout is pure functions in `apps/web/src/gantt/layout.ts`; components only render precomputed geometry.
- **Untrusted text everywhere** (X-6): agent/GitHub-authored strings (titles, intents, display names) render as React text nodes only — never `dangerouslySetInnerHTML`.

### Documented deviations from the SPEC (decided here, reviewers take note)

1. **Auth is a dev-login** (`POST /auth/dev-login {email}`, enabled unless `NODE_ENV==='production'`): looks up an existing user by email, sets a signed HMAC cookie. Real IdP/session machinery belongs to the control plane (out of scope until the hosted phase). RLS still fully enforced per request.
2. **Deferred to Phase 4+** per the §9 build plan: comm graph (AVW-2), stall detection (AVW-3, scheduler work), cost roll-ups beyond per-agent run sums (AVW-4), agent actions (AVW-5), redaction config (AVW-6), forecast band (GNT-7), iteration/sprint lanes (GNT-1 — bars come from `start_at`/`target_at` which Phase 2 already syncs from date *and* iteration fields), 60fps@2,000-rows scripted scroll (GNT-9 — virtualisation ships now, the perf harness later), theming tokens (WL-2/3), `packages/ui`/`packages/theme`.
3. **SSE carries invalidation deltas, not row deltas.** On NOTIFY the api maps new events to `{scope: "items"|"schedule"|"agents", last_event_id}` and the client refetches that resource. Replay-safe, tiny, and avoids duplicating projection logic in the BFF. Row-level deltas are an optimisation for later.
4. **Schedule write-back is asynchronous.** PATCH returns `202 {queued: true}`; the UI keeps the dragged position optimistically and the SSE invalidate (from `work.rescheduled`) confirms it. The github worker is the single GitHub writer.
5. **Manifest onboarding stores the PEM in `github_apps`** exactly like the Phase 2 seed script (KMS is a hardening task). The conversion endpoint requires no GitHub auth, so `apps/github` hosts the whole flow; `apps/web` links to it.

## File structure

```
apps/api/                                  # foreman-api (BFF)
  package.json / tsconfig.json             # copy shape from apps/mcp
  src/auth.ts        # signCookie/verifyCookie (HMAC), devLogin handler
  src/rls.ts         # withUser(pool, userId, fn) — foreman_app + GUC transaction
  src/routes.ts      # REST endpoints
  src/stream.ts      # SSE endpoint + NOTIFY listener
  src/http.ts        # createApp(deps) — wires the above (test seam)
  src/main.ts        # listener
  src/*.test.ts
apps/github/src/handlers/schedule-write.ts # foreman.schedule_write job handler
apps/github/src/setup.ts                   # WL-6 manifest flow endpoints
apps/web/                                  # React UI
  package.json / tsconfig.json / vite.config.ts / index.html
  src/main.tsx / src/App.tsx               # router shell
  src/api.ts         # typed fetch client + SSE hook
  src/pages/Login.tsx / Projects.tsx / ProjectView.tsx
  src/agents/AgentTable.tsx
  src/gantt/layout.ts      # PURE: scale, rows, windowing, arrow routing, types
  src/gantt/Gantt.tsx      # SVG renderer + virtualised scroller
  src/gantt/drag.ts        # PURE: pointer-delta → new dates
  src/**/*.test.ts(x)
```

---

### Task 1: `apps/api` scaffold — session cookie + RLS query seam

**Files:**
- Create: `apps/api/package.json`, `tsconfig.json` (copy shape from `apps/mcp`; deps: `express`, `pg`, `zod`, workspace `@foreman/db` + `@foreman/events`; devDeps `@types/express`, `@types/pg`, `tsx`, `typescript`, `vitest`)
- Create: `apps/api/src/auth.ts`, `src/rls.ts`
- Test: `apps/api/src/auth.test.ts`, `src/rls.test.ts`

**Interfaces:**
- Produces:
  - `signSession(userId: string, secret: string): string` / `verifySession(cookie: string | undefined, secret: string): string | null` — value `${userId}.${hex hmac-sha256(userId, secret)}`, verified with `crypto.timingSafeEqual` (length-checked), null on any mismatch/malformation.
  - `withUser<T>(pool: pg.Pool, userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>` — `begin` → `select set_config('app.user_id', $1, true)` → `fn(client)` → `commit` (rollback + rethrow on error). The pool passed in production connects as **foreman_app**.
  - `COOKIE_NAME = "fmn_session"`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/auth.test.ts
import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./auth.js";

describe("session cookie", () => {
  it("round-trips and rejects tampering", () => {
    const c = signSession("11111111-1111-1111-1111-111111111111", "s3cret");
    expect(verifySession(c, "s3cret")).toBe("11111111-1111-1111-1111-111111111111");
    expect(verifySession(c, "wrong")).toBeNull();
    expect(verifySession(c.replace("1", "2"), "s3cret")).toBeNull();
    expect(verifySession(undefined, "s3cret")).toBeNull();
    expect(verifySession("garbage", "s3cret")).toBeNull();
  });
});
```

```ts
// apps/api/src/rls.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { withUser } from "./rls.js";

let db: TestDb; let appPool: pg.Pool;
let a: Awaited<ReturnType<typeof seedOrgWithUser>>;
let b: Awaited<ReturnType<typeof seedOrgWithUser>>;

beforeAll(async () => {
  db = await createTestDatabase();
  a = await seedOrgWithUser(db.servicePool, "rls-a");
  b = await seedOrgWithUser(db.servicePool, "rls-b");
  appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
});
afterAll(async () => { await appPool.end(); await db.teardown(); });

describe("withUser RLS scoping", () => {
  it("user A sees org A's projects and not org B's", async () => {
    const rows = await withUser(appPool, a.userId, async (tx) =>
      (await tx.query("select id from projects")).rows.map((r: any) => r.id));
    expect(rows).toContain(a.projectId);
    expect(rows).not.toContain(b.projectId);
  });
  it("the GUC does not leak across withUser calls on the same pool", async () => {
    await withUser(appPool, a.userId, async () => {});
    const rows = await withUser(appPool, b.userId, async (tx) =>
      (await tx.query("select id from projects")).rows.map((r: any) => r.id));
    expect(rows).toEqual([b.projectId]);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `pnpm install && pnpm --filter foreman-api test` → module not found.
- [ ] **Step 3: Implement**

```ts
// apps/api/src/auth.ts
import crypto from "node:crypto";

export const COOKIE_NAME = "fmn_session";

const hmac = (v: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(v).digest("hex");

export function signSession(userId: string, secret: string): string {
  return `${userId}.${hmac(userId, secret)}`;
}

export function verifySession(cookie: string | undefined, secret: string): string | null {
  if (cookie === undefined) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = cookie.slice(0, dot);
  const got = Buffer.from(cookie.slice(dot + 1));
  const expected = Buffer.from(hmac(userId, secret));
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  return userId;
}
```

```ts
// apps/api/src/rls.ts
import type pg from "pg";
import type { Queryable } from "@foreman/db";

// The authorisation layer: every user-facing read runs as foreman_app with the
// app.user_id GUC set LOCAL to one transaction. RLS scopes rows; SQL never does.
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: PASS + typecheck** — `pnpm --filter foreman-api test && pnpm --filter foreman-api typecheck`.
- [ ] **Step 5: Commit** — `git add apps/api pnpm-lock.yaml && git commit -m "feat(api): scaffold with HMAC session cookie and RLS withUser seam"`

---

### Task 2: REST read endpoints

**Files:**
- Create: `apps/api/src/http.ts`, `src/routes.ts`, `src/main.ts`
- Test: `apps/api/src/routes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`withUser`, `verifySession`, `signSession`, `COOKIE_NAME`).
- Produces: `createApp(deps: { appPool: pg.Pool; servicePool: pg.Pool; secret: string; devAuth: boolean }): express.Express` with JSON routes (all reads via `withUser`; 401 without a valid cookie):
  - `POST /auth/dev-login {email}` → looks up `users` by email on **servicePool** (RLS would hide the user pre-auth), 404 unknown, sets `fmn_session` cookie `HttpOnly; SameSite=Lax; Path=/`, returns `{user_id}`. Mounted only when `devAuth`.
  - `GET /api/orgs` → `select id, slug from organisations` (RLS-scoped) → `{orgs}`.
  - `GET /api/orgs/:orgId/projects` → `{projects: [{id, name, gh_repos, gh_project_node_id, wip_limit}]}`.
  - `GET /api/projects/:id` → project row + `proj_project_health` (left join; `health: null` when absent) — 404 when RLS hides it.
  - `GET /api/projects/:id/items` → `{items, deps}`: all `work_items` columns the UI needs (`id, title, status, kind, priority, parent_id, gh_issue_number, gh_repo, start_at, target_at, claimed_by, updated_at`) ordered by `enqueued_at`, and `work_item_deps` rows (`blocked_id, blocker_id`) for the project.
  - `GET /api/projects/:id/schedule` → `proj_schedule` rows ordered by `earliest_start`.
  - `GET /api/projects/:id/agents` → agents joined with their claimed item and latest run: `select a.id, a.display_name, a.platform, a.model, a.status, a.last_seen_at, w.id as work_item_id, w.title as work_item_title, r.external_session_id, r.tokens_in, r.tokens_out, r.cost_usd, r.started_at from agents a left join work_items w on w.claimed_by = a.id and w.project_id = a.project_id left join lateral (select * from runs where agent_id = a.id order by started_at desc limit 1) r on true where a.project_id = $1` (AVW-1 fields; missing depth → nulls, AVW-7).

- [ ] **Step 1: Failing tests** — boot `createApp` on port 0 (the `apps/mcp/src/loop.test.ts` pattern), seed two orgs. Cases: (a) dev-login sets cookie + returns user id; unknown email → 404; (b) `/api/orgs` without cookie → 401; (c) user A's `/api/orgs` lists only org A; (d) `/api/projects/:idB` as user A → 404; (e) `/api/projects/:idA/items` returns seeded item + dep pair; (f) `/api/projects/:idA/agents` row carries `display_name`, claimed `work_item_title`, and run cost. Extract the cookie from the `set-cookie` header and replay it via `headers: { cookie }`.
- [ ] **Step 2: FAIL → implement `http.ts` + `routes.ts`.** `http.ts`: `express.json()`, cookie parse inline (`req.headers.cookie` split — no cookie-parser dep), `requireUser` middleware calling `verifySession`, mounts routes; `main.ts`: two pools (`foreman_app` from `DATABASE_URL_APP`, service from `DATABASE_URL`), port `FOREMAN_API_PORT ?? 3003`, `devAuth: process.env.NODE_ENV !== "production"`.
- [ ] **Step 3: PASS → typecheck → commit** — `git commit -m "feat(api): RLS-scoped REST reads - orgs, projects, items, schedule, agents"`

---

### Task 3: Schedule write-back — PATCH → sync job → github worker

**Files:**
- Create: `apps/github/src/handlers/schedule-write.ts`
- Modify: `apps/api/src/routes.ts` (add PATCH), `apps/github/src/handlers/index.ts` (route + `ctx.backbone`), `apps/github/src/main.ts` (construct `GithubBackbone` into ctx)
- Test: `apps/api/src/routes.test.ts` (extend), `apps/github/src/handlers/schedule-write.test.ts`

**Interfaces:**
- Consumes: Phase 2 `GithubBackbone.updateSchedule(item, {startAt?, targetAt?})`, `HandlerContext`.
- Produces:
  - api: `PATCH /api/items/:id/schedule` body `{start_at?, target_at?}` (zod: `YYYY-MM-DD` strings) → verify the item is visible via `withUser` (404 otherwise), then insert on **servicePool** into `sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)` values `(org, coalesce(project.gh_installation_id, 0), 'schedwrite:' || item_id || ':' || now-epoch, 'foreman.schedule_write', {work_item_id, start_at, target_at})` → `202 {queued: true}`.
  - github: `handleScheduleWrite(tx, job, backbone)` → zod-parse payload, `backbone.updateSchedule({workItemId}, {startAt?, targetAt?})`; missing backbone in ctx → warn + return (job completes). `HandlerContext` gains `backbone?: Backbone`.

- [ ] **Step 1: Failing tests** — api: PATCH as user A on own item → 202 + one `sync_jobs` row with the payload; PATCH on org B's item → 404, no row; bad date `"soon"` → 400. github: enqueue a `foreman.schedule_write` job, `handleSyncJob` with a stub backbone records `updateSchedule` called with `{workItemId, targetAt}`.
- [ ] **Step 2: FAIL → implement → PASS.** In `apps/github/src/main.ts` construct `new GithubBackbone({ pool, gh: ctx.gh, echo: ctx.echo, emitter: new EventEmitter() })` into `ctx.backbone`.
- [ ] **Step 3: Commit** — `git commit -m "feat(api,github): async schedule write-back via foreman.schedule_write sync job (GNT-8)"`

---

### Task 4: SSE stream with Last-Event-ID resume

**Files:**
- Create: `apps/api/src/stream.ts`
- Modify: `apps/api/src/http.ts` (mount), `src/main.ts`
- Test: `apps/api/src/stream.test.ts`

**Interfaces:**
- Consumes: 0004 `foreman_events` NOTIFY trigger; Task 1 `withUser`.
- Produces:
  - `createEventHub(servicePool: pg.Pool): Promise<{ subscribe(fn: () => void): () => void; close(): Promise<void> }>` — one dedicated LISTEN connection for the whole process; also fires every 2s as poll fallback.
  - `GET /api/projects/:id/stream` — 404 via `withUser` visibility check, then SSE (`content-type: text/event-stream`). Cursor = `Last-Event-ID` header or `?after` param or current `max(events.id)`. On each hub tick: `select id, type from events where project_id = $1 and id > $cursor order by id` **on servicePool** (org already authorised); map types → scopes (`work.*`/`github.issue_synced`/`github.pr_*` → `items`+`schedule`+`agents`; `github.project_item_changed`/`work.rescheduled` → `items`+`schedule`; `agent.*` → `agents`); emit one message per batch: `id: <last_event_id>\ndata: {"scopes":[…],"last_event_id":"…"}\n\n`; advance cursor. Heartbeat comment `: ping` every 15s; clean up subscription on `req.close`.

- [ ] **Step 1: Failing test** — boot app; open the stream with `fetch` + `ReadableStream` reader (no EventSource in node test): connect with a cookie, insert a `work.rescheduled`-typed event row for the project, assert a `data:` frame arrives containing `"schedule"` and the event id within 3s; then reconnect passing `Last-Event-ID` of that frame, insert another event, assert only the new id arrives. Other-org stream → 404.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(api): per-project SSE invalidation stream with Last-Event-ID resume"`

---

### Task 5: Manifest-flow onboarding endpoints (WL-6)

**Files:**
- Create: `apps/github/src/setup.ts`
- Modify: `apps/github/src/receiver.ts` (mount setup routes on the same express app)
- Test: `apps/github/src/setup.test.ts`

**Interfaces:**
- Consumes: `github_apps`/`github_installations` tables; verified item 4 (conversion returns `client_id, client_secret, pem, webhook_secret`).
- Produces: `mountSetup(app: express.Express, opts: { pool: pg.Pool; secret: string; githubBase?: string; apiBase?: string; publicUrl: string })`:
  - `signState(orgId: string, secret: string)` / `verifyState(state, secret)` — same HMAC shape as Task 1's cookie (copy the two functions; different secret namespace `state:${orgId}`).
  - `GET /setup/github/start?org_slug=…` → resolve org, render a minimal HTML page whose form POSTs `manifest` JSON to `{githubBase}/organizations/{gh_org}/settings/apps/new?state={signed}` (`gh_org` from `?gh_org=` param); manifest: `{name: "foreman-{org_slug}", url: publicUrl, hook_attributes: {url: publicUrl + "/webhook", active: true}, redirect_url: publicUrl + "/setup/github/callback", public: false, default_permissions: {issues: "write", pull_requests: "read", organization_projects: "admin"}, default_events: ["issues", "pull_request", "projects_v2_item"]}`.
  - `GET /setup/github/callback?code&state` → verify state (401 bad), `POST {apiBase}/app-manifests/{code}/conversions` via injected `fetchImpl` → 201 body `{id, slug, pem, webhook_secret, client_id, client_secret}` → upsert `github_apps` (organisation_id from state) → redirect (302) to the app's installation URL `{githubBase}/apps/{slug}/installations/new?state={signed}`.
  - `GET /setup/github/install-callback?installation_id&state` → verify state → upsert `github_installations` (app looked up as the most recent `github_apps` row for the org) → 200 HTML "installed".

- [ ] **Step 1: Failing tests** — stub `fetchImpl` returning a canned conversion 201: (a) `start` page contains the form action URL and a manifest JSON with the webhook URL; (b) `callback` with a valid signed state inserts a `github_apps` row owned by the org and redirects to the install URL; (c) tampered state → 401, no row; (d) `install-callback` inserts `github_installations` linked to the app and org.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(github): WL-6 manifest-flow onboarding - create, convert, install, link"`

---

### Task 6: `apps/web` scaffold — Vite, router, api client, login

**Files:**
- Create: `apps/web/package.json` (`react`, `react-dom`, `react-router-dom`; devDeps `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, `@types/react`, `@types/react-dom`), `tsconfig.json` (extends base + `"jsx": "react-jsx", "lib": ["ES2022", "DOM", "DOM.Iterable"]`), `vite.config.ts` (react plugin; `server.proxy: {"/api": "http://localhost:3003", "/auth": "http://localhost:3003"}`; `test: {environment: "jsdom"}`), `index.html`, `src/main.tsx`, `src/App.tsx`, `src/api.ts`, `src/pages/Login.tsx`, `src/pages/Projects.tsx`
- Test: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces:
  - `src/api.ts`: `api<T>(path: string, init?: RequestInit): Promise<T>` — `fetch(path, {credentials: "include", …})`, throws `ApiError(status)` on non-2xx (401 → caller redirects to `/login`); `useProjectStream(projectId: string, onInvalidate: (scopes: string[]) => void)` — `EventSource("/api/projects/{id}/stream")`, parses frames, calls back; cleans up on unmount.
  - Routes: `/login` (email form → `POST /auth/dev-login` → navigate `/`), `/` (org+project list from `GET /api/orgs` + `/api/orgs/:id/projects`, links to `/projects/:id`), `/projects/:id` (placeholder until Task 8).

- [ ] **Step 1: Failing test** — render `<App/>` at `/login` with `MemoryRouter`, type an email, submit with a mocked global `fetch` (assert it POSTs `/auth/dev-login` with the email JSON); mock 404 → error text appears.
- [ ] **Step 2: FAIL → implement → PASS.** Vitest config note: web tests run with `environment: "jsdom"` from `vite.config.ts` — no per-file pragma needed.
- [ ] **Step 3: Manual smoke** — `pnpm --filter foreman-api start` + `pnpm --filter foreman-web dev`, log in with a seeded email, see the project list. (Seed via existing db helpers if the dev DB is empty.)
- [ ] **Step 4: Commit** — `git commit -m "feat(web): vite+react scaffold - login, org/project list, api client, SSE hook"`

---

### Task 7: Agent View table

**Files:**
- Create: `apps/web/src/agents/AgentTable.tsx`
- Test: `apps/web/src/agents/AgentTable.test.tsx`

**Interfaces:**
- Consumes: `GET /api/projects/:id/agents` row shape from Task 2.
- Produces: `<AgentTable agents={AgentRow[]} />` — dense sortable table (AVW-1): columns Name, Platform, Model, Status (coloured dot + text), Current work item, Last seen (relative), Tokens (in+out), Cost. Client-side sort on any column header (toggle asc/desc); filter input matching name/platform/status substring. Nulls render as an em-dash with `title="not reported by this integration"` (AVW-7). All strings rendered as text nodes (X-6).

- [ ] **Step 1: Failing tests** — render with two fixture agents: (a) rows appear with name + cost formatted `$0.1234`; (b) click "Cost" header twice → order flips; (c) type in the filter → one row remains; (d) null `work_item_title` renders `—` with the AVW-7 title attr.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(web): agent view table - sortable, filterable, depth-aware nulls (AVW-1/7)"`

---

### Task 8: Gantt layout engine (pure)

**Files:**
- Create: `apps/web/src/gantt/layout.ts`
- Test: `apps/web/src/gantt/layout.test.ts`

**Interfaces:**
- Consumes: item/dep/schedule shapes from Task 2 responses.
- Produces (all pure, no DOM):
  - `types`: `GanttItem {id, title, status, kind, parentId, startAt, targetAt, critical, slack}`; `GanttRow extends GanttItem {y: number, x: number, w: number, depth: number, collapsed: boolean}`; `Arrow {from: string, to: string, points: Array<[number, number]>}`.
  - `buildScale(items, pxPerDay = 24): {x(date: string): number; days: number; start: string}` — x(min start_at)=0; undated items get `x = 0, w = pxPerDay` ghost width.
  - `buildRows(items, collapsedIds: Set<string>, rowHeight = 28): GanttRow[]` — depth-first by parent (children under parent, indented by `depth`), children of collapsed ids omitted, `y = index * rowHeight`.
  - `routeArrow(from: GanttRow, to: GanttRow, rowHeight): Arrow` — orthogonal: exit right edge of blocker, 8px stub, vertical run, enter left edge of blocked (§7 "orthogonal routing").
  - `windowRows(rows, scrollTop, viewportH, buffer = 10): {first: number, last: number}` — visible index range ± buffer (GNT-9 virtualisation core).
  - `mergeSchedule(items, scheduleRows): GanttItem[]` — joins `critical`/`slack` onto items (absent → `critical: false, slack: null`).

- [ ] **Step 1: Failing tests (golden-style)** — fixture of 4 items (epic E with children B,C; D depends on B): (a) `buildScale` maps the earliest date to 0 and `+3 days` to `72` at 24px/day; (b) `buildRows` orders E,B,C,D with depths 0,1,1,0; collapsing E leaves E,D; (c) `routeArrow` from B(row1) to D(row3) produces points starting at B's right edge and ending at D's left edge, all segments axis-parallel; (d) `windowRows` over 2000 rows at rowHeight 28, scrollTop 5600, viewport 700 → first ≈ 190, last ≈ 235 (200−10 buffer, 225+10); (e) `mergeSchedule` marks the critical fixture rows.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(web): pure gantt layout engine - scale, hierarchy, arrows, windowing"`

---

### Task 9: Gantt component — SVG, virtualised, critical path

**Files:**
- Create: `apps/web/src/gantt/Gantt.tsx`
- Modify: `apps/web/src/pages/ProjectView.tsx` (tabs: Gantt | Agents; data loading + SSE refetch wiring)
- Test: `apps/web/src/gantt/Gantt.test.tsx`

**Interfaces:**
- Consumes: Task 8 layout functions; Task 6 `api`/`useProjectStream`; Task 7 `AgentTable`.
- Produces: `<Gantt items deps schedule onReschedule={(id, {start_at, target_at}) => void} />` — scroll container with a spacer div at full height; only `windowRows` rows rendered: each an SVG group with the bar rect (`data-item-id`, fill by status, **critical bars get a distinct class + thicker stroke**), title text, collapse toggle on parents; one `<svg>` overlay drawing arrows for visible row pairs; weekend shading columns. `ProjectView` fetches items/schedule/agents, wires `useProjectStream` scopes → refetch of the matching resource, renders the tab bar.

- [ ] **Step 1: Failing tests** — jsdom: (a) 100-item fixture with a 700px viewport renders ≤ 60 bars (virtualisation works); (b) critical items carry the `gantt-critical` class, non-critical don't; (c) clicking a parent's toggle removes its children from the DOM; (d) an arrow path exists between the fixture's blocker/blocked pair.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(web): virtualised SVG gantt - bars, arrows, critical path, collapse (GNT-3/4/5/9)"`

---

### Task 10: Drag-to-reschedule + write-back wiring

**Files:**
- Create: `apps/web/src/gantt/drag.ts`
- Modify: `apps/web/src/gantt/Gantt.tsx` (pointer handlers), `apps/web/src/api.ts` (`patchSchedule`)
- Test: `apps/web/src/gantt/drag.test.ts`, extend `Gantt.test.tsx`

**Interfaces:**
- Consumes: Task 3 PATCH endpoint; Task 8 scale.
- Produces:
  - `dragResult(item: {startAt, targetAt}, dxPx: number, pxPerDay: number, mode: "move" | "resize-end"): {start_at?: string, target_at?: string}` — pure: px → whole-day snap (`Math.round(dx/pxPerDay)`), `move` shifts both dates, `resize-end` shifts only `target_at` (never before `start_at` + 1 day); returns `{}` when the snap is 0 days.
  - Gantt: pointerdown on bar body = move, on right 6px handle = resize; pointermove previews via local state; pointerup → `onReschedule(id, dragResult(...))` when non-empty. `ProjectView.onReschedule` → optimistic local update + `patchSchedule(id, body)` (202 expected; SSE `schedule` invalidate later confirms — deviation 4).

- [ ] **Step 1: Failing tests** — `dragResult`: +50px at 24px/day in `move` shifts both dates +2 days; +8px → `{}`; `resize-end` −∞ clamps to start+1. Component: pointer sequence over a bar fires `onReschedule` with the snapped dates.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(web): drag-to-reschedule with day snapping and async write-back (GNT-8)"`

---

### Task 11: Full-stack round trip + suite green

**Files:**
- Create: `apps/api/src/e2e.test.ts`
- Test: everything.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the failing e2e test** (api-level, no browser): seed org/user/project/items/deps + a fake schedule row; boot `createApp`; then: (1) dev-login → cookie; (2) GET items + schedule + agents all 200 with expected rows; (3) open the SSE stream; (4) PATCH `/api/items/:id/schedule {target_at}` → 202 and the `sync_jobs` row exists; (5) simulate the github worker having run by calling the Phase 2 `handleSyncJob` with a stub backbone that performs the local `work_items` update + `work.rescheduled` append inside a tx (reuse `handleScheduleWrite` with a real `GithubBackbone` over the Task 11 Phase 2 `startFakeGithub`); (6) assert an SSE frame with scope `schedule` and that a re-GET of items shows the new `target_at`.
- [ ] **Step 2: FAIL → fix whatever it exposes → PASS.**
- [ ] **Step 3: Full suite + typecheck** — `pnpm test && pnpm -r typecheck` → all packages green including Phases 1/2.
- [ ] **Step 4: Commit** — `git commit -m "test(api,web): full-stack round trip - login, read, drag write-back, SSE confirm"`

---

## Self-review checklist (run after writing, before execution)

- Spec coverage: §1.1 foreman-api reads projections ✅ T2 (proj_schedule/health) — api never writes GitHub ✅ T3; §7 SSE-per-project + Last-Event-ID ✅ T4; §7 Gantt virtualised/arrows/critical ✅ T8/T9; GNT-8 write-back ✅ T3/T10; AVW-1/7 ✅ T2/T7; WL-6 manifest flow ✅ T5 (Phase 2 deviations 1/3 closed); deferred set named in deviation 2.
- Placeholder scan: none — every step names exact behaviour, fields, or code.
- Type consistency: `withUser` (T1) used in T2/T3/T4; `HandlerContext.backbone` (T3) matches Phase 2's `HandlerContext`; `GanttRow`/`Arrow` (T8) consumed in T9/T10; agents row shape (T2) consumed in T7 fixtures.
