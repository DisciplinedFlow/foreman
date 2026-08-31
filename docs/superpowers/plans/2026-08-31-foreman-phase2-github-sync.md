# Foreman Phase 2 — GitHub App + Projector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Foreman to GitHub — a credential-pluggable GitHub App (`apps/github`) that verifies/dedupes webhooks, syncs issues and Projects v2 fields bidirectionally with echo suppression, plus the projector service (`apps/projector`) that replays the event log into projections, starting with the GNT-5 critical path.

**Architecture:** `apps/github` receives webhooks (raw-body HMAC verify → dedupe → tenant route → enqueue → 200), and a worker drains a `SKIP LOCKED` job table into handlers that mutate `work_items` and append `github.*` events in the same transaction (the Phase 1 pattern). Outbound writes go through a `GithubBackbone` implementing the Phase 1 `Backbone` interface, recording every write in a short-TTL echo cache so the reflected webhook doesn't loop. `apps/projector` tails `events` by `id` cursor (LISTEN/NOTIFY wake + poll fallback), idempotent and replayable from offset 0.

**Tech Stack:** TypeScript strict ESM, Node ≥22 (global `fetch`, `node:crypto` for RS256 — no jwt dependency), pnpm 11 workspaces, Vitest, `pg`, `zod`, Express (raw body), Redis via a `Kv` seam (in-memory impl for tests), Docker Compose Postgres 16 :5433 / Redis 7 :6380.

**Spec:** `docs/SPEC-Foreman.md` §5 (GitHub App, `GHA-*`, `GNT-*`, `WL-6`), §1.1/§1.3 (projector), §2 (data model), plus `docs/PRD-Foreman.md`. Phase 1 plan: `docs/superpowers/plans/2026-08-31-foreman-phase1-foundation.md`.

## SPEC §11 `[?]` items — RESOLVED 31-08-2026 (this plan's gate)

Verified before writing this plan; code below is written against these facts.

| # | Item | Resolution | Evidence |
|---|---|---|---|
| 3 | `projects_v2_item` webhook permission | **Organization-level "Projects" permission, read minimum** (repo-level Projects is insufficient), same for `projects_v2` | docs.github.com webhook-events-and-payloads |
| 4 | Manifest conversion response | `POST /app-manifests/{code}/conversions` → **201 with `client_id`, `client_secret`, `pem`, `webhook_secret`** all present (required fields) → zero-touch OEM onboarding IS possible | docs.github.com REST apps reference |
| 5 | `ProjectV2FieldType` enum | Live introspection: `ASSIGNEES, LINKED_PULL_REQUESTS, REVIEWERS, LABELS, MILESTONE, REPOSITORY, TITLE, TEXT, SINGLE_SELECT, MULTI_SELECT, NUMBER, DATE, ITERATION, TRACKS, TRACKED_BY, ISSUE_TYPE, PARENT_ISSUE, SUB_ISSUES_PROGRESS, CREATED, UPDATED, CLOSED` | `gh api graphql` introspection 31-08-2026 |
| 6 | Issue-type on REST create/update | Parameter is **`type`** (issue-type *name* as string); silently dropped without push access | docs.github.com REST issues reference |
| 7 | GraphQL dependency mutations | **`addBlockedBy` / `removeBlockedBy` exist**, input `{ issueId: ID!, blockingIssueId: ID! }` (verified by introspection). REST `/dependencies/blocked_by` also solid — this plan uses REST (database ids, matches sub-issues usage) | `gh api graphql` introspection 31-08-2026 |

Items 1, 2, 8, 9 (MCP tasks extension, Claude Code revision, hook list, Agent SDK options) gate **Phase 4**, not this plan.

## Global Constraints

Everything from the Phase 1 plan still holds (event-per-mutation in the same tx, `X-6` untrusted agent/GitHub text — parameterised SQL only, `X-2` idempotency, `WL-7` RLS guard, roles `foreman_service`/`foreman_app`, conventional commits, one commit per green TDD cycle). New for Phase 2:

- **Webhook handler order is law** (SPEC §5.2/GHA-2): raw body → `crypto.timingSafeEqual` on `X-Hub-Signature-256` only (never `==`, ignore SHA-1) → dedupe on `X-GitHub-Delivery` → tenant from `installation.id` in the payload (one secret per App, never tenant-from-secret) → enqueue → 200 in <1s. Never process inline.
- **Credential-pluggable from day one** (WL-6 consequence): App ID, private key, webhook secret, slug resolved per App from the `github_apps` table — **never from process env** in library/handler code. Only the bootstrap seed script reads env.
- **Echo suppression** (GHA-4/GNT-8): every outbound write records `(entity, field, value_hash)` in a short-TTL cache **before** the HTTP call; matching inbound webhooks append `github.*` events but never re-trigger an outbound write.
- **Rate budget** (GHA-7): pause outbound when observed `x-ratelimit-remaining` < 20% of `x-ratelimit-limit`; on `403`+`retry-after` back off and mark the installation degraded. Read headers, never query `rateLimit`.
- **GraphQL discipline**: `first:`≤100 on every connection; no bulk field mutation exists — batch as aliased mutations in one document when needed.
- **Sub-issue and dependency REST calls use the issue *database id*** (`gh_issue_id`), never the issue number.
- **Projector is idempotent and replayable from offset 0** (SPEC §1.1): running a projection twice over the same events must produce identical tables.
- **One-way dependency rule** (§1.3): projector reads `events`, writes only `proj_*` tables; `apps/github` never reads projections.

### Documented deviations from the SPEC (decided here, reviewers take note)

