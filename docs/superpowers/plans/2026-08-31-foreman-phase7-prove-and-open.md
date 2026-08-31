# Foreman Phase 7 — Load Proof, Event-Driven Regen, Framework Coverage, Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove v1 at the SPEC §10 load bar (100 concurrent agents, 2,000 items, p95 event→SSE under 2s, claim atomicity, rate backpressure), close the cron-only deviations (overview + lifecycle regenerate on `work.completed`), complete the §6.2 framework table with Django/Rails/Spring extractors, and open the doors: a real README + design-partner quickstart and the §11-item-10 Vibe Kanban research memo.

**Architecture:** The load harness is a tsx script like the Phase 6 browser harness — real throwaway DB, real MCP server + api in-process, 100 SDK clients hammering the claim loop while an SSE stream timestamps invalidation arrival. Event-driven regen lives in the **scheduler** (the designated derived-work writer): a cursor loop in the projector-runner style over `work.completed` events, debounced per project, calling `regenerateOverview` and enqueuing `foreman.lifecycle_scan` — woken by LISTEN with a poll fallback. New extractors follow the Phase 6 pattern-parser style with per-framework fixtures. Docs are files; the memo is researched via web search with sources cited.

**Tech Stack:** existing workspace only; no new dependencies.

**Spec:** SPEC §10 (load + property rows), §6.1 (regenerate on completion), §6.2 framework table, §11 item 10; PRD §1.2 (Vibe Kanban sits in the competitive landscape). Prior plans: phases 1-6.

## Global Constraints

Everything from Phases 1-6 holds. New:

- **The load harness asserts, never just reports**: p95 event→SSE < 2000ms, zero double-claims, all items terminal, and the rate bucket admitting ≤80% at 2× pressure are hard failures.
- **One-way rule intact**: the push loop reads `events` and writes only via `regenerateOverview` (overview tables) and `sync_jobs` inserts — never projections, never GitHub directly.
- **Regen push is idempotent and cursor-based** (replay-safe like the projector): a crash mid-batch re-runs the same events; `regenerateOverview`'s evidence-hash gating makes that free.
- **Extractors stay structural** (X-6): no execution, paths capped, comment lines skipped — identical posture to the Phase 6 four.
- **The memo cites sources**: every factual claim about Vibe Kanban carries a URL; where the record is thin, the memo says so rather than inventing.

### Documented deviations (reviewers take note)

1. **p95 is measured report→SSE-frame** (the honest proxy for "ingest→UI"): the UI's remaining work after an SSE invalidate is one GET the api already serves in milliseconds. The browser is not in the loop at N=100.
2. **Debounce is 2s fixed** per project (env `FOREMAN_PUSH_DEBOUNCE_MS`): completing 10 items in a burst regenerates once. BRF/OVW freshness at that horizon is well inside every acceptance bound.
3. **Rails routes DSL is parsed for the common forms** (`get/post/put/patch/delete "path"`, `resources :name` expanding to the standard 7 minus `new`/`edit` which have no API meaning → index/create/show/update/destroy). Nested/namespace blocks are v2.
4. **Spring extraction reads annotation pairs** (`@RequestMapping` class prefix + `@Get/Post/Put/Patch/DeleteMapping` methods); path variables `{id}` kept as-is. Kotlin/functional routes are v2.
5. **The memo is a research artifact, not code**: committed under `docs/research/`; its conclusions feed the PRD conversation, not this codebase directly.

## File structure

```
apps/mcp/load/load.ts                  # §10 harness (tsx script, test:load)
apps/scheduler/src/push.ts             # runPushOnce + watchPush (cursor + LISTEN + debounce)
apps/scheduler/src/main.ts             # wire watchPush (FOREMAN_PUSH_DEBOUNCE_MS, 0 disables)
apps/github/src/lifecycle/extract.ts   # + extractDjango, extractRails, extractSpring
apps/github/src/lifecycle/scan.ts      # route .py urls / .rb routes / .java files to them
README.md                              # rewritten: what it is, architecture map, quickstart
docs/quickstart.md                     # design-partner path: infra → seed → plugin → first agent → UI
docs/research/2026-08-31-vibe-kanban.md# §11 item 10 memo
```

