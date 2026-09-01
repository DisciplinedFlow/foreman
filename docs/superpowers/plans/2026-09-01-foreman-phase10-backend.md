# Foreman Phase 10 — Backend Completion Implementation Plan

> **EXECUTED 01-09-2026** — all 6 tasks landed on main (commits `0b4be80..HEAD`), 360 tests
> green across 81 files, `pnpm -r typecheck` clean across all 16 workspace projects that carry a
> typecheck script. GitHub sync now surfaces failures (`sync_jobs.last_error`), reaps jobs stuck
> `running`, and throws loudly on an unwired handler instead of silently marking the job done;
> every event kind gets coverage; the Board's drag-and-drop persists status transitions
> (`work.status_changed`); a new provider-agnostic MCP-client agent runner
> (`integrations/foreman-agent`) lets Ollama/OpenAI/Anthropic/Google agents join the fleet with
> no provider key ever reaching a Foreman service; the Metrics tab's heatmap has a real weekly
> merge-activity backend; and the Phase-9 audit's C2/C3 fail-fast gaps are closed —
> `FOREMAN_SESSION_SECRET` now throws at boot in production when unset or under 32 characters
> (loud-warned dev default otherwise), `/auth/dev-login` is opt-in via `FOREMAN_DEV_AUTH=1`
> (default off, independent of `NODE_ENV`), and `apps/api`/`apps/mcp`/`apps/ingest`/`apps/github`
> each mount a catch-all JSON error middleware mirroring `apps/control`'s. Deviations (recorded
> in the plan body and in `docs/hosted.md` §6): the deep `GithubBackbone` transactional split,
> RBAC, SSRF egress validation, event-table indexes, scheduler advisory locks, the blocked-item
> lease sweep, and event `payload_version` are documented deferrals, not silently skipped — none
> of them were in scope for this phase.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh senior-developer implementer per task → code-reviewer gate → fix loop). Steps use checkbox (`- [ ]`) tracking.

**Goal:** Make the backend actually complete for the two things the product promises and the new UI implies: a GitHub repo you connect works reliably and observably, agents from *any* provider (local Ollama, OpenAI, Anthropic, Google) can join the fleet, and the new UI surfaces (Board transitions, Metrics heatmap) have real backends. Plus the fail-fast security wins that gate safe operation.

**Architecture:** Everything stays on the established seams — events are the write path (`appendEvent`, strict zod registry), reads go through `withUser`/RLS in `apps/api`, GitHub writes flow through `sync_jobs` → dispatcher → `GithubBackbone`, agents speak MCP (`apps/mcp`, `foreman__*` tools, bearer token). The new agent runner is an **MCP client**, not a change to the server: it connects with a token like any agent and drives a pluggable provider. No provider key ever reaches the Foreman services (agents hold their own).

**Tech Stack:** existing workspace + `@modelcontextprotocol/sdk` client (already a dependency). Provider calls use `fetch` (no vendored SDKs) so Ollama/OpenAI/Anthropic/Google are all config, not new deps.