1. **Manifest-flow UI is deferred to Phase 3.** §5.6 conversion endpoint returns everything we need (verified, item 4), but Phase 2 has no web UI. `github_apps` + `github_installations` rows are seeded by `apps/github/scripts/seed-app.ts` from env/args. The table schema already matches the conversion response so the Phase 3 UI is an INSERT, not a migration.
2. **Private keys live in the `github_apps` table, not KMS.** Grants deny `foreman_app` all access to `github_apps` (service-only, like `agent_tokens` in 0003). KMS envelope encryption is a hardening-phase task.
3. **Installation→organisation linking is manual** (seed script). The install-from-UI flow with a `state` param is Phase 3.
4. **`GithubBackbone.reportRun` throws `BackboneCapabilityError`.** Check runs (§5.4) are the week-9 deliverable (Phase 4 plan) — implementing them here would drag in `check_run.requested_action` dispatch and head-SHA tracking.
5. **Inbound status writes are guarded:** a Projects-v2 status-lane change only mutates `work_items.status` when the current status is in `('draft','queued','blocked','done','cancelled')` — never clobbering `claimed/in_progress/in_review`, which belong to the queue (Phase 1). The event is appended regardless.
6. **Dependency changes have no webhook** in the §5.2 subscription set — deps refresh on full sync/reconciliation and via our own outbound writes. Acceptable staleness; reconciliation cron closes the gap.
7. **Rate budget is header-driven, not a Lua token bucket.** Store `{remaining, limit, reset}` per installation after each response; block below the 20% floor until `reset`. Atomic Redis buckets are a hardening-phase upgrade; the seam (`RateBudget`) doesn't change.
8. **`events` gains a NOTIFY trigger** (0004) so the projector can LISTEN — the spec's LISTEN/NOTIFY choice (§1.2) implied it; Phase 1 didn't need it yet.

## File structure

```
packages/db/migrations/0004_github_sync.sql       # columns, tables, trigger, RLS, grants
packages/github-client/                            # @foreman/github-client
  src/kv.ts            # Kv interface + InMemoryKv + RedisKv
  src/jwt.ts           # appJwt() — RS256 via node:crypto
  src/tokens.ts        # InstallationTokenSource (mint + cache, 55min TTL)
  src/client.ts        # GithubClient.rest()/graphql() + RateBudget
  src/echo.ts          # EchoCache (record / wasOwnWrite)
  src/index.ts
apps/github/                                       # foreman-github service
  src/verify.ts        # signature check
  src/receiver.ts      # express app: verify→dedupe→route→enqueue→200
  src/jobs.ts          # claimSyncJob / completeSyncJob (SKIP LOCKED)
  src/handlers/issues.ts        # inbound issues + PR events
  src/handlers/project-item.ts  # inbound projects_v2_item deltas
  src/sync/field-map.ts # discoverFieldMap()
  src/sync/full-sync.ts # fullSync() — issues + items + deps + parents
  src/backbone.ts      # GithubBackbone implements Backbone
  src/main.ts          # http listener + worker loop
  scripts/seed-app.ts  # deviation 1/3 bootstrap
apps/projector/                                    # foreman-projector service
  src/runner.ts        # cursor loop, LISTEN/NOTIFY + poll
  src/projections/critical-path.ts  # GNT-5
  src/main.ts
```

Both new apps copy `package.json`/`tsconfig.json` shape from `apps/mcp` (workspace deps `"@foreman/db": "workspace:*"` etc., `"type":"module"`, scripts `build`/`typecheck`). `packages/github-client` copies shape from `packages/events`.

---

### Task 1: Migration 0004 — GitHub sync + projector schema

**Files:**
- Create: `packages/db/migrations/0004_github_sync.sql`
- Test: `packages/db/src/github-schema.test.ts`

**Interfaces:**
- Produces: tables `github_apps`, `github_installations`, `github_deliveries`, `sync_jobs`, `projection_cursors`, `proj_schedule`, `proj_project_health`; `work_items.gh_issue_id bigint`; trigger `events_notify` (`pg_notify('foreman_events', id::text)`). Existing RLS guard test (0002-era) automatically covers the new `organisation_id` tables — 0004 must therefore ship their policies.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/src/github-schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "./testing.js";

let db: TestDb;
beforeAll(async () => { db = await createTestDatabase(); });
afterAll(async () => { await db.teardown(); });