---

### Task 1: Event-driven regen push (scheduler)

**Files:** `apps/scheduler/src/push.ts`, modify `main.ts`; test `apps/scheduler/src/push.test.ts`

**Produces:**
- `runPushOnce(pool, deps: {llm: Llm}): Promise<{projects: string[]}>` — cursor `projection_cursors` row `overview_push`; select `work.completed` events with `id > cursor` (limit 200); distinct non-null project ids → for each: `regenerateOverview(pool, projectId, {llm, causedBy: <event work_item_id or 'push'>})` and, when the project has repos+installation, insert one `foreman.lifecycle_scan` sync job (delivery id `push:{project}:{cursor}` — naturally deduped per batch); advance cursor to the last fetched id (even when no project matched). Errors leave the cursor put.
- `watchPush(pool, deps)` — LISTEN `foreman_events` + 2s poll; per-project debounce map (`FOREMAN_PUSH_DEBOUNCE_MS`, default 2000): a notification schedules a `runPushOnce` at most every debounce window.
- `main.ts`: start `watchPush` when `FOREMAN_PUSH_DEBOUNCE_MS !== "0"` (default on).

- [ ] Failing tests: (a) complete-shaped event inserted → `runPushOnce` regenerates `shipped` (extractive llm) and enqueues exactly one lifecycle job for a repo-connected project; (b) second run with no new events touches nothing (cursor advanced); (c) non-completed events advance the cursor without regen; (d) a project without repos gets overview regen but no scan job; (e) two completions in one batch → one regen, one scan job.
- [ ] Implement → green → commit `feat(scheduler): event-driven overview+lifecycle push on work.completed (OVW-2, closes cron-only deviation)`.

---

### Task 2: §10 load harness

**Files:** `apps/mcp/load/load.ts`, `apps/mcp/package.json` (`"test:load": "tsx load/load.ts"`)

**The script** (assertions are exits, like the browser harness):
1. Throwaway DB; seed org/user/project (`wip_limit` 200 so WIP never gates the test) + api app on a port + MCP `createApp` on a port; enqueue **2,000** work items.
2. **Claim atomicity at N=100**: 100 SDK clients (each its own token → announce). All clients loop `work_claim` (plain, non-wait) + `work_complete` until `empty` twice in a row. Assert: every item ends `done`; `select claimed_by` history via events — `count(work.claimed events) === 2000` (no item claimed twice — the unique claim per item is the atomicity proof); wall-clock + claims/sec reported.
3. **p95 event→SSE < 2s**: login to the api, open the project SSE stream, buffer frame arrival times. During a second churn wave (re-enqueue 500 fresh items, agents work them), record `sentAt` before each `work_report` and match each SSE frame carrying `last_event_id ≥` that report's event id (simplest: sample — every 10th report records t0; the next frame after t0 is its arrival). Assert `p95(arrival - t0) < 2000ms` and report p50/p95/max.
4. **Rate backpressure at 2×**: a `GithubClient` over `InMemoryKv` with stub fetch advertising `x-ratelimit-limit: 100`; fire 200 parallel `rest()` calls; assert fetch was invoked ≤ 81 times (80% bucket) and every excess call threw `RateLimitedError` (never a hang, never an uncounted call).
5. Print a summary block; exit 0 only if all assertions held.

- [ ] Write the script → run `pnpm --filter foreman-mcp test:load` → fix what reality exposes (timeouts, pool sizes) → green run with the numbers printed → commit `test(load): §10 harness - 100 agents, 2000 items, p95 event->sse, backpressure`.

---

### Task 3: Django / Rails / Spring extractors

**Files:** `apps/github/src/lifecycle/extract.ts` (+3 extractors), `scan.ts` (routing: `urls.py` → django, `routes.rb` → rails, `.java` → spring; `.py` files run fastapi AND django), tests extend `extract.test.ts` + a scan routing case

