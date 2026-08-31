# Foreman Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Foreman monorepo with the append-only event log, Postgres schema with enforced RLS, the `Backbone` interface, the atomic work queue (claim/lease/WIP/dependency gating), and a working MCP server that lets an agent complete a full announce → claim → report → complete loop.

**Architecture:** Event-sourced core: every mutation appends to an `events` table; `work_items`/`agents` rows are the spec-defined operational tables. pnpm monorepo with `packages/*` (shared) and `apps/*` (services). Postgres 16 (Docker Compose, port 5433) is the datastore; tests run against it with one throwaway database per test file. MCP server is stateless Streamable HTTP.

**Tech Stack:** TypeScript (strict, ESM), Node ≥22 (dev machine has 24), pnpm 11 workspaces, Vitest, `pg`, `zod`, `@modelcontextprotocol/sdk`, Express, Docker Compose (postgres:16, redis:7).

**Spec:** `docs/SPEC-Foreman.md` (implementation spec) and `docs/PRD-Foreman.md` (requirement IDs `AGT-*`, `QUE-*`, `X-*`, …). Task 1 copies them into the repo from `C:\Users\Davin\Downloads\`.

## Global Constraints

- **Runtime:** TypeScript / Node 22+ (SPEC §1.2). ESM everywhere (`"type": "module"`), `strict: true`.
- **The event log is the system** (SPEC §0.2): every state mutation in this plan appends a row to `events` in the same transaction as the mutation.
- **Agent output is untrusted data** (`X-6`): never interpolate agent-supplied text into SQL (parameterised queries only) or into anything executed/evaluated.
- **Metadata only by default** (`X-3`): `tool.invoked` payloads carry `tool_name` + `tool_use_id` only; no prompt text, no tool inputs anywhere in Phase 1.
- **Tools namespaced `foreman__*`**; agent identity always derived from the bearer token, **never** from a payload `agent_id` (SPEC §3.5).
- **Idempotency** (`X-2`): event append accepts an optional idempotency key; duplicate `(organisation_id, idempotency_key)` is a silent no-op.
- **RLS guard** (`WL-7`): a test must fail if any table with an `organisation_id` column lacks `ENABLE ROW LEVEL SECURITY` + at least one policy.
- **DB roles:** `foreman_service` (LOGIN, BYPASSRLS — used by MCP/scheduler which scope by org from the token) and `foreman_app` (LOGIN, RLS-enforced — used by the future BFF; used now by security tests). Migrations run as the compose superuser `postgres`.
- **Dev infra:** Postgres 16 on `localhost:5433` (user/pass/db: `postgres`/`postgres`/`postgres`), Redis 7 on `localhost:6380`, both from `docker-compose.yml`. Tests read `TEST_ADMIN_DATABASE_URL`, defaulting to `postgres://postgres:postgres@localhost:5433/postgres`.
- **Conventional commits**, one commit per green TDD cycle at minimum, one per task at maximum granularity below.

### Documented deviations from the SPEC (decided here, reviewers take note)