describe("0004 github sync schema", () => {
  it("has the new tables and work_items.gh_issue_id", async () => {
    const t = await db.adminPool.query(
      `select table_name from information_schema.tables where table_schema='public'
       and table_name in ('github_apps','github_installations','github_deliveries','sync_jobs','projection_cursors','proj_schedule','proj_project_health')`);
    expect(t.rowCount).toBe(7);
    const c = await db.adminPool.query(
      `select 1 from information_schema.columns where table_name='work_items' and column_name='gh_issue_id'`);
    expect(c.rowCount).toBe(1);
  });

  it("notifies foreman_events on event insert", async () => {
    const { orgId } = await seedOrgWithUser(db.adminPool, "notify-test");
    const client = await db.adminPool.connect();
    try {
      const got = new Promise<string>((res) => client.on("notification", (m) => res(m.channel)));
      await client.query("listen foreman_events");
      await db.adminPool.query(
        `insert into events (organisation_id, type, payload, occurred_at) values ($1,'agent.heartbeat','{}',now())`, [orgId]);
      expect(await got).toBe("foreman_events");
    } finally { client.release(); }
  });

  it("denies foreman_app access to github_apps (credential table)", async () => {
    const pg = (await import("pg")).default;
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    await expect(app.query("select * from github_apps")).rejects.toThrow(/permission denied/);
    await app.end();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @foreman/db test -- github-schema` → FAIL (tables missing).

- [ ] **Step 3: Write the migration**

```sql
-- packages/db/migrations/0004_github_sync.sql

-- One row per GitHub App we can act as (first-party or a WL-6 partner-created App).
-- Columns mirror POST /app-manifests/{code}/conversions (verified 31-08-2026: returns
-- client_id, client_secret, pem, webhook_secret) so the Phase 3 manifest UI is an INSERT.
create table github_apps (
  app_id          bigint primary key,
  organisation_id uuid references organisations(id) on delete cascade,  -- null = shared first-party App
  slug            text not null,
  private_key_pem text not null,
  webhook_secret  text not null,
  client_id       text,
  client_secret   text,
  created_at      timestamptz not null default now()
);

create table github_installations (
  installation_id bigint primary key,
  app_id          bigint not null references github_apps(app_id) on delete cascade,
  organisation_id uuid not null references organisations(id) on delete cascade,
  account_login   text,
  created_at      timestamptz not null default now()
);
create index on github_installations (organisation_id);

-- Global webhook dedupe (GHA-2 step 3). Pre-tenant, so no organisation_id, no RLS.
create table github_deliveries (
  delivery_id text primary key,
  received_at timestamptz not null default now()
);

create table sync_jobs (
  id              bigserial primary key,
  organisation_id uuid not null references organisations(id) on delete cascade,
  installation_id bigint not null,
  delivery_id     text not null,
  event_name      text not null,
  action          text,
  payload         jsonb not null,
  status          text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts        int not null default 0,
  run_after       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index on sync_jobs (status, run_after) where status = 'queued';

create table projection_cursors (
  name          text primary key,
  last_event_id bigint not null default 0,
  updated_at    timestamptz not null default now()
);

-- GNT-5 critical path projection: day-granularity CPM per work item.
create table proj_schedule (
  work_item_id    uuid primary key references work_items(id) on delete cascade,
  organisation_id uuid not null,
  project_id      uuid not null,
  earliest_start  int not null,
  earliest_finish int not null,
  latest_start    int not null,
  latest_finish   int not null,
  slack           int not null,
  critical        boolean not null,
  computed_at     timestamptz not null default now()
);
create index on proj_schedule (project_id);

create table proj_project_health (
  project_id      uuid primary key references projects(id) on delete cascade,
  organisation_id uuid not null,
  has_dep_cycle   boolean not null default false,
  cycle_members   uuid[] not null default '{}',
  computed_at     timestamptz not null default now()
);

alter table work_items add column gh_issue_id bigint;  -- REST database id (sub-issues/deps API needs it)

create or replace function foreman.notify_event() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin perform pg_notify('foreman_events', new.id::text); return new; end $$;
create trigger events_notify after insert on events
  for each row execute function foreman.notify_event();

-- RLS (WL-7): every organisation_id table gets the 0002 policy pattern.
alter table github_apps enable row level security;
create policy github_apps_tenant on github_apps
  using (organisation_id is null or foreman.is_member(organisation_id))
  with check (organisation_id is null or foreman.is_member(organisation_id));
alter table github_installations enable row level security;
create policy github_installations_tenant on github_installations
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table sync_jobs enable row level security;
create policy sync_jobs_tenant on sync_jobs
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table proj_schedule enable row level security;
create policy proj_schedule_tenant on proj_schedule
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table proj_project_health enable row level security;
create policy proj_project_health_tenant on proj_project_health
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));

-- Deviation 2: credentials are service-only, like agent_tokens in 0003.
revoke all on github_apps from foreman_app;
```

- [ ] **Step 4: Run the db test suite** — `pnpm --filter @foreman/db test` → the new test AND the existing RLS guard + migration idempotency tests must pass. The runner (`migrate.ts`) tracks applied files in `schema_migrations`, so 0004 executes exactly once — no `if not exists` guards needed; `rerunMigrations()` is a no-op for already-applied files.

- [ ] **Step 5: Commit** — `git commit -m "feat(db): github sync + projector schema, events NOTIFY trigger (0004)"`

---

### Task 2: `@foreman/github-client` — Kv seam, App JWT, installation tokens

**Files:**
- Create: `packages/github-client/package.json`, `tsconfig.json` (copy shape from `packages/events`), `src/kv.ts`, `src/jwt.ts`, `src/tokens.ts`, `src/index.ts`
- Test: `src/jwt.test.ts`, `src/tokens.test.ts`

**Interfaces:**
- Produces:
  - `interface Kv { get(k: string): Promise<string|null>; set(k: string, v: string, ttlSec: number): Promise<void>; del(k: string): Promise<void> }`, `class InMemoryKv implements Kv`, `class RedisKv implements Kv` (thin wrapper over `redis` client, only `main.ts` constructs it).
  - `appJwt(appId: number, privateKeyPem: string, now?: Date): string` — RS256, `iat` = now−60s, `exp` = now+540s (≤10 min), `iss` = String(appId).
  - `class InstallationTokenSource { constructor(opts: { kv: Kv; fetchImpl?: typeof fetch; apiBase?: string; getApp(appId: number): Promise<{ privateKeyPem: string }> }); token(appId: number, installationId: number): Promise<string> }` — Kv key `ghtok:{installationId}`, TTL 55 min (§5.1), mint via `POST {apiBase}/app/installations/{id}/access_tokens`. Never logs the token.

- [ ] **Step 1: Write the failing JWT test**

```ts
// packages/github-client/src/jwt.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { appJwt } from "./jwt.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("appJwt", () => {
  it("emits verifiable RS256 with iat -60s, exp +540s, iss = app id", () => {
    const now = new Date("2026-08-31T12:00:00Z");
    const jwt = appJwt(12345, pem, now);
    const [h, p, s] = jwt.split(".");
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`),
      publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toEqual({ iat: 1782561540, exp: 1782562140, iss: "12345" });
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then implement:

```ts
// packages/github-client/src/jwt.ts
import crypto from "node:crypto";

const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function appJwt(appId: number, privateKeyPem: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({ iat: t - 60, exp: t + 540, iss: String(appId) })}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKeyPem).toString("base64url");
  return `${unsigned}.${sig}`;
}
```

- [ ] **Step 3: Green, then write the failing token-cache test**

```ts
// packages/github-client/src/tokens.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { InMemoryKv } from "./kv.js";
import { InstallationTokenSource } from "./tokens.js";

const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function fakeFetch(calls: string[]): typeof fetch {
  return (async (url: any, init: any) => {
    calls.push(`${init.method} ${url} auth=${init.headers["authorization"]?.startsWith("Bearer ey")}`);
    return new Response(JSON.stringify({ token: "ghs_test", expires_at: "2026-08-31T13:00:00Z" }), { status: 201 });
  }) as typeof fetch;
}

describe("InstallationTokenSource", () => {
  it("mints lazily, caches 55min, never re-fetches while cached", async () => {
    const calls: string[] = [];
    const kv = new InMemoryKv();
    const src = new InstallationTokenSource({
      kv, fetchImpl: fakeFetch(calls), apiBase: "https://gh.test",
      getApp: async () => ({ privateKeyPem: pem }),
    });
    expect(await src.token(1, 777)).toBe("ghs_test");
    expect(await src.token(1, 777)).toBe("ghs_test");
    expect(calls).toEqual(["POST https://gh.test/app/installations/777/access_tokens auth=true"]);
    expect(await kv.get("ghtok:777")).toBe("ghs_test");
  });
});
```

- [ ] **Step 4: Implement `kv.ts` + `tokens.ts`**

```ts
// packages/github-client/src/kv.ts
export interface Kv {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ttlSec: number): Promise<void>;
  del(k: string): Promise<void>;
}

export class InMemoryKv implements Kv {
  private m = new Map<string, { v: string; exp: number }>();
  async get(k: string) {
    const e = this.m.get(k);
    if (!e || e.exp < Date.now()) { this.m.delete(k); return null; }
    return e.v;
  }
  async set(k: string, v: string, ttlSec: number) { this.m.set(k, { v, exp: Date.now() + ttlSec * 1000 }); }
  async del(k: string) { this.m.delete(k); }
}

// RedisKv: constructor takes a connected `redis` client; get/set(EX)/del pass-throughs.
export class RedisKv implements Kv {
  constructor(private client: { get(k: string): Promise<string | null>; set(k: string, v: string, o: { EX: number }): Promise<unknown>; del(k: string): Promise<unknown> }) {}
  get(k: string) { return this.client.get(k); }
  async set(k: string, v: string, ttlSec: number) { await this.client.set(k, v, { EX: ttlSec }); }
  async del(k: string) { await this.client.del(k); }
}
```

```ts
// packages/github-client/src/tokens.ts
import { appJwt } from "./jwt.js";
import type { Kv } from "./kv.js";

export class InstallationTokenSource {
  constructor(private opts: {
    kv: Kv; fetchImpl?: typeof fetch; apiBase?: string;
    getApp(appId: number): Promise<{ privateKeyPem: string }>;
  }) {}

  async token(appId: number, installationId: number): Promise<string> {
    const key = `ghtok:${installationId}`;
    const cached = await this.opts.kv.get(key);
    if (cached) return cached;
    const { privateKeyPem } = await this.opts.getApp(appId);
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.apiBase ?? "https://api.github.com"}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt(appId, privateKeyPem)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status !== 201) throw new Error(`token mint failed for installation ${installationId}: ${res.status}`);
    const body = (await res.json()) as { token: string };
    await this.opts.kv.set(key, body.token, 55 * 60);
    return body.token;
  }
}
```

- [ ] **Step 5: Wire workspace** — add `packages/github-client` deps (`zod`, workspace refs), `src/index.ts` re-exports, run `pnpm install && pnpm --filter @foreman/github-client test && pnpm -r typecheck` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(github-client): app jwt + installation token cache behind Kv seam"`

