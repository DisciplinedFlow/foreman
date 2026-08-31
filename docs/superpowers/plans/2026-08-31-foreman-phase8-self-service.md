# Foreman Phase 8 — Self-Service Settings, Items & Tokens, Metrics, Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every manual-SQL gap the quickstart admits to — project settings (repos/board/thresholds/brief config), work-item creation, and agent-token mint/revoke from the UI — plus a deterministic PRD §1.7 metrics read and the event-log export endpoint + posture doc the Vibe Kanban memo argues for.

**Architecture:** All writes follow the established api pattern (visibility under `withUser`/RLS → servicePool tx → event append). Item creation forks: GitHub-connected projects enqueue a `foreman.create_item` sync job the github worker executes through `Backbone.createWorkItem` (single GitHub writer, like schedule_write); local projects call `enqueueWorkItem` directly. Token endpoints reuse the mcp auth mint/hash logic via a small shared move into `@foreman/db` (third consumer ends the copy-twice rule). Metrics are pure SQL over the event log with a golden fixture test. Export streams NDJSON in id-ordered batches under RLS.

**Tech Stack:** existing workspace only.

**Spec:** quickstart's flagged gaps; PRD §1.7 (metric definitions), §2.2 (enqueue), §3.5 (tokens); memo lesson 4 (export). Prior plans: phases 1-7.

## Global Constraints

Everything from Phases 1-7 holds. New:

- **Tokens are shown once**: the mint response carries the raw `fmn_agt_` token; every later read shows only metadata. Revocation is a timestamp, never a delete (audit).
- **Settings validation is real**: `brief_timezone` must satisfy `Intl.DateTimeFormat` (reject typos before a 07:00 brief silently never fires); `gh_installation_id` must belong to the caller's org; repos are `owner/name` shaped.
- **Metrics are deterministic** and windowed on the *caller-supplied* `now` (query param, default server now) so the golden test is exact.
- **Export is the org's data, whole**: every event column, id-ordered, no filtering beyond project scope; the doc states the replay guarantee (projections rebuild from offset 0).

### Documented deviations (reviewers take note)