1. **`events` is NOT partitioned in Phase 1.** SPEC §2.1 partitions `events` by `recorded_at` *and* puts a partial unique index on `(organisation_id, idempotency_key)` — invalid in Postgres: a unique index on a partitioned table must include the partition key, which would break dedupe semantics. Phase 1 ships a plain table with the partial unique index (correct idempotency); partitioning is a later migration once volume warrants it.
2. **Old-client long-running emulation:** instead of a stored `poll_token` + `work.poll` tool, an empty `foreman__work_claim` returns `{status:"empty", retry_after_ms}` and the agent simply re-calls `work_claim` (idempotent). The MCP tasks extension (`2026-07-28`) is a Phase 2+ task after the SPEC §11 `[?]` items are verified against the published schema.
3. **`checkpoints` get their own table** (SPEC only implies storage). Answering a checkpoint from the UI is Phase 3; Phase 1 proves the round-trip at the DB + tool level.
4. **WIP enforcement locks the project row** (`SELECT … FOR UPDATE` on `projects`) to make the WIP check + claim atomic. This serialises claims within one project; `SKIP LOCKED` still prevents double-assignment. Acceptable at Phase 1 scale (SPEC's own text checks WIP non-atomically "before the claim query").

---

### Task 1: Monorepo skeleton + dev infrastructure

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `.npmrc`, `docker-compose.yml`, `README.md`
- Create: `docs/SPEC-Foreman.md`, `docs/PRD-Foreman.md` (copied from `C:\Users\Davin\Downloads\`)
- Create: empty workspace dirs `apps/`, `packages/`, `integrations/`

**Interfaces:**
- Produces: a repo where `pnpm install`, `pnpm -r build`, `pnpm -r test` run clean, and `docker compose up -d` yields Postgres on 5433 + Redis on 6380. All later tasks assume this.

- [ ] **Step 1: git init + copy spec docs**

```bash
cd "C:\Users\Davin\Documents\Projects\project-management"
git init -b main
mkdir -p docs apps packages integrations
cp "C:\Users\Davin\Downloads\SPEC-Foreman.md" docs/
cp "C:\Users\Davin\Downloads\PRD-Foreman.md" docs/
```

- [ ] **Step 2: root config files**

`package.json`:
```json
{
  "name": "foreman",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@11.22.0",
  "scripts": {
    "build": "pnpm -r build",
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck",
    "db:up": "docker compose up -d",
    "db:down": "docker compose down"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "integrations/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`vitest.workspace.ts`:
```ts
export default ["packages/*", "apps/*"];
```

`.gitignore`:
```
node_modules/
dist/
*.tsbuildinfo
.env
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    ports: ["5433:5432"]
    environment:
      POSTGRES_PASSWORD: postgres
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 2s
      retries: 20
  redis:
    image: redis:7
    ports: ["6380:6379"]
volumes:
  pgdata:
```

- [ ] **Step 3: verify**

Run: `pnpm install && docker compose up -d --wait` then `docker compose ps` — both services healthy/running. `pnpm test` exits 0 (Vitest with no tests: pass `--passWithNoTests` in root script if needed).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: monorepo skeleton, dev infra (postgres 16, redis 7), spec docs"
```

---

### Task 2: `packages/events` — event taxonomy, payload schemas, validator

**Files:**
- Create: `packages/events/package.json`, `packages/events/tsconfig.json`, `packages/events/src/index.ts`, `packages/events/src/registry.ts`
- Test: `packages/events/src/registry.test.ts`

**Interfaces:**
- Produces:
  - `EVENT_TYPES: readonly string[]` — the full SPEC §2.2 taxonomy.
  - `type EventType` — union of those strings.
  - `validateEventPayload(type: string, payload: unknown): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string }` — strict (closed) schema validation; unknown type ⇒ `ok: false`.
  - `interface NewEvent { organisation_id: string; project_id?: string; agent_id?: string; work_item_id?: string; run_id?: string; type: EventType; payload: Record<string, unknown>; idempotency_key?: string; occurred_at?: Date }`

- [ ] **Step 1: package scaffold**

`packages/events/package.json`:
```json
{
  "name": "@foreman/events",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit", "build": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```
`tsconfig.json` extends `../../tsconfig.base.json` with `"noEmit": true`, `"include": ["src"]`. (Workspace packages are consumed as TS source via `main: src/index.ts` — no build step in Phase 1; Vitest and tsx handle TS natively.)

- [ ] **Step 2: failing tests**

`packages/events/src/registry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { EVENT_TYPES, validateEventPayload } from "./index.js";

describe("event registry", () => {
  it("contains the full SPEC §2.2 taxonomy", () => {
    for (const t of ["agent.announced","work.claimed","comm.subagent_spawned","tool.invoked","github.issue_synced","overview.regenerated","human.decided","work.lease_expired","brief.delivered","deploy.failed"]) {
      expect(EVENT_TYPES).toContain(t);
    }
    expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(36);
  });
  it("accepts a valid payload", () => {
    const r = validateEventPayload("work.progressed", { note: "half done", percent: 50 });
    expect(r.ok).toBe(true);
  });
  it("rejects unknown event types", () => {
    expect(validateEventPayload("work.hacked", {}).ok).toBe(false);
  });
  it("rejects extra keys (closed schemas)", () => {
    expect(validateEventPayload("agent.resumed", { surprise: 1 }).ok).toBe(false);
  });
  it("rejects wrong field types", () => {
    expect(validateEventPayload("work.reprioritised", { from: "high", to: 1 }).ok).toBe(false);
  });
  it("tool.invoked default shape is metadata-only", () => {
    expect(validateEventPayload("tool.invoked", { tool_name: "Bash", tool_use_id: "tu_1" }).ok).toBe(true);
    // input is permitted only as an explicit opt-in field, present-but-optional in the schema:
    expect(validateEventPayload("tool.invoked", { tool_name: "Bash", tool_use_id: "tu_1", input: { cmd: "ls" } }).ok).toBe(true);
  });
});
```

- [ ] **Step 3: run to verify failure** — `pnpm --filter @foreman/events test` fails (module not found).

- [ ] **Step 4: implement registry**

`packages/events/src/registry.ts` — zod schemas, all `.strict()`:
```ts
import { z } from "zod";

const uuid = z.string().uuid();
const str = z.string().min(1);

export const registry = {
  "agent.announced": z.object({ display_name: str, platform: str, model: z.string().optional(), capabilities: z.array(z.string()).default([]) }).strict(),
  "agent.heartbeat": z.object({ status: str, current_tool: z.string().optional(), current_work_item_id: uuid.optional() }).strict(),
  "agent.went_offline": z.object({ reason: z.string().optional() }).strict(),
  "agent.stalled": z.object({ threshold_sec: z.number().int(), last_transition_at: z.string() }).strict(),
  "agent.resumed": z.object({}).strict(),
  "agent.errored": z.object({ message: str }).strict(),

  "work.created": z.object({ title: str, kind: str, priority: z.number().int() }).strict(),
  "work.enqueued": z.object({ priority: z.number().int() }).strict(),
  "work.claimed": z.object({ agent_id: uuid, lease_expires_at: z.string() }).strict(),
  "work.progressed": z.object({ note: str, percent: z.number().min(0).max(100).optional() }).strict(),
  "work.blocked": z.object({ reason: str, blocked_on: z.string().optional() }).strict(),
  "work.unblocked": z.object({}).strict(),
  "work.checkpoint_requested": z.object({ checkpoint_id: uuid, question: str, options: z.array(z.string()).optional(), context: z.string().optional() }).strict(),
  "work.checkpoint_answered": z.object({ checkpoint_id: uuid, answer: str, answered_by: z.string() }).strict(),
  "work.completed": z.object({ summary: str, acceptance_results: z.array(z.object({ criterion: str, met: z.boolean() }).strict()), pr_url: z.string().optional(), commit_sha: z.string().optional() }).strict(),
  "work.failed": z.object({ reason: str }).strict(),
  "work.cancelled": z.object({ by: str }).strict(),
  "work.lease_expired": z.object({ agent_id: uuid }).strict(),
  "work.reprioritised": z.object({ from: z.number().int(), to: z.number().int() }).strict(),
  "work.rescheduled": z.object({ start_at: z.string().optional(), target_at: z.string().optional(), iteration_id: z.string().optional() }).strict(),

  "comm.message_sent": z.object({ from_agent_id: uuid, to_agent_id: uuid.optional(), broadcast_scope: z.enum(["project","organisation"]).optional(), message: str }).strict(),
  "comm.subagent_spawned": z.object({ parent_agent_id: uuid, child_agent_id: uuid, agent_type: z.string().optional() }).strict(),
  "comm.subagent_returned": z.object({ parent_agent_id: uuid, child_agent_id: uuid }).strict(),

  "tool.invoked": z.object({ tool_name: str, tool_use_id: str, input: z.record(z.unknown()).optional() }).strict(),
  "tool.returned": z.object({ tool_name: str, tool_use_id: str, duration_ms: z.number().int().optional(), is_error: z.boolean().optional() }).strict(),
  "tool.denied": z.object({ tool_name: str, tool_use_id: str, reason: z.string().optional() }).strict(),

  "github.issue_synced": z.object({ gh_repo: str, gh_issue_number: z.number().int(), gh_issue_node_id: str }).strict(),
  "github.pr_opened": z.object({ gh_repo: str, pr_number: z.number().int(), pr_url: str }).strict(),
  "github.pr_merged": z.object({ gh_repo: str, pr_number: z.number().int(), pr_url: str, merge_sha: z.string().optional() }).strict(),
  "github.check_updated": z.object({ gh_repo: str, check_run_id: z.number().int(), status: str, conclusion: z.string().optional() }).strict(),
  "github.project_item_changed": z.object({ gh_item_node_id: str, field_node_id: z.string().optional(), from: z.unknown().optional(), to: z.unknown().optional() }).strict(),

  "repo.endpoint_discovered": z.object({ method: str, path: str, framework: z.string().optional() }).strict(),
  "repo.endpoint_state_changed": z.object({ method: str, path: str, from: str, to: str }).strict(),
  "deploy.succeeded": z.object({ environment: z.string().optional(), sha: z.string().optional() }).strict(),
  "deploy.failed": z.object({ environment: z.string().optional(), sha: z.string().optional(), reason: z.string().optional() }).strict(),

  "overview.regenerated": z.object({ version: z.number().int(), sections: z.array(z.string()) }).strict(),
  "brief.generated": z.object({ brief_id: uuid, window_start: z.string(), window_end: z.string() }).strict(),
  "brief.delivered": z.object({ brief_id: uuid, channel: str }).strict(),

  "human.directed": z.object({ actor_user_id: uuid, target: str, directive: str }).strict(),
  "human.decided": z.object({ actor_user_id: uuid, checkpoint_id: uuid, answer: str }).strict(),
  "human.overrode": z.object({ actor_user_id: uuid, subject: str, note: z.string().optional() }).strict(),
} as const;

export type EventType = keyof typeof registry;
export const EVENT_TYPES = Object.keys(registry) as EventType[];
```

`packages/events/src/index.ts`:
```ts
import { registry, EVENT_TYPES, type EventType } from "./registry.js";
export { registry, EVENT_TYPES, type EventType };

export interface NewEvent {
  organisation_id: string;
  project_id?: string;
  agent_id?: string;
  work_item_id?: string;
  run_id?: string;
  type: EventType;
  payload: Record<string, unknown>;
  idempotency_key?: string;
  occurred_at?: Date;
}

export function validateEventPayload(type: string, payload: unknown):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string } {
  const schema = (registry as Record<string, import("zod").ZodTypeAny>)[type];
  if (!schema) return { ok: false, error: `unknown event type: ${type}` };
  const r = schema.safeParse(payload);
  return r.success
    ? { ok: true, payload: r.data as Record<string, unknown> }
    : { ok: false, error: r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
```

- [ ] **Step 5: run tests to green** — `pnpm --filter @foreman/events test`.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(events): event taxonomy with strict payload schemas and validator"`

---

### Task 3: `packages/db` — migrations, schema, RLS + guard test, event append

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`
- Create: `packages/db/migrations/0001_init.sql`, `packages/db/migrations/0002_rls.sql`
- Create: `packages/db/src/index.ts`, `packages/db/src/migrate.ts`, `packages/db/src/events.ts`, `packages/db/src/testing.ts`
- Test: `packages/db/src/migrate.test.ts`, `packages/db/src/rls.test.ts`, `packages/db/src/events.test.ts`

**Interfaces:**
- Consumes: `@foreman/events` (`NewEvent`, `validateEventPayload`).
- Produces:
  - `migrate(client: pg.Client): Promise<string[]>` — applies pending `migrations/*.sql` in filename order inside transactions, records them in `schema_migrations`, returns applied names.
  - `appendEvent(q: Queryable, evt: NewEvent): Promise<{ id: string | null; deduped: boolean }>` — validates payload, inserts; on idempotency-key conflict returns `{ id: null, deduped: true }`. `Queryable = { query: pg.Pool["query"] }` so it composes into callers' transactions.
  - `createTestDatabase(): Promise<TestDb>` where `TestDb = { adminPool: pg.Pool; servicePool: pg.Pool; appUrl: string; url: string; teardown(): Promise<void> }` — creates a uniquely named database on the compose server, runs migrations, returns pools: `adminPool` (superuser), `servicePool` (role `foreman_service`), and `appUrl` (connection string for role `foreman_app`, for RLS tests).

- [ ] **Step 1: package scaffold**

`packages/db/package.json` — name `@foreman/db`, same shape as Task 2's, dependencies: `pg ^8.13.0`, `@foreman/events` (`"workspace:*"`), devDependencies add `@types/pg`.

- [ ] **Step 2: write `0001_init.sql`** (SPEC §2.1 with minimal `users`/`brands` and the additions noted in Global Constraints):

```sql
create schema if not exists foreman;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tokens jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table organisations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  tier text not null default 'free' check (tier in ('free','team','business','oem')),
  isolation text not null default 'pooled' check (isolation in ('pooled','siloed')),
  brand_id uuid references brands(id),
  created_at timestamptz not null default now()
);

create table organisation_members (
  organisation_id uuid not null references organisations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','supervisor','viewer')),
  primary key (organisation_id, user_id)
);
create index on organisation_members (organisation_id, user_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  backbone text not null default 'github',
  gh_installation_id bigint,
  gh_project_node_id text,
  gh_repos text[] not null default '{}',
  field_map jsonb not null default '{}',
  wip_limit int not null default 10,
  stall_threshold_sec int not null default 900,
  created_at timestamptz not null default now()
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  display_name text not null,
  platform text not null,
  model text,
  capabilities text[] not null default '{}',
  integration_depth text not null default 'telemetry'
    check (integration_depth in ('telemetry','mcp','managed')),
  parent_agent_id uuid references agents(id),
  wip_limit int not null default 1,
  status text not null default 'idle'
    check (status in ('idle','working','blocked','stalled','offline','error')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table work_items (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  parent_id uuid references work_items(id),
  title text not null,
  intent text,
  acceptance jsonb not null default '[]',
  priority int not null default 100,
  status text not null default 'queued'
    check (status in ('draft','queued','claimed','in_progress','blocked','in_review','done','cancelled','failed')),
  kind text not null default 'task' check (kind in ('epic','story','task','bug','chore')),
  gh_issue_node_id text,
  gh_issue_number int,
  gh_repo text,
  gh_item_node_id text,
  start_at date,
  target_at date,
  iteration_id text,
  claimed_by uuid references agents(id),
  lease_expires_at timestamptz,
  enqueued_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on work_items (project_id, status, priority, enqueued_at);
create index on work_items (organisation_id);

create table work_item_deps (
  organisation_id uuid not null,
  blocked_id uuid not null references work_items(id) on delete cascade,
  blocker_id uuid not null references work_items(id) on delete cascade,
  source text not null default 'github',
  primary key (blocked_id, blocker_id)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  agent_id uuid not null references agents(id) on delete cascade,
  work_item_id uuid references work_items(id),
  external_session_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  cost_usd numeric(12,6) not null default 0
);

create table checkpoints (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  work_item_id uuid not null references work_items(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  question text not null,
  options jsonb,
  context text,
  status text not null default 'open' check (status in ('open','answered','expired')),
  answer text,
  answered_by uuid references users(id),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index on checkpoints (organisation_id, status);

create table agent_tokens (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  token_hash text not null unique,
  agent_id uuid references agents(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Phase 1 deliberately unpartitioned; see plan "Documented deviations" #1.
create table events (
  id bigserial primary key,
  organisation_id uuid not null,
  project_id uuid,
  agent_id uuid,
  work_item_id uuid,
  run_id uuid,
  type text not null,
  payload jsonb not null,
  idempotency_key text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create unique index events_org_idem on events (organisation_id, idempotency_key)
  where idempotency_key is not null;
create index on events (organisation_id, project_id, recorded_at desc);
create index on events (agent_id, recorded_at desc);
```

- [ ] **Step 3: write `0002_rls.sql`**

```sql
create or replace function foreman.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function foreman.is_member(org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from organisation_members m
    where m.organisation_id = org and m.user_id = foreman.current_user_id()
  );
$$;

do $$ begin create role foreman_service login password 'foreman_service' bypassrls; exception when duplicate_object then null; end $$;
do $$ begin create role foreman_app login password 'foreman_app'; exception when duplicate_object then null; end $$;

grant usage on schema public, foreman to foreman_service, foreman_app;
grant select, insert, update, delete on all tables in schema public to foreman_service, foreman_app;
grant usage, select on all sequences in schema public to foreman_service, foreman_app;
alter default privileges in schema public grant select, insert, update, delete on tables to foreman_service, foreman_app;
alter default privileges in schema public grant usage, select on sequences to foreman_service, foreman_app;

alter table organisations enable row level security;
create policy organisations_tenant on organisations
  using (foreman.is_member(id)) with check (foreman.is_member(id));

alter table organisation_members enable row level security;
create policy organisation_members_tenant on organisation_members
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));

-- identical pattern for every remaining organisation_id table:
alter table projects enable row level security;
create policy projects_tenant on projects
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table agents enable row level security;
create policy agents_tenant on agents
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table work_items enable row level security;
create policy work_items_tenant on work_items
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table work_item_deps enable row level security;
create policy work_item_deps_tenant on work_item_deps
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table runs enable row level security;
create policy runs_tenant on runs
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table checkpoints enable row level security;
create policy checkpoints_tenant on checkpoints
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table agent_tokens enable row level security;
create policy agent_tokens_tenant on agent_tokens
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table events enable row level security;
create policy events_tenant on events
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
```

- [ ] **Step 4: failing tests**

`packages/db/src/migrate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./testing.js";

describe("migrations", () => {
  it("applies cleanly and is idempotent on re-run", async () => {
    const db = await createTestDatabase();
    try {
      const t = await db.adminPool.query("select count(*)::int as n from schema_migrations");
      expect(t.rows[0].n).toBeGreaterThanOrEqual(2);
      // re-running migrate must apply nothing — createTestDatabase already ran it;
      // covered by rerunMigrations helper returning []
      expect(await db.rerunMigrations()).toEqual([]);
    } finally { await db.teardown(); }
  });
});
```

`packages/db/src/rls.test.ts` — **the WL-7 guard + cross-tenant attack**:
```ts
import { describe, expect, it } from "vitest";
import pg from "pg";
import { createTestDatabase, seedOrgWithUser } from "./testing.js";

describe("RLS", () => {
  it("guard: every organisation_id table has RLS enabled and a policy", async () => {
    const db = await createTestDatabase();
    try {
      const r = await db.adminPool.query(`
        select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind in ('r','p')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organisation_id' and not a.attisdropped)
          and (not c.relrowsecurity
               or not exists (select 1 from pg_policy p where p.polrelid = c.oid))`);
      expect(r.rows).toEqual([]); // any row here is an unprotected tenant table
    } finally { await db.teardown(); }
  });

  it("blocks cross-tenant reads and writes for foreman_app", async () => {
    const db = await createTestDatabase();
    try {
      const a = await seedOrgWithUser(db.servicePool, "org-a");
      const b = await seedOrgWithUser(db.servicePool, "org-b");
      await db.servicePool.query(
        "insert into projects (organisation_id, name) values ($1,'secret-b')", [b.orgId]);

      const appClient = new pg.Client({ connectionString: db.appUrl });
      await appClient.connect();
      try {
        await appClient.query("select set_config('app.user_id', $1, false)", [a.userId]);
        const read = await appClient.query("select * from projects");
        expect(read.rows.every(r => r.organisation_id === a.orgId)).toBe(true);
        expect(read.rows.find(r => r.name === "secret-b")).toBeUndefined();
        await expect(
          appClient.query("insert into projects (organisation_id, name) values ($1,'evil')", [b.orgId])
        ).rejects.toThrow(); // with check violation
      } finally { await appClient.end(); }
    } finally { await db.teardown(); }
  });
});
```

`packages/db/src/events.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createTestDatabase, seedOrgWithUser } from "./testing.js";
import { appendEvent } from "./events.js";

describe("appendEvent", () => {
  it("writes a validated event and dedupes on idempotency key", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId } = await seedOrgWithUser(db.servicePool, "org-e");
      const evt = { organisation_id: orgId, type: "agent.resumed" as const, payload: {}, idempotency_key: "k1" };
      const first = await appendEvent(db.servicePool, evt);
      expect(first.deduped).toBe(false);
      const second = await appendEvent(db.servicePool, evt);
      expect(second.deduped).toBe(true);
      const n = await db.servicePool.query("select count(*)::int as n from events");
      expect(n.rows[0].n).toBe(1);
    } finally { await db.teardown(); }
  });
  it("rejects invalid payloads", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId } = await seedOrgWithUser(db.servicePool, "org-f");
      await expect(appendEvent(db.servicePool, {
        organisation_id: orgId, type: "work.progressed", payload: { bogus: true },
      } as never)).rejects.toThrow(/note/);
    } finally { await db.teardown(); }
  });
});
```

- [ ] **Step 5: run tests to verify failure**, then implement:

`packages/db/src/migrate.ts`:
```ts
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function migrate(client: pg.Client | pg.PoolClient, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const files = (await fs.readdir(dir)).filter(f => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const seen = await client.query("select 1 from schema_migrations where name = $1", [f]);
    if (seen.rowCount) continue;
    const sql = await fs.readFile(path.join(dir, f), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [f]);
      await client.query("commit");
    } catch (e) { await client.query("rollback"); throw new Error(`migration ${f} failed: ${(e as Error).message}`); }
    applied.push(f);
  }
  return applied;
}
```

`packages/db/src/events.ts`:
```ts
import { validateEventPayload, type NewEvent } from "@foreman/events";
import type pg from "pg";

export type Queryable = { query: pg.Pool["query"] };

export async function appendEvent(q: Queryable, evt: NewEvent): Promise<{ id: string | null; deduped: boolean }> {
  const v = validateEventPayload(evt.type, evt.payload);
  if (!v.ok) throw new Error(`invalid event ${evt.type}: ${v.error}`);
  const res = await q.query(
    `insert into events (organisation_id, project_id, agent_id, work_item_id, run_id, type, payload, idempotency_key, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9, now()))
     on conflict (organisation_id, idempotency_key) where idempotency_key is not null do nothing
     returning id`,
    [evt.organisation_id, evt.project_id ?? null, evt.agent_id ?? null, evt.work_item_id ?? null,
     evt.run_id ?? null, evt.type, JSON.stringify(v.payload), evt.idempotency_key ?? null, evt.occurred_at ?? null]);
  return res.rowCount ? { id: String(res.rows[0].id), deduped: false } : { id: null, deduped: true };
}
```
Note: `ON CONFLICT` against a partial unique index needs the matching `where` clause exactly as above; if pg complains, fall back to catching unique_violation (`23505`).

`packages/db/src/testing.ts`:
```ts
import crypto from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.js";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL
  ?? "postgres://postgres:postgres@localhost:5433/postgres";

function withDb(url: string, db: string, user?: string, pass?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = pass ?? user; }
  return u.toString();
}

export interface TestDb {
  adminPool: pg.Pool;
  servicePool: pg.Pool;
  appUrl: string;
  url: string;
  rerunMigrations(): Promise<string[]>;
  teardown(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDb> {
  const name = `foreman_test_${crypto.randomBytes(8).toString("hex")}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();

  const url = withDb(ADMIN_URL, name);
  const adminPool = new pg.Pool({ connectionString: url, max: 5 });
  const c = await adminPool.connect();
  try { await migrate(c); } finally { c.release(); }

  const servicePool = new pg.Pool({ connectionString: withDb(ADMIN_URL, name, "foreman_service"), max: 20 });
  const appUrl = withDb(ADMIN_URL, name, "foreman_app");

  return {
    adminPool, servicePool, appUrl, url,
    async rerunMigrations() {
      const cc = await adminPool.connect();
      try { return await migrate(cc); } finally { cc.release(); }
    },
    async teardown() {
      await servicePool.end();
      await adminPool.end();
      const r = new pg.Client({ connectionString: ADMIN_URL });
      await r.connect();
      await r.query(`drop database if exists ${name} with (force)`);
      await r.end();
    },
  };
}

export async function seedOrgWithUser(pool: pg.Pool, slug: string): Promise<{ orgId: string; userId: string; projectId: string }> {
  const org = await pool.query("insert into organisations (slug) values ($1) returning id", [slug]);
  const user = await pool.query("insert into users (email) values ($1) returning id", [`${slug}@test.local`]);
  await pool.query("insert into organisation_members (organisation_id, user_id, role) values ($1,$2,'owner')",
    [org.rows[0].id, user.rows[0].id]);
  const project = await pool.query("insert into projects (organisation_id, name) values ($1,$2) returning id",
    [org.rows[0].id, `${slug}-project`]);
  return { orgId: org.rows[0].id, userId: user.rows[0].id, projectId: project.rows[0].id };
}
```

`packages/db/src/index.ts` re-exports `migrate`, `appendEvent`, `Queryable`, testing helpers stay importable via `@foreman/db/testing` (add `"exports"` map: `.` → `./src/index.ts`, `./testing` → `./src/testing.ts`).

- [ ] **Step 6: run to green** — `pnpm --filter @foreman/db test` (compose must be up).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(db): schema, migrations, RLS with build-failing guard test, event append with idempotency"`

---

### Task 4: `packages/backbone` — the v3 seam

**Files:**
- Create: `packages/backbone/package.json`, `packages/backbone/tsconfig.json`, `packages/backbone/src/index.ts`
- Test: `packages/backbone/src/index.test.ts`

**Interfaces:**
- Produces (verbatim SPEC §8, plus the referenced types):

```ts
export interface ProjectRef { projectId: string }
export interface WorkItemRef { workItemId: string }
export interface Schedule { startAt?: string; targetAt?: string; iterationId?: string }
export interface NewWorkItem { title: string; intent?: string; kind?: "epic"|"story"|"task"|"bug"|"chore"; priority?: number; acceptance?: string[]; parent?: WorkItemRef; repo?: string }
export interface WorkItem extends NewWorkItem, WorkItemRef { status: string; ghIssueNumber?: number; ghRepo?: string }
export interface RunStatus { state: "queued"|"in_progress"|"completed"; summary?: string; conclusion?: "success"|"failure"|"cancelled"; detailsUrl?: string; headSha?: string }
export type BackboneEvent =
  | { kind: "work_item_changed"; item: WorkItem }
  | { kind: "dependency_changed"; blocked: WorkItemRef; blocker: WorkItemRef; removed: boolean }
  | { kind: "schedule_changed"; item: WorkItemRef; schedule: Schedule };
export type Unsubscribe = () => void;

export interface Backbone {
  listWorkItems(project: ProjectRef, since?: Date): Promise<WorkItem[]>;
  createWorkItem(project: ProjectRef, item: NewWorkItem): Promise<WorkItem>;
  updateSchedule(item: WorkItemRef, s: Schedule): Promise<void>;
  linkParent(child: WorkItemRef, parent: WorkItemRef): Promise<void>;
  addDependency(blocked: WorkItemRef, blocker: WorkItemRef): Promise<void>;
  reportRun(item: WorkItemRef, run: RunStatus): Promise<void>;
  subscribe(handler: (e: BackboneEvent) => void): Unsubscribe;
}
```

- [ ] **Step 1: write a type-level test** (`index.test.ts`): declare a `class FakeBackbone implements Backbone` with in-memory arrays; assert `createWorkItem` → appears in `listWorkItems`, `subscribe` handler fires on create, `Unsubscribe` stops it. This pins the contract so `tsc` breaks if anyone drifts it.
- [ ] **Step 2: run to green** — `pnpm --filter @foreman/backbone test`.
- [ ] **Step 3: Commit** — `git commit -m "feat(backbone): Backbone interface — the pluggable-backend seam (SPEC §8)"`

---

### Task 5: Queue engine — atomic claim, leases, WIP, dependency gating (`QUE-2..6`)

**Files:**
- Create: `packages/db/src/queue.ts`, `apps/scheduler/package.json`, `apps/scheduler/tsconfig.json`, `apps/scheduler/src/main.ts`
- Test: `packages/db/src/queue.test.ts`

**Interfaces:**
- Consumes: `appendEvent`, `createTestDatabase`, `seedOrgWithUser`.
- Produces (all exported from `@foreman/db`):
  - `class WipLimitExceededError extends Error { code: "wip_limit_exceeded"; scope: "agent" | "project" }`
  - `claimNextWorkItem(pool: pg.Pool, args: { projectId: string; agentId: string; leaseSeconds?: number }): Promise<WorkItemRow | null>` — null means "queue empty for you" (distinct from the thrown WIP error, per `QUE-5`).
  - `extendLease(pool, workItemId: string, agentId: string, leaseSeconds?: number): Promise<boolean>`
  - `sweepExpiredLeases(pool): Promise<number>` — expired count; each expiry appends `work.lease_expired` and requeues at original priority (`QUE-4`).
  - `enqueueWorkItem(pool, args: { organisationId; projectId; title; intent?; acceptance?: string[]; priority?; kind? }): Promise<WorkItemRow>` — inserts + appends `work.created` and `work.enqueued`.
  - `completeWorkItem(pool, args: { workItemId; agentId; summary; acceptanceResults: {criterion: string; met: boolean}[]; prUrl?; commitSha? }): Promise<void>` — rejects (`Error` code `acceptance_verdict_required`) if the item has acceptance criteria and `acceptanceResults` is empty (`QUE-7`); sets `done`, appends `work.completed`.
  - `type WorkItemRow` — the `work_items` row shape (id, organisation_id, project_id, title, intent, acceptance, priority, status, kind, claimed_by, lease_expires_at, enqueued_at).

- [ ] **Step 1: failing tests** (`packages/db/src/queue.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { createTestDatabase, seedOrgWithUser } from "./testing.js";
import { claimNextWorkItem, enqueueWorkItem, completeWorkItem, sweepExpiredLeases, WipLimitExceededError } from "./queue.js";

async function seedAgent(pool, orgId, projectId, name, wip = 1) {
  const r = await pool.query(
    "insert into agents (organisation_id, project_id, display_name, platform, wip_limit) values ($1,$2,$3,'test',$4) returning id",
    [orgId, projectId, name, wip]);
  return r.rows[0].id as string;
}

describe("queue engine", () => {
  it("QUE-3: 100 concurrent claims over 10 items yield 10 distinct winners", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q3");
      for (let i = 0; i < 10; i++)
        await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: `item ${i}` });
      const agents = await Promise.all(Array.from({ length: 100 }, (_, i) =>
        seedAgent(db.servicePool, orgId, projectId, `a${i}`)));
      const results = await Promise.all(agents.map(a =>
        claimNextWorkItem(db.servicePool, { projectId, agentId: a }).catch(e => e)));
      const wins = results.filter(r => r && !(r instanceof Error));
      expect(wins).toHaveLength(10);
      expect(new Set(wins.map((w: any) => w.id)).size).toBe(10);
    } finally { await db.teardown(); }
  }, 60_000);

  it("QUE-2: strict priority order with enqueued_at tiebreak", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q2");
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "later", priority: 50 });
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "urgent", priority: 1 });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a", 5);
      const first = await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      expect(first!.title).toBe("urgent");
    } finally { await db.teardown(); }
  });

  it("QUE-6: blocked items are unclaimable until the blocker completes", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q6");
      const blocker = await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "A", priority: 2 });
      const blocked = await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "B", priority: 1 });
      await db.servicePool.query(
        "insert into work_item_deps (organisation_id, blocked_id, blocker_id) values ($1,$2,$3)",
        [orgId, blocked.id, blocker.id]);
      const a = await seedAgent(db.servicePool, orgId, projectId, "a", 5);
      const c1 = await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      expect(c1!.id).toBe(blocker.id); // B has higher priority but is dep-gated
      await completeWorkItem(db.servicePool, { workItemId: blocker.id, agentId: a, summary: "done", acceptanceResults: [] });
      const c2 = await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      expect(c2!.id).toBe(blocked.id);
    } finally { await db.teardown(); }
  });

  it("QUE-5: typed WIP errors for agent and project limits", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q5");
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "1" });
      await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "2" });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a", 1);
      await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      await expect(claimNextWorkItem(db.servicePool, { projectId, agentId: a }))
        .rejects.toThrow(WipLimitExceededError);
    } finally { await db.teardown(); }
  });

  it("QUE-4: expired lease requeues at original priority and logs work.lease_expired", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q4");
      const item = await enqueueWorkItem(db.servicePool, { organisationId: orgId, projectId, title: "x", priority: 7 });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a");
      await claimNextWorkItem(db.servicePool, { projectId, agentId: a, leaseSeconds: 0 });
      await new Promise(r => setTimeout(r, 50));
      const n = await sweepExpiredLeases(db.servicePool);
      expect(n).toBe(1);
      const row = await db.servicePool.query("select status, priority, claimed_by from work_items where id=$1", [item.id]);
      expect(row.rows[0]).toMatchObject({ status: "queued", priority: 7, claimed_by: null });
      const evt = await db.servicePool.query("select payload from events where type='work.lease_expired' and work_item_id=$1", [item.id]);
      expect(evt.rows[0].payload.agent_id).toBe(a);
    } finally { await db.teardown(); }
  });

  it("QUE-7: completion without an acceptance verdict is rejected when criteria exist", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "q7");
      const item = await enqueueWorkItem(db.servicePool, {
        organisationId: orgId, projectId, title: "x", acceptance: ["tests pass"] });
      const a = await seedAgent(db.servicePool, orgId, projectId, "a");
      await claimNextWorkItem(db.servicePool, { projectId, agentId: a });
      await expect(completeWorkItem(db.servicePool, {
        workItemId: item.id, agentId: a, summary: "done", acceptanceResults: [] }))
        .rejects.toThrow(/acceptance/);
    } finally { await db.teardown(); }
  });
});
```

- [ ] **Step 2: run to verify failure**, then implement `packages/db/src/queue.ts`:

```ts
import pg from "pg";
import { appendEvent } from "./events.js";

export class WipLimitExceededError extends Error {
  code = "wip_limit_exceeded" as const;
  constructor(public scope: "agent" | "project") { super(`wip_limit_exceeded:${scope}`); }
}

export interface WorkItemRow { /* row shape per Interfaces block */ }

const CLAIM_SQL = `
update work_items w set status = 'claimed', claimed_by = $2,
       lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
where w.id = (
  select id from work_items
  where project_id = $1 and status = 'queued'
    and not exists (select 1 from work_item_deps d
                    join work_items b on b.id = d.blocker_id
                    where d.blocked_id = work_items.id and b.status <> 'done')
  order by priority asc, enqueued_at asc
  for update skip locked limit 1)
returning *`;

export async function claimNextWorkItem(pool: pg.Pool,
  { projectId, agentId, leaseSeconds = 900 }: { projectId: string; agentId: string; leaseSeconds?: number },
): Promise<WorkItemRow | null> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const agent = await c.query("select organisation_id, wip_limit from agents where id = $1 for update", [agentId]);
    if (!agent.rowCount) throw new Error("unknown agent");
    const proj = await c.query("select wip_limit from projects where id = $1 for update", [projectId]);
    if (!proj.rowCount) throw new Error("unknown project");
    const active = await c.query(
      `select count(*) filter (where claimed_by = $1)::int as agent_n,
              count(*)::int as project_n
       from work_items where project_id = $2 and status in ('claimed','in_progress')`,
      [agentId, projectId]);
    if (active.rows[0].agent_n >= agent.rows[0].wip_limit) throw new WipLimitExceededError("agent");
    if (active.rows[0].project_n >= proj.rows[0].wip_limit) throw new WipLimitExceededError("project");
    const res = await c.query(CLAIM_SQL, [projectId, agentId, leaseSeconds]);
    if (res.rowCount) {
      const item = res.rows[0];
      await appendEvent(c, {
        organisation_id: item.organisation_id, project_id: projectId,
        agent_id: agentId, work_item_id: item.id, type: "work.claimed",
        payload: { agent_id: agentId, lease_expires_at: new Date(item.lease_expires_at).toISOString() },
      });
      await c.query("commit");
      return item;
    }
    await c.query("commit");
    return null;
  } catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}
```
(`appendEvent`'s `Queryable` accepts a `PoolClient` — widen its type to `{ query: (...args:any[]) => Promise<pg.QueryResult> }` if tsc complains.)

`sweepExpiredLeases`:
```ts
export async function sweepExpiredLeases(pool: pg.Pool): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const res = await c.query(`
      update work_items w
      set status = 'queued', claimed_by = null, lease_expires_at = null, updated_at = now()
      from (select id, claimed_by, organisation_id, project_id from work_items
            where status in ('claimed','in_progress') and lease_expires_at < now()
            for update skip locked) e
      where w.id = e.id
      returning w.id, e.claimed_by as agent, e.organisation_id, e.project_id`);
    for (const r of res.rows) {
      await appendEvent(c, { organisation_id: r.organisation_id, project_id: r.project_id,
        agent_id: r.agent, work_item_id: r.id, type: "work.lease_expired", payload: { agent_id: r.agent } });
    }
    await c.query("commit");
    return res.rowCount ?? 0;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
```

`enqueueWorkItem`, `extendLease` (update `lease_expires_at` where `claimed_by = agentId`, return rowCount>0), `completeWorkItem` (verify `claimed_by = agentId` OR status queued→error "not claimed by you"; enforce QUE-7; set `status='done'`; append `work.completed`) — all following the same begin/commit + `appendEvent` pattern.

`apps/scheduler/src/main.ts` — thin runner, not under test:
```ts
import pg from "pg";
import { sweepExpiredLeases } from "@foreman/db";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const INTERVAL = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);
setInterval(() => sweepExpiredLeases(pool).then(n => n && console.log(`requeued ${n} expired leases`)).catch(err => console.error("sweep failed", err)), INTERVAL);
console.log("foreman-scheduler: lease sweeper running");
```
`apps/scheduler/package.json`: name `foreman-scheduler`, script `start: tsx src/main.ts`, deps `pg`, `@foreman/db` (`workspace:*`).

- [ ] **Step 3: run to green** — `pnpm --filter @foreman/db test` (the 100-claimant test may need pool `max` ≥ 20; it's set in testing.ts).
- [ ] **Step 4: Commit** — `git commit -m "feat(queue): atomic claim with dep gating, leases, WIP limits, sweeper (QUE-2..7)"`

---

### Task 6: `apps/mcp` — MCP server with full agent loop (`AGT-1,3,5,7`, `§3.2`, `§3.5`)

**Files:**
- Create: `apps/mcp/package.json`, `apps/mcp/tsconfig.json`, `apps/mcp/src/auth.ts`, `apps/mcp/src/server.ts`, `apps/mcp/src/http.ts`, `apps/mcp/src/main.ts`
- Test: `apps/mcp/src/loop.test.ts`, `apps/mcp/src/auth.test.ts`

**Interfaces:**
- Consumes: `@foreman/db` (`appendEvent`, `claimNextWorkItem`, `enqueueWorkItem`, `completeWorkItem`, `extendLease`, `WipLimitExceededError`), `@foreman/events`.
- Produces:
  - `createAgentToken(pool, { organisationId, projectId }): Promise<{ token: string; id: string }>` — token format `fmn_agt_<24 base64url bytes>`, sha256-hex stored in `agent_tokens.token_hash`.
  - `authenticate(pool, authorizationHeader: string | undefined): Promise<AuthCtx | null>` where `AuthCtx = { tokenId: string; organisationId: string; projectId: string; agentId: string | null }` (null until announce binds one; updates `last_used_at`; revoked ⇒ null).
  - `buildMcpServer(pool: pg.Pool, ctx: AuthCtx): McpServer` — registers the tools below.
  - `createApp(pool: pg.Pool): express.Express` — `POST /mcp` with stateless per-request server+transport; `401` JSON-RPC error when auth fails; `GET /healthz` → 200.

**Tool surface (all `foreman__*`, zod input schemas, JSON results in a single `text` content block plus `structuredContent`):**

| Tool | Behaviour |
|---|---|
| `foreman__agent_announce` | Input `{display_name, platform, model?, capabilities?}`. If `ctx.agentId` null: insert `agents` row (`integration_depth:'mcp'`, project from token), bind `agent_tokens.agent_id`. Else update display/model/capabilities. Append `agent.announced`. Return `{agent_id, project_id, poll_interval_ms: 2000, server_time}` |
| `foreman__agent_heartbeat` | Input `{status, current_tool?, current_work_item_id?}` (status enum from agents.status check). Update `agents.status,last_seen_at`; if `current_work_item_id` present, `extendLease`. Append `agent.heartbeat`. Return `{ack: true, directives: []}` |
| `foreman__work_claim` | Input `{}`. Requires announce (agentId else tool error `not_announced`). `claimNextWorkItem`; on `WipLimitExceededError` return tool error with `code:"wip_limit_exceeded"`; on null return `{status:"empty", retry_after_ms: 2000}`; else `{status:"assigned", work_item: {id,title,intent,acceptance,priority,kind}}` |
| `foreman__work_report` | Input `{work_item_id, progress_note, percent?}`. Verify `claimed_by = ctx.agentId` (typed error `not_yours` otherwise); set status `in_progress`; `extendLease`; append `work.progressed` |
| `foreman__work_block` | Input `{work_item_id, reason, blocked_on?}` → status `blocked`, append `work.blocked` |
| `foreman__work_complete` | Input `{work_item_id, summary, acceptance_results: [{criterion, met}], pr_url?, commit_sha?}` → `completeWorkItem`; QUE-7 rejection surfaces as tool error `acceptance_verdict_required`. Return `{ack: true}` |
| `foreman__work_checkpoint` | Input `{work_item_id, question, options?, context?}` → insert `checkpoints` row, append `work.checkpoint_requested`, set item status `blocked`. Return `{checkpoint_id, status: "pending", poll_interval_ms: 2000}` |
| `foreman__checkpoint_poll` | Input `{checkpoint_id}` → `{status: "open"}` or `{status: "answered", answer}`; when answered also flip item back to `in_progress` and append `work.unblocked` (first poll after answer) |
| `foreman__comm_send` | Input `{to_agent_id?, broadcast_scope?, message}` (exactly one of the first two) → append `comm.message_sent` (from = ctx.agentId). Return `{delivered: true}` |
| `foreman__context_get` | Input `{sections?}` → `{project: {id, name}, counts: {queued, claimed, in_progress, blocked, done}}` from `work_items` group-by |

- [ ] **Step 1: package scaffold.** Deps: `@modelcontextprotocol/sdk` (pin the current release — **check current API with context7 before writing**; expect `McpServer.registerTool` + `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` for stateless), `express@^4`, `pg`, `zod`, `@foreman/db`, `@foreman/events`. Dev: `supertest` not needed — the SDK client is the test client.

- [ ] **Step 2: failing auth test** (`auth.test.ts`): create token → `authenticate(pool, "Bearer " + token)` returns ctx with right org/project; garbage token → null; revoked (`update agent_tokens set revoked_at = now()`) → null; `last_used_at` set after use.

- [ ] **Step 3: failing full-loop test** (`loop.test.ts`) — the Task-level acceptance test:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestDatabase, seedOrgWithUser } from "@foreman/db/testing";
import { enqueueWorkItem } from "@foreman/db";
import { createAgentToken } from "./auth.js";
import { createApp } from "./http.js";

async function startServer(pool) {
  const app = createApp(pool);
  const server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise(r => server.close(r)) };
}

describe("MCP full agent loop", () => {
  it("announce → claim(empty) → claim(assigned) → report → complete", async () => {
    const db = await createTestDatabase();
    const srv = await startServer(db.servicePool);
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "loop");
      const { token } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId });

      const client = new Client({ name: "test-agent", version: "0.0.1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(srv.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }));

      const call = async (name: string, args: object) => {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError ?? false).toBe(false);
        return JSON.parse((r.content as { type: string; text: string }[])[0].text);
      };

      const hello = await call("foreman__agent_announce",
        { display_name: "loop-agent", platform: "test", capabilities: ["ts"] });
      expect(hello.agent_id).toBeTruthy();

      const empty = await call("foreman__work_claim", {});
      expect(empty.status).toBe("empty");

      const item = await enqueueWorkItem(db.servicePool, {
        organisationId: orgId, projectId, title: "build the thing",
        acceptance: ["it builds"] });

      const claim = await call("foreman__work_claim", {});
      expect(claim.status).toBe("assigned");
      expect(claim.work_item.id).toBe(item.id);

      await call("foreman__work_report", { work_item_id: item.id, progress_note: "halfway", percent: 50 });
      await call("foreman__work_complete", {
        work_item_id: item.id, summary: "built it",
        acceptance_results: [{ criterion: "it builds", met: true }] });

      const status = await db.servicePool.query("select status from work_items where id=$1", [item.id]);
      expect(status.rows[0].status).toBe("done");
      const types = await db.servicePool.query(
        "select type from events where work_item_id=$1 order by id", [item.id]);
      expect(types.rows.map(r => r.type)).toEqual(
        expect.arrayContaining(["work.created","work.enqueued","work.claimed","work.progressed","work.completed"]));
      await client.close();
    } finally { await srv.close(); await db.teardown(); }
  }, 60_000);

  it("rejects a missing/bad bearer token", async () => {
    const db = await createTestDatabase();
    const srv = await startServer(db.servicePool);
    try {
      const client = new Client({ name: "anon", version: "0.0.1" });
      await expect(client.connect(new StreamableHTTPClientTransport(new URL(srv.url))))
        .rejects.toThrow();
    } finally { await srv.close(); await db.teardown(); }
  });
});
```