---

### Task 3: `@foreman/github-client` — request layer, rate budget, echo cache

**Files:**
- Create: `src/client.ts`, `src/echo.ts`; extend `src/index.ts`
- Test: `src/client.test.ts`, `src/echo.test.ts`

**Interfaces:**
- Produces:
  - `class GithubClient { constructor(opts: { tokens: InstallationTokenSource; kv: Kv; fetchImpl?: typeof fetch; apiBase?: string }); rest(appId: number, installationId: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>; graphql<T>(appId: number, installationId: number, query: string, variables: Record<string, unknown>): Promise<T> }`
  - Rate budget: after every response, store `ghrate:{installationId}` = `{remaining, limit, reset}` from `x-ratelimit-*`; before a request, if `remaining < 0.2 * limit` and `reset` is in the future → throw `RateLimitedError(retryAtEpochSec)`; on 403 with `retry-after`, store a degraded marker `ghdeg:{installationId}` (TTL = retry-after) and throw. GraphQL errors (`body.errors`) throw `GithubGraphqlError` with the messages.
  - `class EchoCache { constructor(kv: Kv, ttlSec = 60); async record(entity: string, field: string, value: unknown): Promise<void>; async wasOwnWrite(entity: string, field: string, value: unknown): Promise<boolean> }` — key `ghecho:{entity}:{field}:{sha256(canonicalJson(value))}` (GHA-4).

- [ ] **Step 1: Failing tests** — three cases in `client.test.ts` with a stub fetch: (a) `rest()` sends `authorization: token ghs_…`, api-version header, parses JSON; (b) after a response with `x-ratelimit-limit: 100, x-ratelimit-remaining: 10`, the next call throws `RateLimitedError` without calling fetch; (c) 403 + `retry-after: 30` throws and sets `ghdeg:` key. Plus `echo.test.ts`: `record` then `wasOwnWrite` → true; unseen value → false; different field → false.

```ts
// packages/github-client/src/client.test.ts (core of it)
import { describe, it, expect } from "vitest";
import { InMemoryKv } from "./kv.js";
import { GithubClient, RateLimitedError } from "./client.js";

function stub(responses: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>) {
  const seen: any[] = [];
  const f = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { f, seen };
}
const tokens = { token: async () => "ghs_x" } as any;

it("blocks below the 20% floor without calling fetch", async () => {
  const kv = new InMemoryKv();
  const { f, seen } = stub([
    { status: 200, headers: { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "10", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } },
  ]);
  const c = new GithubClient({ tokens, kv, fetchImpl: f, apiBase: "https://gh.test" });
  await c.rest(1, 7, "GET", "/repos/o/r/issues/1");
  await expect(c.rest(1, 7, "GET", "/repos/o/r/issues/2")).rejects.toBeInstanceOf(RateLimitedError);
  expect(seen.length).toBe(1);
});
```