**Spec:** PRD §2.2 (queue), §2.4 (agents/MCP), §2.6 (GitHub sync), §1.7 (metrics); SPEC §3 (MCP loop), §5.6 (manifest); the Phase-9 audit backlog (security C2/C3, architecture #1).

## Global Constraints

Everything from Phases 1-9 holds. New:

- **Events are the only write path for facts.** New state changes append a typed, strict-zod event and derive from it; no fact written without an event.
- **No provider key in Foreman services.** The agent runner (an external client) holds provider keys; the Foreman backend never gains an `OPENAI_API_KEY`/`OLLAMA`/`GOOGLE_API_KEY` reference. The one existing LLM key (`ANTHROPIC_API_KEY`, overview prose only) stays as-is.
- **Provider calls are dependency-free** (`fetch` against each provider's HTTP API); no `openai`/`ollama`/`@google/*` npm packages.
- **RLS + tokens unchanged**: agent auth stays the `fmn_agt_` bearer path; api reads stay under `withUser`.
- **Tests + typecheck green** before each commit (`pnpm test`, `pnpm -r typecheck`). Commit with explicit pathspecs (never `git add -A`; `.idea/` stays untouched). Trailer on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01APiZX3w8HYpNbHouG1gQnb`.

### Documented deferrals (not in this phase; recorded so scope is honest)
- **Deep transactional double-write fix** (audit #1's hardest part — `GithubBackbone` using its own pool so a retry can double-create a GitHub issue): needs the Backbone split into remote-I/O + a `WorkItemWriter`. T1 adds the failure *surface* and a reaper; the transactional split is its own phase.
- **RBAC (I1), SSRF egress validation (I2), event indexes (#3), scheduler advisory locks (#6), blocked-item lease sweep (#7), event `payload_version` (#8)** — enumerated for a later hardening phase; T6 does only the cheap fail-fast security wins.

## File Structure
```
packages/db/migrations/0009_sync_reliability.sql   # sync_jobs.last_error, locked_at
apps/github/src/jobs.ts                             # completeSyncJob(error), claimSyncJob(locked_at), reaper
apps/github/src/handlers/index.ts                  # throw on unwired dep
apps/github/src/main.ts                             # record error; reaper tick
apps/github/src/setup.ts + scripts/seed-app.ts     # manifest check_run/deployment_status events+perms
apps/scheduler/src/main.ts                          # reap stuck sync jobs
apps/api/src/routes.ts                              # GET sync-jobs; PATCH items/:id/status; GET metrics/activity
packages/events/src/registry.ts                     # + work.status_changed
integrations/foreman-agent/**                        # NEW provider-agnostic MCP agent runner
apps/web/src/board/Board.tsx + metrics/MetricsTab.tsx + pages/ProjectView.tsx  # wire status + heatmap
apps/api/src/{main,http}.ts, apps/github/src/main.ts, apps/mcp/src/http.ts, apps/ingest/src/http.ts  # fail-fast secret, dev-auth opt-in, error middleware
docs/agents.md, docs/hosted.md, README.md           # runner + provider setup, endpoints
```

---

### Task 1: GitHub sync reliability & observability
**Files:** `packages/db/migrations/0009_sync_reliability.sql` (create); `apps/github/src/jobs.ts`, `apps/github/src/handlers/index.ts`, `apps/github/src/main.ts`; `apps/scheduler/src/main.ts`; `apps/api/src/routes.ts`; tests in `apps/github/src` + `apps/api/src/routes.test.ts`.

**Interfaces:**
- 0009: `alter table sync_jobs add column last_error text; add column locked_at timestamptz;`
- `claimSyncJob` sets `locked_at = now()` on claim.
- `completeSyncJob(q, id, ok, error?: string)` — on failure stores `last_error = $error` and clears `locked_at`; on success clears both.
- `reapStuckSyncJobs(q, olderThanSec = 120): Promise<number>` — resets `status='running'` rows with `locked_at < now() - interval` back to `'queued'` (attempts kept, last_error noted "reaped: stuck"). Exported from jobs.ts; called on the scheduler tick (new env `FOREMAN_REAP_INTERVAL_SEC`, default 60, 0=off).
- dispatcher: the four `ctx.backbone === undefined` / `ctx.gh === undefined` cases **throw** `new Error("<name> handler not wired")` instead of `console.warn`+return (a misconfig now fails the job loudly instead of marking it done).
- main.ts worker wraps `handleSyncJob` in try/catch and passes the error message to `completeSyncJob`.
- api: `GET /api/projects/:id/sync-jobs?status=failed` → `{jobs:[{id, event_name, action, attempts, last_error, created_at}]}` scoped by the project's org (RLS visibility of the project; jobs read via servicePool filtered by organisation_id).

- [ ] Failing tests: completeSyncJob stores last_error on final failure; reaper resets a stale running job; dispatcher throws when backbone missing; api returns failed jobs for the org and 404s cross-org.
- [ ] Implement → full suite + typecheck green → commit `feat(github): sync-job error surface, stuck-job reaper, loud unwired-handler failures (audit #1 observability)`.

---

### Task 2: GitHub App manifest event coverage
**Files:** `apps/github/src/setup.ts`, `apps/github/scripts/seed-app.ts`; test in `apps/github/src/setup.test.ts`.

**Interfaces:** manifest `default_events` gains `"check_run"`, `"deployment_status"`; `default_permissions` gains `checks: "read"`, `deployments: "read"` (and keep existing). seed-app manifest matches. A test asserts `default_events` ⊇ every webhook event the dispatcher in `handlers/index.ts` handles (`issues, pull_request, pull_request_review, projects_v2_item, check_run, deployment_status`).

- [ ] Failing test (manifest coverage) → implement → green → commit `feat(github): subscribe manifest to check_run + deployment_status so those handlers deliver`.

---

### Task 3: Work-item status transitions (Board backend)
**Files:** `packages/events/src/registry.ts` (+`work.status_changed`); `apps/api/src/routes.ts` (+PATCH); `apps/web/src/board/Board.tsx` + `apps/web/src/pages/ProjectView.tsx` (wire drag→persist); tests `routes.test.ts` + keep web tests green.

**Interfaces:**
- registry: `"work.status_changed": { from: str, to: str }.strict()`.
- `PATCH /api/projects/:id/items/:itemId/status {status}` — zod status in the work_items enum (`draft|queued|claimed|in_progress|blocked|in_review|done|cancelled|failed`); reject queue-owned statuses set by hand only where it would corrupt the claim (allow the human-meaningful set: `queued|blocked|in_review|done|cancelled` — not `claimed|in_progress` which the queue owns). Visibility 404 → servicePool tx: update `work_items.status`, append `work.status_changed {from,to}` → 200 fresh row.
- web Board: `onMove(id, toColumnStatus)` calls the endpoint (optimistic local move already done; on failure reload); ProjectView passes the callback and maps the 6 board columns to a representative status (`backlog→queued, onhold→blocked, inprogress→in_progress?` — use the human-settable target per column; inprogress maps to `in_review` is wrong — map inprogress→`queued`? no). Ruling in-task: map columns to the nearest human-settable status (backlog→queued, onhold→blocked, done→done, reviewed→in_review, deployed→done). "In progress" is queue-owned; dropping INTO it is a no-op persist (local only) with a note. Keep it honest.

- [ ] Failing tests: PATCH moves queued→blocked and appends event; rejects an invalid status (400); cross-org 404; web Board drag persists via the callback (mock fetch).
- [ ] Implement → green → commit `feat(api,web): work-item status transitions - board drag-and-drop persists (work.status_changed)`.

---

### Task 4: Provider-agnostic agent runner (Ollama / OpenAI / Anthropic / Google)
**Files:** NEW `integrations/foreman-agent/` — `package.json`, `tsconfig.json`, `src/main.ts` (CLI), `src/loop.ts` (MCP client work loop), `src/providers.ts` (adapters), `src/providers.test.ts`, `README.md`. Register in pnpm workspace + root `vitest.config.ts` if it has tests.

**Interfaces:**
- `Provider` interface: `{ name: string; complete(system: string, user: string): Promise<string> }`.
- Adapters (all via `fetch`, no SDKs):
  - `ollama` — POST `${OLLAMA_URL ?? "http://localhost:11434"}/api/chat` `{model, messages, stream:false}`; no key.
  - `openai` — POST `${OPENAI_BASE ?? "https://api.openai.com/v1"}/chat/completions`, `Authorization: Bearer ${OPENAI_API_KEY}`.
  - `anthropic` — POST `https://api.anthropic.com/v1/messages`, `x-api-key: ${ANTHROPIC_API_KEY}`, `anthropic-version`.
  - `google` — POST `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_API_KEY}`.
  - `providerFromEnv()` picks by `FOREMAN_AGENT_PROVIDER` (`ollama|openai|anthropic|google`) + `FOREMAN_AGENT_MODEL`.
- `src/loop.ts` — connect an MCP `Client` over `StreamableHTTPClientTransport` to `FOREMAN_MCP_URL` with header `Authorization: Bearer ${FOREMAN_AGENT_TOKEN}`; loop: `foreman__agent_announce` → `foreman__work_claim {wait:true}` → build a prompt from the claimed item (title/intent/acceptance) → `provider.complete(...)` → `foreman__work_report {note: result}` → `foreman__work_complete {acceptance_results:[…]}` → repeat; `foreman__agent_heartbeat` between; graceful shutdown on SIGINT.
- CLI `src/main.ts`: reads env, prints which provider/model/endpoint, runs the loop; `--once` flag processes a single item and exits (for testing).

- [ ] Failing tests (`providers.test.ts`): each adapter builds the right request and parses the right response shape from a stubbed `fetch` (assert URL, headers, body, and extracted text); `providerFromEnv` selects correctly and throws a clear error when the key for the chosen provider is missing.
- [ ] Implement adapters + loop + CLI; `README.md` shows `FOREMAN_AGENT_PROVIDER=ollama FOREMAN_AGENT_MODEL=llama3.1 FOREMAN_MCP_URL=http://localhost:8811/mcp FOREMAN_AGENT_TOKEN=fmn_agt_… pnpm --filter foreman-agent start` and the OpenAI/Anthropic/Google variants.
- [ ] `pnpm -r typecheck` + `pnpm test` green → commit `feat(agent): provider-agnostic agent runner - ollama/openai/anthropic/google join the fleet over MCP`.

---

### Task 5: Metrics activity series (heatmap backend)
**Files:** `apps/api/src/routes.ts` (+endpoint), `apps/web/src/metrics/MetricsTab.tsx` + `apps/web/src/pages/ProjectView.tsx` (wire); tests `metrics.test.ts` (golden) + web test stays green.

**Interfaces:**
- `GET /api/projects/:id/metrics/activity?now=ISO` → `{ weeks: 12, cells: number[] }` — 84 cells (12 weeks × 7 days, oldest→newest) counting `github.pr_merged` events per day over the last 12 weeks (deterministic on `now`). Falls back to `work.completed` when the project isn't GitHub-connected (documented in the response `source` field).
- web Metrics: fetch it on mount, set each heatmap cell opacity from `cell/maxCell` (min 0.06 so empty reads faint); ProjectView passes the data (or MetricsTab fetches via the api helper directly, matching how it already receives metrics — pass it in from ProjectView for consistency).

- [ ] Failing golden test: fixture of pr_merged events across 3 days in the window → exact non-zero cells at the right indices, zeros elsewhere.
- [ ] Implement → green → commit `feat(api,web): weekly merge-activity series powers the metrics heatmap`.

---

### Task 6: Fail-fast security wins + docs close-out
**Files:** `apps/api/src/{main,http}.ts`, `apps/github/src/main.ts`, `apps/mcp/src/http.ts`, `apps/ingest/src/http.ts`; `docs/agents.md` (new), `docs/hosted.md`, `README.md`; the plan file (EXECUTED note).

**Interfaces:**
- **Session secret fail-fast** (audit C2): `apps/api` + `apps/github` throw at boot if `FOREMAN_SESSION_SECRET` is unset or `< 32` chars (drop the `?? "dev-only-secret"` literal). A dev default is allowed only when `NODE_ENV !== "production"` AND printed as a loud warning.
- **Dev-login opt-in** (audit C3): replace `devAuth: NODE_ENV !== "production"` with `devAuth: process.env.FOREMAN_DEV_AUTH === "1"` (default off); `/auth/dev-login` returns 404 when off. Update quickstart to set `FOREMAN_DEV_AUTH=1` for local dev.
- **Catch-all error middleware** on api/mcp/ingest/github Express apps: 4-arg handler → `500 {error:"internal"}`, logs server-side, never leaks a stack.
- **docs/agents.md**: how agents connect (MCP + token), the Claude Code plugin path, and the new provider-agnostic runner with Ollama/OpenAI/Anthropic/Google examples. Update hosted.md/README env tables (`FOREMAN_DEV_AUTH`, `FOREMAN_REAP_INTERVAL_SEC`, the agent-runner vars) and the deferrals list.

- [ ] Failing tests: api boots-throws without a secret in production mode; dev-login 404 when `FOREMAN_DEV_AUTH` unset; malformed body → JSON 500 not HTML.
- [ ] Implement → full `pnpm test` + `pnpm -r typecheck` green → commit `feat(security): fail-fast session secret, dev-login opt-in, JSON error middleware (audit C2/C3)`.
- [ ] Mark this plan EXECUTED (commit range + test count) → commit `docs(plan): mark phase 10 backend plan executed`.

## Self-Review
- Coverage: GitHub reliability ✅ T1, event coverage ✅ T2; Board backend ✅ T3; multi-provider agents ✅ T4 (the headline ask); heatmap data ✅ T5; security fail-fast ✅ T6. Deep tx-split, RBAC, SSRF, indexes, advisory locks, blocked-sweep, schema versioning: explicitly deferred above.
- No provider key enters Foreman services (T4 is a client); events stay the write path (T3/T5 read events, T3 appends one); tests+typecheck gate every task.