1. **`project.updated` event added to the registry** (`{fields: string[]}` — which settings changed, not values; values live in the row and the audit is the event).
2. **Token mint moves to `@foreman/db`** (`createAgentToken`/`authenticateAgentToken`); `apps/mcp` and `apps/ingest` re-export/delegate — their public `lib` surfaces stay identical.
3. **Time-to-detect-stall is measured from the event log**: `agent.stalled.recorded_at − payload.last_transition_at`, median + p95 over the window. This measures the sweeper's detection latency (PRD's "median < 5 min" target); UI render adds ~SSE-frame time (proven 12ms at load).
4. **"Supervised throughput" v1 = completions with acceptance verdicts per week** (the merged-and-reviewed refinement needs PR-review data we don't ingest yet — stated in the response payload as `method`).
5. **The GitHub create path is fire-and-forget from the UI's view** (202 + SSE confirms), same contract as schedule write-back.

## File structure

```
packages/events/src/registry.ts            # + "project.updated"
packages/db/src/tokens.ts                  # moved mint/auth (deviation 2)
apps/api/src/routes.ts                     # settings PATCH, installations GET, items POST,
                                           # tokens GET/POST/DELETE, metrics GET, export GET
apps/github/src/handlers/create-item.ts    # foreman.create_item → backbone.createWorkItem
apps/web/src/settings/SettingsTab.tsx      # settings form + tokens section
apps/web/src/metrics/MetricsTab.tsx        # stat tiles
apps/web/src/pages/ProjectView.tsx         # + Settings/Metrics tabs, New item button
docs/export.md                             # posture doc
```

---

### Task 1: `project.updated` event + token move to `@foreman/db`

**Files:** registry (+event), `packages/db/src/tokens.ts` (+index export), `apps/mcp/src/auth.ts` + `apps/ingest/src/auth.ts` become delegating re-exports; tests: db `tokens.test.ts` (mint→authenticate→revoke→reject), existing mcp/ingest suites must stay green untouched.

- `createAgentToken(pool, {organisationId, projectId})` and `authenticateAgentToken(pool, authorizationHeader)` — byte-identical behaviour to the Phase 1 originals (fmn_agt_ prefix, sha256 at rest, last_used_at touch, revoked check). `revokeAgentToken(pool, tokenId)` added (sets `revoked_at`, idempotent).
- [ ] Failing db test → move code → mcp/ingest delegate → ALL suites green (proves the move changed nothing) → commit `refactor(db): shared agent-token mint/auth + revoke; project.updated event`.

---

### Task 2: Settings + installations api

**Files:** `apps/api/src/routes.ts`; tests extend `routes.test.ts`

- `GET /api/orgs/:orgId/installations` → `{installations: [{installation_id, app_id, account_login, created_at}]}` (RLS).
- `PATCH /api/projects/:id/settings` — zod strict, all optional: `name`, `gh_repos: string[]` (each `/^[\w.-]+\/[\w.-]+$/`), `gh_installation_id: number|null` (must exist in the org → else 400), `gh_project_node_id: string|null`, `wip_limit: int ≥1`, `stall_threshold_sec: int ≥60`, `brief_schedule: 'daily'|'weekly'|null`, `brief_timezone` (validated by constructing `Intl.DateTimeFormat`), `brief_webhook_url: url|null`, `brief_email: email|null`. Visibility 404 → update only provided fields → `project.updated {fields}` event → 200 with the fresh row.
- [ ] Failing tests: full happy PATCH round-trips every field and appends the event with the exact field list; bad timezone → 400; foreign installation id → 400; cross-org → 404; installations list scoped.
- [ ] Implement → green → commit `feat(api): project settings PATCH + installations picker - manual-SQL gap closed`.

---

### Task 3: Items + tokens api, github create handler

**Files:** `apps/api/src/routes.ts`, `apps/github/src/handlers/create-item.ts` (+dispatcher case); tests both sides

- `POST /api/projects/:id/items` `{title, intent?, kind?, priority?, acceptance?: string[]}` → GitHub-connected (repos + installation): sync job `foreman.create_item` (payload = fields + project_id) → `202 {queued: true}`; else `enqueueWorkItem` (existing db fn — appends `work.created`/`work.enqueued`) → `201 {work_item_id}`.
- `handleCreateItem(job, backbone)` — zod → `backbone.createWorkItem({projectId}, {title, intent?, kind?, priority?, acceptance?})` (Phase 2 impl already inserts + events + echo-records).
- `GET /api/projects/:id/tokens` (metadata only, newest first, joined agent display_name), `POST /api/projects/:id/tokens` → `201 {token_id, token}` (once), `DELETE /api/tokens/:id` → revoke (RLS visibility, 404 cross-org, idempotent 200).
- [ ] Failing tests: local create 201 + row + `work.created` event; connected project → 202 + job row; github handler routes to a stub backbone with exact args; token mint returns a working token (authenticate it), list hides the secret, revoke makes authenticate fail, cross-org 404s.
- [ ] Implement → green → commit `feat(api,github): work-item creation + agent-token management from the api (§2.2, §3.5)`.

---

### Task 4: Metrics api (PRD §1.7)

**Files:** `apps/api/src/routes.ts`; tests extend `routes.test.ts` (golden fixture with pinned timestamps + `?now=`)

- `GET /api/projects/:id/metrics?now=ISO` → all windows relative to `now`:
  ```
  {
    supervised_throughput: { this_week: n, last_week: n, method: "completions with acceptance verdicts" },
    stall_detection: { median_ms, p95_ms, samples } | null,      // deviation 3
    active_agents_24h: n,                                         // distinct agent_id with events
    open_decisions: n,                                            // open checkpoints
    briefs_7d: { generated: n, delivered: n },
    cost_7d: { usd: "x.xx", previous_usd: "x.xx" },
    lease_expiries_7d: n
  }
  ```
  Completions counted from `work.completed` events whose payload `acceptance_results` is non-empty (throughput) with an `all_completions` companion count.
- [ ] Failing golden test: fixture (2 verdicts + 1 bare completion this week, 1 last week; one agent.stalled with last_transition_at 90s before recorded_at; runs in/out of window; a generated+delivered brief; an open checkpoint) → exact response object.
- [ ] Implement → green → commit `feat(api): deterministic §1.7 metrics read - throughput, stall latency, engagement`.

---

### Task 5: Export endpoint + posture doc

**Files:** `apps/api/src/routes.ts`, `docs/export.md`; tests extend `routes.test.ts`

- `GET /api/projects/:id/export` — visibility 404; headers `content-type: application/x-ndjson`, `content-disposition: attachment; filename=foreman-events-{id}.ndjson`; stream events (`where project_id = $1 order by id`) in 500-row batches under `withUser`, one JSON object per line, all columns.
- `docs/export.md`: the posture — append-only log as the source of truth, this endpoint + plain `pg_dump` as equivalent exits, projections replayable from offset 0 (point at the projector's cursor reset), what leaves with you (events, work items, briefs, overview revisions) — the "your events, your Postgres" answer to the category's shutdown-scarred memory.
- [ ] Failing tests: export line count == seeded event count for the project, first+last lines parse with `id`/`type`, another org's project → 404, header assertions.
- [ ] Implement + doc → green → commit `feat(api): ndjson event export + docs(export): data posture (memo lesson 4)`.

---

### Task 6: Web — Settings tab (with tokens), New-item form, Metrics tab

**Files:** `apps/web/src/settings/SettingsTab.tsx`, `apps/web/src/metrics/MetricsTab.tsx`, ProjectView (+2 tabs, New item button on the Gantt tab); tests for each component

- Settings: form bound to the project row (repos as comma-separated input → array, installation `<select>` from the picker endpoint, thresholds, brief block), Save → PATCH → refetch; Tokens section: list (created/last-used/revoked, agent name), Mint button showing the one-time token in a copyable `<code>` with a "shown once" warning, Revoke per row; Export link (`<a href=…/export>`).
- New item: button opens inline form (title, intent, kind select, priority) → POST → refetch items; 202 vs 201 both just refetch.
- Metrics: stat tiles (throughput w/w with delta arrow, stall median formatted `Xs`/`Xm`, active agents, open decisions, briefs delivered/generated, cost w/w) + the `method` caveat line.
- [ ] Failing RTL tests: settings save PATCHes the parsed shape; mint reveals a token once and revoke calls DELETE; new-item form POSTs; metrics tiles render fixture numbers incl. the w/w delta.
- [ ] Implement → green → commit `feat(web): settings+tokens, new-item form, metrics tab - self-service complete`.

---

### Task 7: Phase e2e + full suite

- [ ] Extend `apps/api/src/phase6.e2e.test.ts`-style with a new `phase8.e2e.test.ts`: settings PATCH links a repo+installation → item POST routes to a `foreman.create_item` job → drain with stub backbone creating the row → metrics reflect a completion → token minted via api authenticates against the real MCP server (import `foreman-mcp/lib`) and announces → export contains every event of the story, line-parseable.
- [ ] `pnpm test && pnpm -r typecheck` green → commit `test(e2e): settings -> create -> work -> metrics -> export self-service loop`.

## Self-review checklist

- Gap coverage: quickstart's three manual-SQL callouts (link repos ✅ T2, enqueue item ✅ T3, brief config ✅ T2) all closed; token onboarding without db:seed ✅ T3/T6; §1.7 ✅ T4 (deviation 4 honesty); memo lesson 4 ✅ T5.
- Placeholders: none — payload shapes, validation rules, and golden metrics are exact.
- Type consistency: `createAgentToken` signature preserved through the move (T1) so mcp/ingest libs are unchanged; `foreman.create_item` mirrors schedule_write's handler contract; settings PATCH field names match the projects columns verbatim.