- [ ] **Step 2: FAIL, then implement `client.ts` and `echo.ts`.** Echo hashing:

```ts
// packages/github-client/src/echo.ts
import crypto from "node:crypto";
import type { Kv } from "./kv.js";

const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v) ?? "null").digest("hex");

export class EchoCache {
  constructor(private kv: Kv, private ttlSec = 60) {}
  private key(entity: string, field: string, value: unknown) { return `ghecho:${entity}:${field}:${hash(value)}`; }
  record(entity: string, field: string, value: unknown) { return this.kv.set(this.key(entity, field, value), "1", this.ttlSec); }
  async wasOwnWrite(entity: string, field: string, value: unknown) { return (await this.kv.get(this.key(entity, field, value))) !== null; }
}
```

`client.ts` sketch (write in full): build URL from `apiBase + path`; headers `authorization: token ${await tokens.token(appId, installationId)}`, `accept: application/vnd.github+json`, `x-github-api-version: 2022-11-28`; pre-flight check `ghrate:` + `ghdeg:` keys; post-flight store `ghrate:` (TTL until reset) when all three headers present; 403 + `retry-after` → set `ghdeg:` and throw `RateLimitedError`; `graphql()` POSTs `{query, variables}` to `/graphql`, throws `GithubGraphqlError` on `errors`, returns `body.data`.

- [ ] **Step 3: PASS** — `pnpm --filter @foreman/github-client test`.
- [ ] **Step 4: Commit** — `git commit -m "feat(github-client): rest/graphql transport with header-driven rate budget and echo cache"`

---

### Task 4: `apps/github` — webhook receiver + job queue

**Files:**
- Create: `apps/github/package.json`, `tsconfig.json` (copy shape from `apps/mcp`), `src/verify.ts`, `src/receiver.ts`, `src/jobs.ts`, `src/main.ts`
- Test: `src/receiver.test.ts`

**Interfaces:**
- Consumes: `@foreman/db` (`createTestDatabase`, pools), Task 1 tables.
- Produces:
  - `verifySignature(secret: string, rawBody: Buffer, sigHeader: string | undefined): boolean` — `sha256=` + hex HMAC, `crypto.timingSafeEqual`, length-check first, SHA-1 header ignored entirely.
  - `createReceiver(opts: { pool: pg.Pool }): express.Express` — POST `/webhook`: raw body (`express.raw({ type: "*/*", limit: "5mb" })`), resolve secret via `X-GitHub-Hook-Installation-Target-ID` header → `github_apps.app_id` lookup; 401 on bad/missing signature; dedupe `insert into github_deliveries … on conflict do nothing` (existing → 200 `{deduped:true}`); route tenant via `payload.installation.id` → `github_installations` (unknown → 202 `{unrouted:true}`, log, drop); insert `sync_jobs` row; 200. No handler logic inline (GHA-2 step 5).
  - `claimSyncJob(q: Queryable): Promise<SyncJob | null>` — `update sync_jobs set status='running', attempts=attempts+1 where id = (select id from sync_jobs where status='queued' and run_after <= now() order by id limit 1 for update skip locked) returning *`; `completeSyncJob(q, id, ok: boolean)` — `done`, or `failed` after 5 attempts else re-`queued` with `run_after = now() + interval '30 seconds' * attempts`.