- [ ] **Step 4: implement** `auth.ts` (sha256 via `node:crypto`; constant-time not required for random 192-bit tokens hashed at rest, but use hash lookup by exact match), `server.ts` (tools table above; every handler wraps its result as `{content: [{type: "text", text: JSON.stringify(out)}], structuredContent: out}`; tool errors as `{isError: true, content: [{type:"text", text: JSON.stringify({code, message})}]}`), `http.ts`:

```ts
// per-request stateless pattern
app.post("/mcp", async (req, res) => {
  const ctx = await authenticate(pool, req.headers.authorization);
  if (!ctx) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
    return;
  }
  const server = buildMcpServer(pool, ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```
(Requires `express.json()` before the route; verify against the SDK's current stateless example via context7 — if the SDK expects the raw stream, drop the json middleware for this route and pass nothing as body.)

`main.ts`: `createApp(new pg.Pool({connectionString: process.env.DATABASE_URL})).listen(process.env.PORT ?? 8811)`.

- [ ] **Step 5: run to green** — `pnpm --filter foreman-mcp test`, then full suite `pnpm test` at root.
- [ ] **Step 6: Commit** — `git commit -m "feat(mcp): stateless streamable-http MCP server; full announce→claim→report→complete loop"`

---

## Phase boundaries (later plans, not this one)

- **Phase 2:** GitHub App (webhook verify/dedupe, token cache, issue sync, Projects v2 field mapping), projector service, echo suppression. Requires resolving SPEC §11 `[?]` items 3–7.
- **Phase 3:** foreman-api (REST + SSE), React web app (Agent View table + Gantt), stall detection, cost aggregation.
- **Phase 4:** MCP tasks-extension + 2026-07-28 negotiation (SPEC §11 items 1–2), Claude Code hooks plugin, briefs, gen service.

## Self-Review (done at plan time)

- **Spec coverage (Phase-1 slice):** QUE-2..7 → Task 5; AGT-3/5(partial)/7 → Task 6; X-1/X-2 → Tasks 3, 5, 6 (all mutations append events, idempotent append); WL-7 → Task 3 guard test; §8 Backbone seam → Task 4. AGT-1 full revision negotiation and AGT-2 tasks-extension are explicitly deferred (deviation #2).
- **Type consistency:** `appendEvent` takes `Queryable` and is called with both `Pool` and `PoolClient` — Task 5 notes the widened type. `WorkItemRow` produced in Task 5 is what Task 6's claim tool returns. `seedOrgWithUser` returns `projectId` used by Tasks 5–6.
- **Placeholder scan:** `WorkItemRow` body is defined by its Interfaces block (row shape of `work_items`); `enqueueWorkItem`/`extendLease`/`completeWorkItem` bodies follow the fully-shown begin/commit+appendEvent pattern with behaviour pinned by the tests in Step 1 — implementer discretion is bounded by failing tests, which is the intent.
