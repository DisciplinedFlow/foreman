# Foreman Phase 4 — Tasks, Telemetry, Check Runs, Briefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop around live agents — MCP tasks surface (DB-backed `tasks/*`), passive telemetry via a Claude Code hooks plugin + `apps/ingest`, stall detection (AVW-3), check runs as the control surface (GHA-5) with retry/reassign/abort, reproducible briefs (BRF-7), the checkpoint decision-card loop in the UI, and the communication graph (AVW-2).

**Architecture:** The MCP server stays stateless — task state lives in a new `mcp_tasks` table and `tasks/get` is *poll-through*: polling a waiting claim task attempts the claim right then, so no background completer is needed. `apps/ingest` is write-only into the event log (§1.3), mapping seven verified Claude Code hook events to Foreman events with metadata-only capture by default (X-3). Check runs ride the existing sync-job pipeline in both directions (MCP enqueues `foreman.report_run`; the `check_run` webhook's `requested_action` dispatches queue mutations). Briefs are a pure function of the event log + window, stored on generation so regeneration is byte-identical.

**Tech Stack:** everything already in the workspace (TS strict ESM, Express, pg, zod, Vitest, `@modelcontextprotocol/sdk` 1.30.0, React). No new runtime dependencies.

**Spec:** `docs/SPEC-Foreman.md` §3 (MCP/AGT), §4.1-4.2 (hooks plugin + ingest), §5.4 (check runs), §6.3 (briefs); `docs/PRD-Foreman.md` §2.4 (AVW-2/3), §2.7 (BRF). Prior plans: phase1-foundation, phase2-github-sync, phase3-api-web.

## SPEC §11 `[?]` items 1/2/8/9 — RESOLVED 31-08-2026 (this plan's gate)

| # | Item | Resolution | Evidence |
|---|---|---|---|
| 1 | MCP tasks extension | Published schema in SDK 1.30.0, protocol **2025-11-25** (the spec's "2026-07-28" revision does not exist): methods `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` (NOT `tasks/update`), notification `notifications/tasks/status`; statuses `working \| input_required \| completed \| failed \| cancelled`; `CreateTaskResult = {task: {taskId, status, ttl, createdAt, lastUpdatedAt, pollInterval?, statusMessage?}}`. No `resultType` field, no `server/discover` | `node_modules/.../sdk/dist/esm/types.js:622-719` introspected |
| 2 | Claude Code MCP revision | SDK negotiates `2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05 / 2024-10-07` automatically (`SUPPORTED_PROTOCOL_VERSIONS`); `registerToolTask` with `taskSupport:'optional'` gives automatic server-side polling for non-task clients. No separate compat module needed; Phase 1's plain-tool path remains for old clients | `types.js:2-4`, `server/mcp.js:110-124` |
| 8 | Hook event list | 32 events documented. **All seven we use exist**: `SessionStart, PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop, Notification`. **`SessionEnd` is NOT documented** — `Stop` is the run-close signal. `http` hook type exists (`url`, `headers`, `allowedEnvVars`, `timeout` in seconds); **`async` is command-only** — http hooks use short timeouts instead. `${user_config.KEY}` substitution valid in hook configs; `userConfig` entries require `type`+`title`+`description`, support `sensitive` | code.claude.com/docs/en/hooks + /plugins-reference fetched 31-08-2026 |
| 9 | Agent SDK options | **Deferred** — the `@foreman/agent-sdk` adapter moves to Phase 5; nothing in this plan touches the Agent SDK | — |

## Global Constraints

Everything from Phases 1-3 holds (event-per-mutation in-tx, X-6 parameterised SQL + untrusted-text-as-data, X-2 idempotency, WL-7 RLS guard, api holds no GitHub creds, one-way rule, conventional commits, one commit per green TDD cycle). New for Phase 4:

- **Hooks are observe-only** (§4.1 hard rule): `/ingest/hook` always returns 200 with an empty JSON body — never a decision payload. A monitoring integration must be unable to block a customer's agent.
- **Metadata only by default** (X-3/AVW-6): `tool_input` from hooks is dropped unless the org has `capture_tool_input` enabled; the ingest tests assert the default drops it.
- **Task IDs are bearer tokens** (AGT-8): 32 bytes `crypto.randomBytes` base64url; `tasks/*` handlers verify the task belongs to the authenticated agent — a valid taskId from another agent is `not_found`, never `forbidden` (no existence oracle).
- **Check-run constraints** (§5.4, `[V]`): max 3 actions; label ≤20 chars, description ≤40, identifier ≤20; App statuses only `queued|in_progress|completed`; conclusions from the fixed set. Only the github service writes check runs.
- **Brief reproducibility** (BRF-7): `assembleBrief` is a pure function of (db state, window); generating is the only write; re-assembling an old window must produce identical JSON. No LLM call anywhere in this phase (deviation 4).

### Documented deviations from the SPEC (decided here, reviewers take note)

1. **`SessionEnd` hook dropped** (gate 8): not in the current event list; `Stop` closes the run. `Notification` is received and acked but mapped to no event (nothing in our taxonomy fits; log-only).
2. **`tasks/get` is poll-through for claim tasks**: instead of a scheduler completing waiting tasks, polling attempts the claim inline (same `claimNextWorkItem`, same WIP/dep gating). Self-serve, stateless, replay-safe; `pollInterval` tells the agent how often. `tasks/list` is omitted in v1 (nothing needs enumeration; the schema allows partial support — document in the tool description).
3. **`notifications/tasks/status` not pushed** — we are stateless-per-request; agents poll. The polling contract carries `pollInterval` so this is spec-conformant behaviour for a server that doesn't stream.
4. **Briefs are deterministic sections only** — LLM prose, email delivery, and schedules/timezones (BRF-1/BRF-4) are Phase 5; v1 stores the brief and serves it over the api. Forecast = critical-path horizon (max `earliest_finish`) now vs the previous brief's stored horizon.
5. **Check runs are per work item, not per run**: one check run per item (id cached in `work_items.gh_check_run_id`), updated in place on claim/report/complete. Created only when the item has `gh_repo` and the caller supplies a `head_sha` (from `work.report`/`work.complete` args); items with no sha simply have no check run.
6. **Auth helper duplicated into `apps/ingest`** (~20 lines of token-hash lookup copied from `apps/mcp/src/auth.ts`) rather than minting a shared package for two consumers.
7. **Marketplace listing not shipped**: the plugin directory is complete and installable from a path/repo; the marketplace.json wrapper is written when a marketplace repo exists (its schema lives in the plugin-marketplaces doc, not verified here).

## File structure

```
packages/db/migrations/0005_tasks_briefs_checks.sql
packages/events/src/registry.ts                 # + "work.reassigned" schema
apps/mcp/src/tasks.ts                           # mcp_tasks store + tasks/* handlers + poll-through
apps/mcp/src/server.ts                          # work_claim {wait}, work_checkpoint task, heartbeat resume, report_run enqueue
apps/ingest/                                    # foreman-ingest
  package.json / tsconfig.json (shape from apps/mcp)
  src/auth.ts        # bearer → {organisationId, projectId, agentId?} (deviation 6)
  src/mapper.ts      # hook payload → foreman events (pure-ish, takes tx)
  src/http.ts        # POST /ingest/hook
  src/main.ts
integrations/claude-code-plugin/foreman-plugin/
  .claude-plugin/plugin.json
  hooks/hooks.json
  .mcp.json
  skills/foreman/SKILL.md
integrations/claude-code-plugin/plugin.test.ts  # schema/shape validation (run from apps/ingest? no — own vitest project)
apps/scheduler/src/stall.ts                     # detectStalls(pool) — rules A + B
apps/scheduler/src/main.ts                      # + stall interval, brief interval
apps/github/src/handlers/report-run.ts          # foreman.report_run → backbone.reportRun
apps/github/src/handlers/check-run.ts           # inbound check_run.requested_action
apps/github/src/backbone.ts                     # reportRun implemented (GHA-5)
apps/gen/                                       # foreman-gen (briefs only, this phase)
  package.json / tsconfig.json
  src/brief.ts       # assembleBrief (pure) + generateBrief (writes)
  src/main.ts        # no-op service entry (cron lives in scheduler)
apps/api/src/routes.ts                          # + checkpoints, briefs, comm-graph endpoints
apps/api/src/stream.ts                          # + "checkpoints" scope
apps/web/src/checkpoints/DecisionCards.tsx
apps/web/src/graph/force.ts                     # pure force-layout ticks
apps/web/src/graph/CommGraph.tsx
apps/web/src/pages/ProjectView.tsx              # + Graph tab, decision cards on Agents tab
vitest.config.ts                                # + apps/ingest, apps/gen, integrations project
```

---

### Task 1: Migration 0005 — mcp_tasks, briefs, check-run linkage

**Files:**
- Create: `packages/db/migrations/0005_tasks_briefs_checks.sql`
- Modify: `packages/events/src/registry.ts` (add `"work.reassigned"`)
- Test: `packages/db/src/phase4-schema.test.ts`

**Interfaces:**
- Produces tables:

```sql
-- Task ids are bearer tokens (AGT-8): random 32B base64url, stored verbatim.
create table mcp_tasks (
  task_id         text primary key,
  organisation_id uuid not null references organisations(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  kind            text not null check (kind in ('claim','checkpoint')),
  status          text not null default 'working'
    check (status in ('working','input_required','completed','failed','cancelled')),
  checkpoint_id   uuid references checkpoints(id) on delete cascade,
  result          jsonb,
  poll_interval_ms int not null default 2000,
  ttl_ms          bigint,
  created_at      timestamptz not null default now(),
  last_updated_at timestamptz not null default now()
);
create index on mcp_tasks (agent_id, status);

create table briefs (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  content         jsonb not null,
  generated_at    timestamptz not null default now()
);
create index on briefs (project_id, window_end desc);

alter table work_items add column gh_check_run_id bigint;
alter table organisations add column capture_tool_input boolean not null default false;
```

  plus the 0002-pattern RLS policies on `mcp_tasks` and `briefs` (the existing guard test enforces this — 0005 must ship them or the build fails).
- Registry addition: `"work.reassigned": z.object({ by: z.string(), reason: z.string().optional() }).strict()`.

- [ ] **Step 1: Failing test** — mirror `github-schema.test.ts`: the two tables + `work_items.gh_check_run_id` + `organisations.capture_tool_input` exist; RLS guard suite still green (`pnpm --filter @foreman/db test`).
- [ ] **Step 2: FAIL → write migration → PASS** (all db tests, including guard + idempotency).
- [ ] **Step 3: Commit** — `git commit -m "feat(db): mcp task store, briefs, check-run linkage (0005)"`

---

### Task 2: MCP tasks surface — poll-through claim + checkpoint tasks

**Files:**
- Create: `apps/mcp/src/tasks.ts`
- Modify: `apps/mcp/src/server.ts`
- Test: `apps/mcp/src/tasks.test.ts`

**Interfaces:**
- Consumes: `claimNextWorkItem` (Phase 1 — returns assignment or throws typed WIP errors), checkpoints table, SDK low-level `server.server.setRequestHandler(GetTaskRequestSchema | GetTaskPayloadRequestSchema | CancelTaskRequestSchema, …)` (schemas from `@modelcontextprotocol/sdk/types.js`, gate-1 shapes).
- Produces (`tasks.ts`):
  - `createTask(q, {organisationId, agentId, kind, checkpointId?, status?}): Promise<TaskRow>` — `crypto.randomBytes(32).toString("base64url")` id.
  - `taskToWire(row): {taskId, status, ttl, createdAt, lastUpdatedAt, pollInterval}` — ISO strings, `ttl: row.ttl_ms ?? null`.
  - `pollTask(pool, ctx, taskId): Promise<TaskRow | null>` — loads the task **for this agent** (null = not_found); if `kind='claim'` and `status='working'`: attempt `claimNextWorkItem` in a tx; on assignment → update task `completed` with `result = {assignment}` + the same events Phase 1's claim path appends; WIP-limited or empty → leave `working`. If `kind='checkpoint'` and `status='input_required'`: read the checkpoint row; when `status='answered'` → task `completed`, `result = {answer, answered_at}`.
  - Handlers registered in `buildMcpServer`: `tasks/get` → poll-through + `taskToWire`; `tasks/result` → 404-style McpError unless `completed`, else the stored `result` as a CallToolResult (`ok(result)`); `tasks/cancel` → status `cancelled` (idempotent; cancelling a completed task errors per schema intent).
- `server.ts` changes:
  - `foreman__work_claim` input gains `wait: z.boolean().optional()` — on empty queue with `wait:true`, create a claim task and return `ok({status:"waiting", task: taskToWire(row)})`; without `wait`, today's `{status:"empty", retry_after_ms}` stands.
  - New `foreman__work_checkpoint` `{work_item_id, question, options?, context?}` → insert checkpoints row (`status='open'`) + `appendEvent "work.checkpoint_raised"` (exists in registry — verify name at impl, else use the registry's checkpoint event) + create checkpoint task (`status='input_required'`) → `ok({checkpoint_id, task})`. Ownership via `assertOwnsWorkItem`.
  - `foreman__agent_heartbeat`: when the agent's row is `stalled` → set `working` + `appendEvent "agent.resumed"` (AVW-3 recovery).

- [ ] **Step 1: Failing tests** (SDK client against `createApp`, Phase 1 loop-test pattern; drive `tasks/*` with `client.request({method, params}, GetTaskResultSchema)`):
  1. `work_claim {wait:true}` on an empty queue → `status:"waiting"` with a `task.taskId`; `tasks/get` → still `working`; enqueue an item; `tasks/get` → `completed`; `tasks/result` → the assignment with the item id; the work item is `claimed` by this agent.
  2. Another agent's token polling that taskId → not-found error (no oracle).
  3. `tasks/cancel` on a working claim task → `cancelled`; subsequent `tasks/get` shows `cancelled`; an enqueued item is NOT claimed by it.
  4. `work_checkpoint` → task `input_required`; answer the checkpoint row directly in SQL (`status='answered', answer='ship it'`); `tasks/get` → `completed`; `tasks/result` → `{answer:"ship it", …}`.
  5. Heartbeat from a `stalled` agent flips it to `working` and appends `agent.resumed`.
- [ ] **Step 2: FAIL → implement → PASS** (all mcp tests including the Phase 1 loop).
- [ ] **Step 3: Commit** — `git commit -m "feat(mcp): tasks surface - poll-through claim, checkpoint input_required, cancel (AGT/gate-1)"`

---

### Task 3: `apps/ingest` — hook receiver

**Files:**
- Create: `apps/ingest/package.json`, `tsconfig.json` (copy `apps/mcp` shape minus the MCP dep), `src/auth.ts`, `src/mapper.ts`, `src/http.ts`, `src/main.ts`; add to root `vitest.config.ts` projects.
- Test: `apps/ingest/src/ingest.test.ts`

**Interfaces:**
- Consumes: `agent_tokens` (Phase 1 auth pattern — sha256 hash lookup, deviation 6), `appendEvent`, verified hook payload fields (gate 8): `session_id, cwd, hook_event_name, tool_name?, tool_input?, tool_use_id?, agent_id?, agent_type?`.
- Produces: `createIngestApp(pool: pg.Pool): express.Express` — `POST /ingest/hook`, bearer auth (401 without), zod `passthrough` parse, then per `hook_event_name` (§4.1 table, in one tx):
  - `SessionStart` → find agent by token binding; upsert a `runs` row keyed `external_session_id = session_id` (open if none); if the token has no bound agent yet, create one (`integration_depth='telemetry'`, `display_name = basename(cwd)`, `platform='claude-code'`) and bind it (same token-binding update as announce); append `agent.announced`; set `agents.status='working'`, `last_seen_at=now()`.
  - `PreToolUse` → `tool.invoked {tool_name, tool_use_id}` + `input` ONLY when the org row has `capture_tool_input` (X-3); `PostToolUse` → `tool.returned {tool_name, tool_use_id}`. Both bump `last_seen_at`.
  - `SubagentStart` → create child agent (`parent_agent_id`, `display_name = agent_type ?? 'subagent'`, telemetry depth) + `comm.subagent_spawned {parent_agent_id, child_agent_id, agent_type}`; `SubagentStop` → `comm.subagent_returned` (child looked up by the hook's `agent_id` stored in a `gh`-style linkage column? No — keep a `agents.external_agent_id text` mapping? Simplest: store the hook `agent_id` in `agents.capabilities`? NO. Store it properly: `mapper.ts` keeps child identity via `external_session_id` on a child run — **decision: create the child with `display_name = agent_type` and record the hook's `agent_id` in a new runs row (`external_session_id = hook agent_id`)**; `SubagentStop` finds it there).
  - `Stop` → close the open run (`ended_at=now()`), `agent.went_offline {reason:'session_end'}`, `agents.status='offline'`.
  - `Notification` and unknown events → 200, no event (deviation 1).
  - **Always** `res.json({})` — observe-only (hard rule), including on mapper errors (log + 200; never block the agent).
- [ ] **Step 1: Failing tests** — seeded org + agent token: (a) no/bad bearer → 401; (b) SessionStart creates telemetry agent + open run + `agent.announced`; (c) PreToolUse default **drops** `tool_input` (payload in event has no `input` key), and with `capture_tool_input=true` keeps it; (d) SubagentStart→Stop creates the child and both comm events; (e) Stop closes the run and sets `offline`; (f) a mapper-crashing payload (missing fields) still gets `200 {}`.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(ingest): claude code hook receiver - sessions, tools, subagents, observe-only (AGT-4)"`

---

### Task 4: Claude Code plugin package

**Files:**
- Create: `integrations/claude-code-plugin/foreman-plugin/.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `skills/foreman/SKILL.md`; `integrations/claude-code-plugin/package.json` (private, `"test": "vitest run"`) + `plugin.test.ts`; register in root `vitest.config.ts`.
- Test: `integrations/claude-code-plugin/plugin.test.ts`

**Interfaces (all shapes are gate-8 verified):**
- `plugin.json`: `{name:"foreman", displayName:"Foreman", version:"0.1.0", description, hooks:"./hooks/hooks.json", mcpServers:"./.mcp.json", userConfig:{endpoint:{type:"string",title:"Foreman endpoint",description:"Base URL of your Foreman deployment",required:true}, token:{type:"string",title:"Agent token",description:"fmn_agt_ token from the Foreman UI",required:true,sensitive:true}}}`.
- `hooks.json`: exactly the seven verified events. `SessionStart`/`Stop`: `{type:"http", url:"${user_config.endpoint}/ingest/hook", headers:{Authorization:"Bearer ${user_config.token}"}, timeout:5}`; `PreToolUse`/`PostToolUse` with `matcher:"*"` and `timeout:3`; `SubagentStart`/`SubagentStop`/`Notification` timeout 3. **No `async` field anywhere** (http hooks don't support it — gate 8).
- `.mcp.json`: `{mcpServers:{foreman:{type:"http", url:"${user_config.endpoint}/mcp", headers:{Authorization:"Bearer ${user_config.token}"}}}}`.
- `SKILL.md`: frontmatter `name: foreman` + `description: Use when working as a Foreman fleet agent — announce, claim work, report progress, checkpoint on decisions, complete with acceptance results`; body walks the tool loop (`foreman__agent_announce` → `foreman__work_claim {wait:true}` → poll `tasks/get` → `foreman__work_report` every meaningful step → `foreman__work_checkpoint` when a human decision is needed → `foreman__work_complete` with `acceptance_results[]`), and states the hard rule that heartbeats/reports extend the lease.
- [ ] **Step 1: Failing test** — `plugin.test.ts` loads the JSON files and asserts: hooks.json keys ⊆ the verified 32-event list AND == our seven; every http hook has `url` starting `${user_config.endpoint}` + an Authorization header + no `async` key; plugin.json `userConfig` entries all carry `type`/`title`/`description` and token is `sensitive`; `.mcp.json` targets `/mcp`. SKILL.md contains `foreman__work_claim` and frontmatter `name:`.
- [ ] **Step 2: FAIL → write the four files → PASS → commit** — `git commit -m "feat(plugin): claude code plugin - verified http hooks, mcp wiring, fleet skill (4.1/4.2)"`

---

### Task 5: Stall detection (AVW-3)

**Files:**
- Create: `apps/scheduler/src/stall.ts`
- Modify: `apps/scheduler/src/main.ts` (interval `FOREMAN_STALL_INTERVAL_SEC`, default 60, 0 disables)
- Test: `apps/scheduler/src/stall.test.ts` (add scheduler to root vitest projects if absent)

**Interfaces:**
- Produces: `detectStalls(pool: pg.Pool): Promise<number>` — two rules, one pass, events + status in one tx per agent:
  - **Rule A (silence):** agents with `status='working'` whose latest event is older than their project's `stall_threshold_sec` (default 900 when no project):
    ```sql
    select a.id, a.organisation_id, a.project_id, coalesce(p.stall_threshold_sec, 900) as threshold,
           max(e.recorded_at) as last_seen
    from agents a
    left join projects p on p.id = a.project_id
    join events e on e.agent_id = a.id
    where a.status = 'working'
    group by a.id, a.organisation_id, a.project_id, p.stall_threshold_sec
    having max(e.recorded_at) < now() - make_interval(secs => coalesce(p.stall_threshold_sec, 900))
    ```
  - **Rule B (loop):** the last 5 `tool.invoked` events for a `working` agent share one `payload->>'tool_name'` AND identical `md5(payload::text)` → stalled regardless of threshold (PRD loop fixture: same call ×5).
  - Each hit: `update agents set status='stalled'` + `appendEvent "agent.stalled" {threshold_sec, last_transition_at}`; returns count. Already-`stalled` agents are never re-flagged.
- [ ] **Step 1: Failing tests** — (a) working agent with a 1-sec threshold project and an old event → stalled + event; (b) agent under threshold → untouched; (c) loop fixture: 5 identical `tool.invoked` inserts (fresh timestamps) → stalled despite recent activity; (d) 4 identical + 1 different → NOT stalled; (e) second `detectStalls` run appends nothing new.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(scheduler): stall detection - silence threshold + repeated-call loop rule (AVW-3)"`

---

### Task 6: Outbound check runs (GHA-5) — `reportRun` + `foreman.report_run` jobs

**Files:**
- Modify: `apps/github/src/backbone.ts` (implement `reportRun`, delete the capability throw), `apps/github/src/handlers/index.ts` (+ route), `apps/mcp/src/server.ts` (enqueue on claim/report/complete)
- Create: `apps/github/src/handlers/report-run.ts`
- Test: `apps/github/src/backbone.test.ts` (replace the throws test), `apps/github/src/handlers/report-run.test.ts`, extend `apps/mcp` tests

**Interfaces:**
- `reportRun(item: WorkItemRef, run: RunStatus)`: load item; require `gh_repo`; `head_sha` from `run.headSha` — absent AND no existing check run → no-op (deviation 5). If `work_items.gh_check_run_id` null → `POST /repos/{repo}/check-runs` else `PATCH /repos/{repo}/check-runs/{id}`. Body: `name: "Foreman · #{gh_issue_number} {title truncated to 40}"`, `status` mapped from `run.state` (`queued|in_progress|completed`), `conclusion` only when completed (`run.conclusion ?? "neutral"`), `details_url` from env-configurable base + `/work/{id}` (constructor opt `workUrlBase`), `output.title/summary` from `run.summary`, and exactly the three §5.4 actions (`retry/reassign/abort`, labels within limits) when status ≠ completed. Persist returned id into `gh_check_run_id` + `appendEvent "github.check_updated"`.
- MCP side: `work_report` gains optional `commit_sha`; `work_claim` assignment path, `work_report`, and `work_complete` each insert a `sync_jobs` row `event_name='foreman.report_run'`, payload `{work_item_id, state, summary, head_sha?, conclusion?}` **in the same tx as their event** (claim → `queued→in_progress` summary; complete → `completed` + `success`/`failure` from acceptance results). No sha available yet → job still enqueued; handler no-ops (keeps ordering simple).
- `handleReportRun(job, backbone)` mirrors `schedule-write.ts` (zod parse → `backbone.reportRun({workItemId}, {state, summary, headSha?, conclusion?})`).
- [ ] **Step 1: Failing tests** — backbone: (a) first report POSTs with ≤3 actions, labels within caps, persists `gh_check_run_id`; (b) second report PATCHes the same id; (c) completed carries `conclusion` and no actions; (d) no repo/sha → zero HTTP calls. report-run handler: routes payload to a stub backbone. mcp: `work_complete` leaves a `foreman.report_run` job with `state:'completed'`.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(github,mcp): check runs as control surface - create/update via report_run jobs (GHA-5)"`

---

### Task 7: Inbound `check_run.requested_action` — retry / reassign / abort

**Files:**
- Create: `apps/github/src/handlers/check-run.ts`; register `"check_run"` in `handlers/index.ts`
- Test: `apps/github/src/handlers/check-run.test.ts`

**Interfaces:**
- `handleCheckRunEvent(tx, job)`: only `action === "requested_action"` matters; resolve the work item by `payload.check_run.id = gh_check_run_id` within the org (unknown → done, log). Dispatch `payload.requested_action.identifier`:
  - `retry` → status `queued`, `claimed_by=null`, `lease_expires_at=null` + `appendEvent "work.reassigned" {by:'check_run:retry'}` (idempotency `ghd:{delivery_id}`);
  - `reassign` → same mutation, `{by:'check_run:reassign'}`;
  - `abort` → status `cancelled` + `"work.cancelled"` event (payload per existing registry schema);
  - guarded: an item already `done|cancelled` is left alone (event still appended).
- [ ] **Step 1: Failing tests** — table-driven fixture payloads through `handleSyncJob`: retry requeues a claimed item; abort cancels an in_progress one; abort on a done item leaves it done; duplicate delivery id doesn't double-append.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(github): check_run action buttons - retry/reassign/abort dispatch (GHA-5)"`

---

### Task 8: Briefs (BRF) — `apps/gen`

**Files:**
- Create: `apps/gen/package.json`, `tsconfig.json`, `src/brief.ts`, `src/main.ts` (log-and-exit stub naming the scheduler as cron owner); root vitest project entry
- Modify: `apps/scheduler/src/main.ts` (interval `FOREMAN_BRIEF_INTERVAL_SEC`, default 0 = off, calls `generateBrief` per GitHub-connected project), `apps/scheduler/package.json` (dep `foreman-gen: workspace:*` — or export via `foreman-gen/lib` exports map like `foreman-github/lib`)
- Test: `apps/gen/src/brief.test.ts`

**Interfaces:**
- `assembleBrief(q: Queryable, projectId: string, window: {start: string; end: string}): Promise<BriefContent>` — **pure read**; §6.3 sections exactly:
  ```ts
  interface BriefContent {
    window: { start: string; end: string };
    shipped:   Array<{ work_item_id: string; title: string; completed_at: string }>;      // work.completed events in window
    in_flight: Array<{ work_item_id: string; title: string; status: string; agent?: string }>; // status claimed|in_progress
    blocked:   Array<{ work_item_id: string; title: string; reason: string | null; since: string }>;
    decisions: Array<{ checkpoint_id: string; work_item_id: string; question: string; opened_at: string }>; // open checkpoints (BRF-5)
    cost:      { window_usd: string; previous_window_usd: string };                        // sum(runs.cost_usd) by started_at window
    forecast:  { horizon_days: number | null; previous_horizon_days: number | null };      // max(proj_schedule.earliest_finish); previous from last brief row
    risks:     { stalled_agents: number; expired_leases: number; dep_cycle: boolean };     // agents.status='stalled'; work.lease_expired in window; proj_project_health
  }
  ```
  Every list ordered by a stable key (id) so output is deterministic.
- `generateBrief(pool, projectId, windowEnd = new Date())`: window_start = previous brief's `window_end` for the project (or epoch); assemble → insert `briefs` row → `appendEvent "brief.generated" {brief_id, window_start, window_end}` in one tx; returns the row.
- api additions belong to Task 9's commit? No — keep api out; briefs are served in Task 9.
- [ ] **Step 1: Failing tests** — seeded fixture (2 completed-in-window events, 1 in-flight item, 1 blocked, 1 open checkpoint, runs with costs in/out of window, proj_schedule rows, a stalled agent): (a) golden assertion on the full assembled object; (b) **reproducibility (BRF-7): `JSON.stringify(assembleBrief(...)) === JSON.stringify(assembleBrief(...))` and, after `generateBrief`, re-assembling the stored window equals the stored `content` byte-for-byte**; (c) second `generateBrief` uses the first's `window_end` as its `window_start`.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(gen): deterministic brief assembly + generation with reproducible windows (BRF-2/5/7)"`

---

### Task 9: API — checkpoints, briefs, comm-graph endpoints + SSE scope

**Files:**
- Modify: `apps/api/src/routes.ts`, `apps/api/src/stream.ts`
- Test: `apps/api/src/routes.test.ts` (extend)

**Interfaces (all reads `withUser`; same 404-via-RLS pattern as Phase 3):**
- `GET /api/projects/:id/checkpoints` → open checkpoints `{id, work_item_id, work_item_title, question, options, context, created_at}` (join work_items).
- `POST /api/checkpoints/:id/answer {answer}` → visibility check under `withUser`; then servicePool tx: `update checkpoints set status='answered', answer=$, answered_by=$user, answered_at=now() where id=$ and status='open'` (0 rows → 409) + `appendEvent "human.decided" {actor_user_id, checkpoint_id, answer}` → 200. (The agent's checkpoint task completes via Task 2's poll-through.)
- `GET /api/projects/:id/briefs?limit=10` → briefs rows newest-first; `GET /api/briefs/:id` → one.
- `GET /api/projects/:id/comm-graph` → `{nodes: [{id, display_name, platform, status, parent_agent_id}], edges: [{from, to, kind: 'spawn'|'message', count}]}` — nodes = project agents; edges aggregated from `comm.subagent_spawned`/`comm.message_sent` events (`group by from,to,kind`).
- `stream.ts` `scopesFor`: types starting `human.` or containing `checkpoint` → add `"checkpoints"`; `comm.*` → add `"agents"`.
- [ ] **Step 1: Failing tests** — open checkpoint listed; answering flips it + appends `human.decided` with the session user id; answering twice → 409; another org's checkpoint → 404; briefs list returns the Task 8 fixture row; comm-graph aggregates two spawn events into one edge `{count: 2}`.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(api): checkpoint answers, briefs, comm-graph reads + checkpoint SSE scope (BRF-5)"`

---

### Task 10: Web — decision cards + communication graph

**Files:**
- Create: `apps/web/src/checkpoints/DecisionCards.tsx`, `apps/web/src/graph/force.ts`, `apps/web/src/graph/CommGraph.tsx`
- Modify: `apps/web/src/pages/ProjectView.tsx` (cards above AgentTable; third tab "Graph"; wire `checkpoints` SSE scope)
- Test: `apps/web/src/checkpoints/DecisionCards.test.tsx`, `apps/web/src/graph/force.test.ts`

**Interfaces:**
- `DecisionCards({checkpoints, onAnswer(id, answer)})` — one card per checkpoint: question, work item title, `options[]` as buttons (plus a free-text input + Send when no options); disabled state while posting. Untrusted text as text nodes only.
- `force.ts` (pure, no d3): `layoutGraph(nodes, edges, {width, height, iterations = 150}): Map<id, {x, y}>` — seeded deterministic positions (hash of id → initial angle), per-iteration: repulsion `k²/d` between all pairs, spring toward `k` along edges, centre gravity; positions clamped to bounds. Deterministic: same input → same output (test relies on it).
- `CommGraph({nodes, edges, width = 800, height = 500})` — SVG: edges as lines (width ∝ count, spawn solid / message dashed), nodes as circles coloured by status + name labels.
- `ProjectView`: fetch checkpoints with the other resources; `checkpoints` SSE scope → refetch; `onAnswer` → POST then refetch checkpoints+agents; Graph tab fetches comm-graph lazily.
- [ ] **Step 1: Failing tests** — DecisionCards: renders question + option buttons; clicking an option calls `onAnswer(id, label)`; free-text card submits typed answer. force: deterministic (two runs equal); two connected nodes end closer than two unconnected ones; all positions within bounds.
- [ ] **Step 2: FAIL → implement → PASS → commit** — `git commit -m "feat(web): checkpoint decision cards + force-directed comm graph (AVW-2, BRF-5)"`

---

### Task 11: Loop-closure e2e + full suite

**Files:**
- Create: `apps/ingest/src/e2e.test.ts`
- Modify: root `vitest.config.ts` (ensure apps/ingest, apps/gen, apps/scheduler, integrations/claude-code-plugin all listed)
- Test: everything.

- [ ] **Step 1: Failing e2e** (the activation-path story, §9 weeks 5/6/9 in one): seed org+project (1s stall threshold) + agent token; POST hook fixtures to a live ingest app: `SessionStart` → agent exists (telemetry, run open); 5 identical `PreToolUse` payloads → `detectStalls(pool)` → agent `stalled` + `agent.stalled` event; then MCP client on the same token: `agent_announce` (upgrades depth), heartbeat → `agent.resumed`; `work_claim {wait:true}` → task; enqueue item with `gh_repo` → `tasks/get` completed; `work_checkpoint` → api `POST /api/checkpoints/:id/answer` as the seeded user → agent's `tasks/get` returns the answer; `work_complete {commit_sha}` → `foreman.report_run` job present; `generateBrief` → brief's `shipped` has the item, `decisions` empty (answered), `risks.stalled_agents` 0.
- [ ] **Step 2: FAIL → fix whatever it exposes → PASS.**
- [ ] **Step 3: Full suite + typecheck** — `pnpm test && pnpm -r typecheck` all green.
- [ ] **Step 4: Commit** — `git commit -m "test(e2e): telemetry -> stall -> resume -> claim task -> checkpoint -> check run -> brief"`

---

## Self-review checklist (run after writing, before execution)

- Spec coverage: gate items 1/2/8 resolved in-table with evidence, 9 deferred explicitly; §3 tasks ✅ T2 (published-schema methods only), AGT-8 bearer tasks ✅ T1/T2; §4.1 mapping table ✅ T3 (SessionEnd deviation 1), hard rule ✅ T3 tests; §4.2 plugin ✅ T4 (marketplace deviation 7); AVW-3 both rules ✅ T5 (loop fixture = PRD acceptance); §5.4 constraints ✅ T6/T7; §6.3 sections + BRF-7 byte-identity ✅ T8; BRF-5 answer-unblocks ✅ T9+T2 poll-through; AVW-2 ✅ T10.
- Placeholder scan: the mapper's subagent-identity choice is decided inline (child identity via runs.external_session_id), not deferred; no TBDs.
- Type consistency: `taskToWire` shape matches gate-1 TaskSchema; `HandlerContext.backbone` reused from Phase 3; `RunStatus.headSha` already in `@foreman/backbone`; `foreman.report_run`/`check_run` route through the existing `handleSyncJob` switch; `BriefContent` consumed by T9's briefs endpoints verbatim.