- [ ] **Step 1: Failing tests** (supertest-style via `fetch` against `app.listen(0)`, or use `light-my-request`; Phase 1's `apps/mcp` http tests set the pattern — follow it):
  - valid signature + known installation → 200, one `sync_jobs` row with the org id
  - tampered body → 401, no rows
  - same `X-GitHub-Delivery` twice → second is `{deduped:true}`, still one row
  - unknown installation → 202, no rows
  - claim/complete: enqueue 2 jobs, `claimSyncJob` twice returns both in id order, third → null

Fixture helper for tests (reused in Tasks 5/7/11):

```ts
// apps/github/src/testing.ts
import crypto from "node:crypto";
export function signedHeaders(secret: string, body: string, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"),
    "x-github-delivery": crypto.randomUUID(),
    "x-github-event": "issues",
    "x-github-hook-installation-target-id": "1",
    ...extra,
  };
}
export async function seedGithubApp(pool: any, orgId: string, appId = 1, installationId = 777) {
  await pool.query(`insert into github_apps (app_id, slug, private_key_pem, webhook_secret) values ($1,'foreman-test','pem','whsec') on conflict do nothing`, [appId]);
  await pool.query(`insert into github_installations (installation_id, app_id, organisation_id) values ($1,$2,$3) on conflict do nothing`, [installationId, appId, orgId]);
}
```

- [ ] **Step 2: FAIL, implement.** `verify.ts`:

```ts
import crypto from "node:crypto";
export function verifySignature(secret: string, rawBody: Buffer, sigHeader: string | undefined): boolean {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(sigHeader);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
```

- [ ] **Step 3: PASS** — `pnpm --filter foreman-github test`.
- [ ] **Step 4: Commit** — `git commit -m "feat(github): webhook receiver — verify, dedupe, tenant route, enqueue (GHA-2)"`

---

### Task 5: Inbound issue + PR handlers

**Files:**
- Create: `apps/github/src/handlers/issues.ts`, `src/handlers/index.ts` (dispatcher `handleSyncJob(tx, job)`)
- Test: `src/handlers/issues.test.ts`

**Interfaces:**
- Consumes: `appendEvent` from `@foreman/db`, `signedHeaders`/`seedGithubApp` from Task 4.
- Produces: `handleIssuesEvent(tx: Queryable, job: SyncJob): Promise<void>` and `handlePullRequestEvent(tx, job)`; registered in `handlers/index.ts` dispatcher keyed by `event_name`. All in ONE transaction per job (worker in Task 4's `main.ts` wraps: claim → BEGIN → dispatch → COMMIT → complete).

Rules (all tested):
- `opened`: upsert by `gh_issue_node_id` — insert `work_items` (`title`, `intent` = body, `status='queued'`, `kind='task'` unless `issue.type.name` maps to a kind by lowercase name match, `gh_issue_id`/`gh_issue_number`/`gh_repo`/`gh_issue_node_id`, project resolved via `projects.gh_repos @> array[repo]` within the org) + `appendEvent … type:"github.issue_synced"` with idempotency key `ghd:{delivery_id}`.
- `edited`: update `title`/`intent` only. `closed`: status→`done` **only if** current status ∉ `('claimed','in_progress','in_review')` (deviation 5); `reopened`: `done|cancelled`→`queued`. `deleted`: status→`cancelled`. Every action appends `github.issue_synced`.
- No matching project → append nothing, mark job done (log). Issues from repos we don't track are noise, not errors.
- `pull_request` `opened` → `appendEvent "github.pr_opened"`; `closed` with `merged=true` → `"github.pr_merged"`; link `work_item_id` when the PR body matches `/(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/i` and that issue number exists in the same repo's work items.

- [ ] **Step 1: Failing tests** — table-driven over fixture payloads (build minimal literal payload objects inline; a full GitHub payload is not needed — handlers must parse defensively with zod `passthrough`): opened creates work item + event; opened twice with same delivery id dedupes the event (idempotency key) and doesn't duplicate the row (upsert); closed on an `in_progress` item leaves status alone but still appends the event; pr_merged with `Fixes #42` links the work item.
- [ ] **Step 2: FAIL → implement → PASS.**
- [ ] **Step 3: Wire the worker loop in `main.ts`** (claim → tx → dispatch → complete, 500ms idle poll; plus the express listener from Task 4). Manual smoke: `docker compose up -d && pnpm --filter foreman-github dev` then POST a signed fixture with curl → row appears.
- [ ] **Step 4: Commit** — `git commit -m "feat(github): inbound issue and PR sync handlers with guarded status writes"`

---

### Task 6: Field-map discovery + full sync + reconciliation

**Files:**
- Create: `apps/github/src/sync/field-map.ts`, `src/sync/full-sync.ts`, `apps/github/scripts/seed-app.ts`
- Test: `src/sync/field-map.test.ts`, `src/sync/full-sync.test.ts`

**Interfaces:**
- Consumes: `GithubClient.graphql/rest` (stub `GithubClient` in tests — tests inject `{ graphql: async () => fixture }`).
- Produces:
  - `discoverFieldMap(gh: GithubClientLike, appId: number, installationId: number, projectNodeId: string): Promise<FieldMap>` — one `fields(first:100)` query over `ProjectV2FieldCommon { id name dataType }` + single-select options + iteration configuration. Mapping convention: the SPEC §5.3 shape; pick `start_field` = field named `Start` (case-insensitive) if `dataType` ∈ `{DATE, ITERATION}`, `target_field` = `Target`/`Target date`/`End`, `status_field` = `Status` (SINGLE_SELECT, option map by lowercased name: `todo|queued→queued`, `in progress→in_progress`, `done→done`), `iteration_field` = first `ITERATION` field. Unmapped → key absent; callers treat absence as "don't sync that dimension". `dataType` values validated against the verified enum (item 5) — unknown values are skipped, never fatal.
  - `fullSync(deps: { tx: Queryable; gh: GithubClientLike }, project: { id, organisation_id, gh_installation_id, gh_project_node_id, gh_repos, field_map }): Promise<{ items: number }>` — paginate `items(first:100, after:$cursor)` with `fieldValues(first:50)` (date/iteration/single-select inline fragments, each with `field { … on ProjectV2FieldCommon { id } }`) and `content { … on Issue { id fullDatabaseId number title body state repository { nameWithOwner } parent { id } } }`; upsert work_items (same rules as Task 5 + `gh_item_node_id`, `start_at`, `target_at`, `iteration_id`, guarded status); second pass resolves `parent{id}` node ids → `parent_id` uuids; deps via REST `GET /repos/{o}/{r}/issues/{n}/dependencies/blocked_by?per_page=100` per synced issue, replacing `work_item_deps` rows with `source='github'` for that item; appends one `github.issue_synced` per changed item (idempotency key `fullsync:{project_id}:{gh_issue_node_id}:{updated_at-of-run}` — use a single run timestamp).
  - `seed-app.ts`: reads `FOREMAN_GH_APP_ID`, `FOREMAN_GH_PEM_PATH`, `FOREMAN_GH_WEBHOOK_SECRET`, `FOREMAN_GH_INSTALLATION_ID`, `FOREMAN_ORG_SLUG` and inserts `github_apps` + `github_installations` (deviations 1/3).

- [ ] **Step 1: Failing field-map test** — fixture GraphQL response with `Status` (SINGLE_SELECT, options Todo/In Progress/Done), `Start` (ITERATION), `Target` (DATE), `Sprint` (ITERATION) → expect the exact §5.3 JSON shape with option ids mapped to `queued/in_progress/done`.
- [ ] **Step 2: FAIL → implement → PASS.**
- [ ] **Step 3: Failing full-sync test** — stubbed `graphql` returning 2 pages (3 items: epic with child via `parent`, one with date values) + stubbed `rest` returning one blocked_by; expect: 3 work_items with linkage columns, `parent_id` resolved, 1 `work_item_deps` row, dates cached, events appended; **run `fullSync` twice → identical row counts** (idempotent).
- [ ] **Step 4: FAIL → implement → PASS.** `pnpm --filter foreman-github test`.
- [ ] **Step 5: Commit** — `git commit -m "feat(github): field-map discovery and idempotent full sync (issues, items, parents, deps)"`

---

### Task 7: Inbound `projects_v2_item` deltas

**Files:**
- Create: `apps/github/src/handlers/project-item.ts`; register in `handlers/index.ts`
- Test: `src/handlers/project-item.test.ts`

**Interfaces:**
- Consumes: `EchoCache` (worker constructs one from the shared Kv; tests use `InMemoryKv`), `field_map` from the project row.
- Produces: `handleProjectItemEvent(tx: Queryable, echo: EchoCache, job: SyncJob): Promise<void>`:
  - `created` → set `gh_item_node_id` on the work item matching `content_node_id`.
  - `edited` → read `changes.field_value.{field_node_id, field_type, from, to}` (§5.3: enough to mutate without re-querying). Match `field_node_id` against the project's `field_map`; apply: DATE start/target → `start_at`/`target_at` (`to.date ?? to`, zod-parsed); ITERATION → `iteration_id` (+ `start_at` from `to.startDate` when it's the start field); SINGLE_SELECT status → reverse option-id lookup → guarded status write (deviation 5).
  - **Echo suppression first** (GNT-8): `await echo.wasOwnWrite(gh_item_node_id, field_node_id, to)` → if true, append `github.project_item_changed` and return WITHOUT touching `work_items` (the write already happened locally).
  - `deleted` → clear `gh_item_node_id`, `iteration_id`, `start_at`, `target_at`.
  - Always append `github.project_item_changed` with `{gh_item_node_id, field_node_id, from, to}` (schema exists in `@foreman/events`), idempotency key `ghd:{delivery_id}`.

- [ ] **Step 1: Failing tests** — date edit updates `start_at` + appends event; status edit to `Done` option flips a `queued` item to `done` but leaves an `in_progress` item; **echo-recorded value → event appended, row untouched**; unknown `field_node_id` → event only.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(github): projects_v2_item delta handler with echo suppression (GNT-8)"`

---

### Task 8: Outbound `GithubBackbone`

**Files:**
- Create: `apps/github/src/backbone.ts`
- Test: `src/backbone.test.ts`

**Interfaces:**
- Consumes: `Backbone` + types from `@foreman/backbone` (exact Phase 1 signatures — `createWorkItem(project, item)`, `updateSchedule(item, s)`, `linkParent(child, parent)`, `addDependency(blocked, blocker)`, `reportRun`, `subscribe`), `GithubClient`, `EchoCache`.
- Produces: `class GithubBackbone implements Backbone { constructor(deps: { pool: pg.Pool; gh: GithubClientLike; echo: EchoCache; emitter: EventEmitter }) }`:
  - `createWorkItem` → resolve project row; `POST /repos/{repo}/issues` with `{ title, body: intent, type: kindToIssueType(kind) }` (`type` param verified, item 6; map `bug→Bug`, `task→Task`, `epic→Epic`, else omit — silently dropped by GitHub without push access, acceptable); insert `work_items` row with returned `id` (database id → `gh_issue_id`), `node_id`, `number` + `appendEvent "github.issue_synced"` in one tx; echo-record `(node_id, "issue", title)`.
  - `linkParent` → `POST /repos/{o}/{r}/issues/{parent_number}/sub_issues` body `{ sub_issue_id: child.gh_issue_id }` (**database id**, §5.3) + update `parent_id`.
  - `addDependency` → `POST /repos/{o}/{r}/issues/{blocked_number}/dependencies/blocked_by` body `{ issue_id: blocker.gh_issue_id }` + upsert `work_item_deps (source='foreman')`.
  - `updateSchedule` → for each provided field: echo-record `(gh_item_node_id, field_node_id, value)` **then** GraphQL `mutation { updateProjectV2ItemFieldValue(input:{ projectId, itemId, fieldId, value:{ date | iterationId } }) { projectV2Item { id } } }`; update cached `start_at`/`target_at`/`iteration_id` + `appendEvent "work.rescheduled"` in one tx. Skip dimensions absent from `field_map`.
  - `listWorkItems` → straight SQL over `work_items`. `subscribe` → attach to the passed `EventEmitter` (worker emits after each inbound handler commit). `reportRun` → `throw new BackboneCapabilityError("check runs ship with the Phase 4 plan")` (deviation 4; export the error class from `@foreman/backbone`? No — define it in `apps/github/src/backbone.ts`; the interface stays untouched).
- [ ] **Step 1: Failing tests** — stub `gh` records calls: `createWorkItem` hits POST issues with `type:"Bug"` for `kind:"bug"` and persists `gh_issue_id`; `linkParent` sends the database id, not the number; `updateSchedule` (a) echo-records before the GraphQL call (assert via call-order array), (b) sends `value:{date:"2026-09-15"}` for a DATE target field, (c) skips fields missing from `field_map`; `reportRun` throws.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(github): outbound GithubBackbone — issues, sub-issues, deps, schedule write-back"`

---

### Task 9: `apps/projector` — runner

**Files:**
- Create: `apps/projector/package.json`, `tsconfig.json`, `src/runner.ts`, `src/main.ts`
- Test: `src/runner.test.ts`

**Interfaces:**
- Produces:
  - `type Projection = { name: string; handles(type: string): boolean; apply(tx: Queryable, events: EventRow[]): Promise<void> }` where `EventRow = { id: string; organisation_id: string; project_id: string | null; type: string; payload: unknown; … }`.
  - `runOnce(pool: pg.Pool, projections: Projection[], batch = 500): Promise<number>` — per projection: read cursor (`insert … on conflict do nothing` then `select`), `select * from events where id > $cursor order by id limit $batch`, filter by `handles`, one tx: `apply` + advance cursor. Returns max rows fetched (0 = caught up).
  - `runForever(pool, projections)` — dedicated client `LISTEN foreman_events` (trigger from Task 1); on notification or every 2s, loop `runOnce` until 0.
- [ ] **Step 1: Failing tests** — a recording projection over a seeded org: (a) `runOnce` sees only new events on the second call (cursor advanced); (b) resetting the cursor to 0 and re-running yields the same final state for an idempotent projection (replayability harness); (c) a projection that throws → cursor NOT advanced, next `runOnce` retries the same batch.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(projector): cursor-based replayable projection runner with LISTEN/NOTIFY wake"`

---

### Task 10: Critical-path projection (GNT-5)

**Files:**
- Create: `apps/projector/src/projections/critical-path.ts`
- Test: `src/projections/critical-path.test.ts` (+ golden fixture inline)

**Interfaces:**
- Consumes: Task 9 `Projection` type; `work_items` (`start_at`, `target_at`, `project_id`) + `work_item_deps`.
- Produces: `criticalPathProjection: Projection` — `handles` returns true for `github.issue_synced`, `github.project_item_changed`, `work.rescheduled`, `work.created`, `work.completed`, `work.cancelled` (any event that can move dates or edges); `apply` recomputes affected projects (distinct `project_id` in the batch) wholesale — no incremental cleverness at Phase 2 scale (§5.3 "cache per project, invalidate on change"):
  - `computeSchedule(items: {id, start_at, target_at, deps: string[]}[]): { rows: ScheduleRow[]; cycle: string[] }` — pure function. Duration = `max(1, target-start in days)`, default 1 when dates missing; Kahn topological sort (cycle → return members, skip CPM per §5.3 "surface as health warning rather than throwing"); forward pass `ES = max(EF of blockers)` anchored at day 0 = earliest `start_at` in the project; backward pass from `max(EF)`; `slack = LS − ES`; `critical = slack === 0`.
  - Writes `proj_schedule` (delete-then-insert per project, same tx) and `proj_project_health`.
- [ ] **Step 1: Failing golden test** — fixture DAG: `A(2d) → B(3d) → D(1d)`, `A → C(1d) → D` ⇒ critical path A,B,D (slack 0), C slack 2; plus a 2-node cycle fixture ⇒ `has_dep_cycle=true`, `cycle_members` both ids, no `proj_schedule` rows for that project. Assert exact `earliest_start/finish, latest_start/finish, slack` numbers for all four nodes: A(0,2,0,2,0) B(2,5,2,5,0) C(2,3,4,5,2) D(5,6,5,6,0).
- [ ] **Step 2: FAIL → implement `computeSchedule` as pure function → PASS.**
- [ ] **Step 3: Integration** — seed work items + deps through real events → `runOnce` → assert `proj_schedule` rows; reset cursor to 0 → `runOnce` → identical rows (the Task 9 replay harness against a real projection).
- [ ] **Step 4: Commit** — `git commit -m "feat(projector): GNT-5 critical path projection with cycle detection (golden-file)"`

---

### Task 11: Round-trip integration + reconciliation cron

**Files:**
- Create: `apps/github/src/roundtrip.test.ts`, `apps/github/src/fake-github.ts`
- Modify: `apps/scheduler/src/main.ts` (add reconciliation interval)
- Test: `apps/github/src/roundtrip.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `startFakeGithub(): Promise<{ url: string; requests: RecordedRequest[]; close(): Promise<void> }>` — an express app answering `POST /app/installations/:id/access_tokens` (201 `ghs_fake`), `POST /graphql` (canned by query substring), `POST /repos/*` (echoing ids), recording every request. The week-7 done-when from SPEC §9: **round-trip green in both directions with echo suppression.**

- [ ] **Step 1: Write the failing round-trip test**
  1. Seed org + project (`gh_repos=['o/r']`, `field_map` with a DATE target field) + app + installation; start fake GitHub, receiver app, and a worker drain function.
  2. **Inbound:** POST signed `issues.opened` webhook → drain jobs → `work_items` row exists, `github.issue_synced` event appended.
  3. **Outbound:** `backbone.updateSchedule(item, { targetAt: "2026-09-15" })` → fake GitHub recorded one `updateProjectV2ItemFieldValue` call.
  4. **Echo:** POST the signed `projects_v2_item.edited` webhook GitHub would send for that write (same field node id + value) → drain → `github.project_item_changed` event appended, **fake GitHub recorded zero additional outbound calls**, `work_items.target_at` unchanged (`2026-09-15`).
  5. **Non-echo:** POST an `edited` webhook with a *different* date → `target_at` updates, still no outbound call (inbound never triggers outbound — the suppression plus one-way flow together kill the loop).
- [ ] **Step 2: FAIL → fix whatever the test exposes → PASS.**
- [ ] **Step 3: Reconciliation** — in `apps/scheduler/src/main.ts`, add an interval (default `FOREMAN_RECONCILE_INTERVAL_SEC=3600`, 0 disables — tests use 0) that enqueues a `sync_jobs` row `{event_name:'foreman.reconcile'}` per project with a `gh_project_node_id`; `handlers/index.ts` routes it to `fullSync`. One test: enqueue + drain calls fullSync (stub gh).
- [ ] **Step 4: Full suite + typecheck** — `pnpm test && pnpm -r typecheck` → everything green, including all Phase 1 suites.
- [ ] **Step 5: Commit** — `git commit -m "test(github): bidirectional round-trip with echo suppression; reconciliation cron"`

---

## Self-review checklist (run after writing, before execution)

- Spec coverage: §5.1 auth ✅ T2, §5.2 webhooks ✅ T4, §5.3 mapping/sync ✅ T6/T7/T8, GNT-5 ✅ T10, GNT-8/GHA-4 ✅ T3/T7/T11, GHA-7 ✅ T3 (header-driven, deviation 7), WL-6 ✅ T1 schema + deviations 1–3, projector §1.1/§1.3 ✅ T9/T10. §5.4 check runs and §5.5 full budget → explicitly deferred (deviations 4/7).
- Type consistency: `Kv`/`EchoCache`/`GithubClient` names used identically in T2–T8; `gh_issue_id` introduced in T1, consumed in T5/T6/T8; `SyncJob` produced T4, consumed T5/T7.
- Placeholders: none — every step has code or an exact behavioural contract with named fields.