**Produces:**
- `extractDjango(content)` — `path("users/", views.x)` / `re_path(...)` / legacy `url(...)` inside `urlpatterns`; method unknown from the URLconf → emit `GET` (documented convention) with `framework:'django'`; leading `/` added; trailing-slash kept; `<int:pk>` → `:pk`.
- `extractRails(content)` — inside `Rails.application.routes.draw do`: verb lines `get "path"` / `post 'path'` (symbol or string), and `resources :users` → the 5 API routes (`GET /users`, `POST /users`, `GET /users/:id`, `PATCH /users/:id`, `DELETE /users/:id`) per deviation 3.
- `extractSpring(content)` — class-level `@RequestMapping("/prefix")` captured once; `@GetMapping("/x")`, `@PostMapping`, `@PutMapping`, `@PatchMapping`, `@DeleteMapping` (with or without a path arg — empty → the prefix itself); `@RequestMapping(method = RequestMethod.GET, value = "/y")` also honoured; paths joined prefix+suffix.
- `scan.ts`: fetch-set additions — `**/urls.py` always fetched; `config/routes.rb`; `.java` files under `src/` (same 50-file cap shared).
- [ ] Failing fixture tests per framework (each: ≥3 routes found incl. a param path, a decoy in a comment NOT found; rails `resources` expansion exact; spring class-prefix joining exact) + one scan test with a rails fixture producing endpoints.
- [ ] Implement → green → commit `feat(github): django, rails, spring lifecycle extractors - §6.2 table complete (LFC-1)`.

---

### Task 4: README + quickstart

**Files:** rewrite `README.md`; create `docs/quickstart.md`

- README: what Foreman is (one paragraph from the PRD's one-paragraph version), the service map (the §1.3 flow diagram in ascii), repo layout table, dev loop (compose, test, typecheck, e2e, load), env-var reference table (every `FOREMAN_*` + `DATABASE_URL*` + `ANTHROPIC_API_KEY` with defaults), pointer to quickstart + plans/spec.
- quickstart.md: the design-partner path end to end — infra up → migrate/seed an org+project (document the exact SQL/scripts that exist today, honestly: no admin CLI yet) → mint an agent token → install the Claude Code plugin (`claude plugin install` from the repo path + the two userConfig values) → start api/web/mcp/ingest/scheduler → first agent session appears in the Agent View → connect GitHub via `/setup/github/start`. Every command copy-pasteable; every gap that still needs manual SQL called out as such.
- [ ] Write both (no TDD — docs), verify every command against the repo (scripts exist, ports match), commit `docs: real README and design-partner quickstart`.

---

### Task 5: Vibe Kanban memo (§11 item 10)

**Files:** `docs/research/2026-08-31-vibe-kanban.md`

- Web-research Vibe Kanban: what it was, what it did (agent/task orchestration for coding agents), when and why it sunset (or its current status if it has NOT sunset — report what the record actually shows), what its users said, and 3-5 concrete lessons mapped onto Foreman decisions (each lesson → the Foreman requirement or deviation it validates or challenges). Sources section with URLs and access date. If the sunset premise is wrong, the memo's job is to say so — the spec's `[?]` was a hypothesis, not a fact.
- [ ] Research (WebSearch/WebFetch) → write → commit `docs(research): vibe kanban memo (§11 item 10)`.

---

### Task 6: Full suite + phase close

- [ ] `pnpm test && pnpm -r typecheck` green; `test:load` numbers pasted into the plan-executed note; commit any stragglers.

## Self-review checklist

- §10 rows covered: load ✅ T2 (claims/sec, p95, backpressure), property (claim atomicity) ✅ T2, replay ✅ T1 cursor semantics; §6.1 "regenerate on completion" ✅ T1; §6.2 table ✅ T3 (deviations 3/4 scoped); §11 item 10 ✅ T5; onboarding ✅ T4.
- Placeholders: none — harness assertions, extractor grammars, and push semantics are exact.
- Type consistency: `runPushOnce` mirrors the projector runner's cursor contract; extractors return the Phase 6 `Found` shape; no new cross-package surfaces.
