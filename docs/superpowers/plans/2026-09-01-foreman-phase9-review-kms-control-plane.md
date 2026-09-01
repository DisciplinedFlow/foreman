# Foreman Phase 9 — PR-Review Ingestion, KMS Key Source, Extractor Precision, Control Plane Implementation Plan

> **EXECUTED 01-09-2026** — all 6 tasks landed on main (commits 4f5a9a6..2266bcc), 303 tests
> green across 72 files, `pnpm -r typecheck` clean on all 15 workspace projects. Supervised
> throughput now reads merged-and-reviewed for GitHub-connected projects; the GitHub App master
> key is a pluggable env/file/command source (KMS-ready, no SDK); Rails/Spring extractors handle
> nested `resources`, `only:`/`except:`, and argument-order-insensitive `@RequestMapping`; a
> separate `foreman_control`-rooted `apps/control` service now owns provisioning and neutral
> usage metering, with `foreman_app` provably unable to reach either (WL-8 architecture test in
> `packages/db/src/control-plane.test.ts`). Deviations (all recorded in the plan body and in
> `docs/hosted.md`): KMS integration is a key *source*, not a vendored cloud SDK; control-plane
> auth is a static bearer token, not a real operator IdP; WL-1..5/10 (theming, custom domains,
> PSL submission, admin-apex split, timed partner run-through) stay design-only in
> `docs/hosted.md`, no code claims them; extractors remain pattern-based, not tree-sitter. One
> pre-existing test (`apps/gen/src/e2e.test.ts`, the scheduled-brief case) carried a hardcoded
> wall-clock date that would have failed once the real clock passed it — fixed to derive its
> timestamp relative to `Date.now()` before this phase's work was verified green, per controller
> instruction; not part of the planned task list.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade supervised throughput to the PRD's real definition (merged **and reviewed**) by ingesting PR reviews; swap the envelope-encryption master key to a pluggable source (env / file / command → KMS-ready); sharpen the Rails/Spring extractors (nested `resources`, `only:`, order-insensitive `@RequestMapping`); and land the WL-8/WL-9 control-plane story — a separate provisioning service + role the application plane cannot reach, neutral usage metering, and the hosted deployment doc.

**Architecture:** PR reviews follow the exact Phase 2 webhook path (verify→dedupe→sync_jobs→dispatcher case→appendEvent, idempotency `ghd:<delivery_id>`). The metrics read stays pure SQL over the event log; the merged-and-reviewed method activates only when the project is GitHub-connected so the golden test stays exact. The master key becomes `resolveMasterKey()` (async, boot-time, env|file|command providers) — `sealPem`/`openPem` untouched. The control plane is a new `apps/control` express service using its own `foreman_control` Postgres role; migration 0008 revokes provisioning writes from `foreman_app` and an architecture test proves the separation (WL-8) plus a grep test that no app-plane service references the control credential.

**Tech Stack:** existing workspace only — no new runtime dependencies. (`FOREMAN_MASTER_KEY_CMD` makes AWS/GCP KMS a config choice, not an SDK.)

**Spec:** PRD §1.7 (north star = reviewed-and-merged), §2.9 WL-7/8/9, §2.10 X-4; SPEC §12 hosted notes; phase 8 plan deviation 4 (throughput method); memory "Phase 9 candidates".

## Global Constraints

Everything from Phases 1-8 holds. New:

- **The event log is the only write path for facts** — reviews land as events, the metric derives from them; no new projection tables for reviews.
- **Webhook idempotency**: every appended event from a delivery uses `idempotency_key: ghd:<delivery_id>` (re-delivery is a no-op).
- **The metric is deterministic**: same events + same `?now=` ⇒ byte-identical response; `method` names the algorithm used.
- **Provisioning is unreachable from the application plane** (WL-8): `foreman_app` loses INSERT/DELETE on `organisations` and `brands` in 0008; only `apps/control` connects as `foreman_control`; no app-plane source may reference `FOREMAN_CONTROL_TOKEN` or `foreman_control`.
- **Metering is neutral** (WL-9): `usage_records` carry `(org, period, metric, value)` — no prices, no currency, anywhere.
- **Tests**: every task lands with its own vitest cover; full `pnpm test` + `pnpm -r typecheck` green before each commit. Commit with explicit pathspecs (`.idea/` stays staged-but-uncommitted).

### Documented deviations (reviewers take note)

1. **KMS is a key *source*, not an SDK integration.** `FOREMAN_MASTER_KEY_CMD` (e.g. `aws kms decrypt --query Plaintext --output text ...`) covers AWS/GCP/Vault without vendoring a cloud SDK. Direct SDK providers are hosted-deploy work, documented in `docs/hosted.md`.
2. **Control-plane auth is a static bearer** (`FOREMAN_CONTROL_TOKEN`, timing-safe compare). Real operator IdP/audit trail is hosted work; the WL-8 boundary (role + revoke + arch test) is what this phase proves.
3. **WL-1..3 theming, WL-4 custom domains, WL-10 partner runbook** stay design-only: `docs/hosted.md` records the plan (Cloudflare for SaaS, PSL submission, admin-console apex split). No code claims them.
4. **`pull_request_review` `state` values**: GitHub sends lowercase `approved|changes_requested|commented` on the review object; `dismissed` arrives as action, not state — we ingest `submitted` actions only and record the state verbatim.
5. **Extractors remain pattern-based** (no tree-sitter — Phase 6 deviation stands). "Precision" = nested Rails `resources` blocks + `only:`/`except:`, and Spring `@RequestMapping` argument-order/`path=` tolerance incl. Kotlin files (`.kt` already routed by scan config — verify, don't assume).

## File Structure

```
packages/events/src/registry.ts                # + "github.pr_reviewed"
apps/github/src/handlers/reviews.ts            # pull_request_review → event (+ index.ts case)
apps/api/src/routes.ts                         # metrics: merged-and-reviewed method
apps/github/src/crypto.ts                      # + resolveMasterKey (env|file|cmd)
apps/github/src/main.ts                        # boot-time async key resolve
apps/github/src/lifecycle/extract.ts           # rails nesting/only, spring reqmap variants
packages/db/migrations/0008_control_plane.sql  # foreman_control role, revokes, usage_records
packages/db/src/usage.ts                       # meterUsage()
apps/control/src/{main,http,routes}.ts         # provisioning + metering service (:3005)
apps/control/src/routes.test.ts                # provision/patch/usage/auth tests
packages/db/src/control-plane.test.ts          # WL-8 architecture test (role denies)
docs/hosted.md                                 # the hosted story (KMS, domains, PSL, WL-10)
```

---

### Task 1: `github.pr_reviewed` event + webhook handler

**Files:**
- Modify: `packages/events/src/registry.ts` (after `github.pr_merged`, line ~41)
- Create: `apps/github/src/handlers/reviews.ts`, `apps/github/src/handlers/reviews.test.ts`
- Modify: `apps/github/src/handlers/index.ts` (dispatcher `case "pull_request_review"`)

**Interfaces:**
- Produces event `github.pr_reviewed` payload (strict): `{ gh_repo: str, pr_number: int, pr_url: str, review_id: int, reviewer: str, state: str }`
- Produces `handlePullRequestReviewEvent(tx: PoolClient, job: SyncJob): Promise<void>` (same signature family as `handlePullRequestEvent` in `issues.ts`)

- [ ] **Step 1: Failing tests** in `reviews.test.ts` (mirror `issues.test.ts` harness: throwaway DB, `job("pull_request_review", "submitted", {...})`):
  - `submitted` + `state: "approved"` + PR body `"Fixes #42"` matching a seeded work item ⇒ one `github.pr_reviewed` event with that `work_item_id`, payload carries `reviewer`, `review_id`, `state: "approved"`.
  - `state: "changes_requested"`, no body match ⇒ event with `work_item_id` null.
  - action `"dismissed"` ⇒ no event. Unroutable repo (no project) ⇒ no event. Same `delivery_id` twice ⇒ one event (idempotency).
- [ ] **Step 2: Run** `pnpm --filter foreman-github test -- reviews` — FAIL (module not found).
- [ ] **Step 3: Implement** — registry entry; `reviews.ts` zod-parses `{ action, repository: {full_name}, review: {id, state, user: {login}, html_url}, pull_request: {number, html_url, body} }` (passthrough-tolerant like `issues.ts`), returns unless `action === "submitted"`; `resolveProject` + `CLOSES_RE` work-item linkage copied from `issues.ts` (export `CLOSES_RE`/`resolveProject` from `issues.ts` rather than duplicating); `appendEvent` with `idempotency_key: ghd:${job.delivery_id}`. Dispatcher case added.
- [ ] **Step 4:** suite green, `pnpm -r typecheck` green.
- [ ] **Step 5: Commit** `feat(github): pull_request_review ingestion - github.pr_reviewed event (PRD north star input)`

---

### Task 2: Merged-and-reviewed supervised throughput

**Files:**
- Modify: `apps/api/src/routes.ts` (metrics endpoint, completions query ~line 518)
- Modify: `apps/api/src/metrics.test.ts` (golden fixture extended)

**Interfaces:**
- Response shape change: `supervised_throughput.method` becomes `"merged and reviewed"` for GitHub-connected projects (project row has `gh_installation_id is not null`), else stays `"completions with acceptance verdicts"`. New companion counts: `merged_this_week`, `reviewed_and_merged_this_week` (always present, 0 for local projects).

- [ ] **Step 1: Failing golden test** — extend the fixture: two work items completed this week with verdicts; item A also has `github.pr_merged` + `github.pr_reviewed{state:"approved"}` events (same `work_item_id`, occurred this week), item B only `github.pr_merged`; project variant with `gh_installation_id` set expects `this_week: 1, method: "merged and reviewed", merged_this_week: 2, reviewed_and_merged_this_week: 1`; the existing local-project expectations stay byte-identical apart from the two new zero counts.
- [ ] **Step 2:** run `pnpm --filter foreman-api test -- metrics` — FAIL on shape.
- [ ] **Step 3: Implement** — one added query:
  ```sql
  select
    count(distinct m.work_item_id) filter (where r.work_item_id is not null)::int as reviewed_and_merged,
    count(distinct m.work_item_id)::int as merged
  from events m
  left join events r on r.work_item_id = m.work_item_id
    and r.type = 'github.pr_reviewed' and r.payload->>'state' = 'approved'
    and r.occurred_at >= $2 and r.occurred_at < $3
  where m.project_id = $1 and m.type = 'github.pr_merged'
    and m.work_item_id is not null
    and m.occurred_at >= $2 and m.occurred_at < $3
  ```
  `this_week`/`last_week` switch to reviewed-and-merged counts (same query windowed twice) when connected; verdict counts remain the fallback and are always still computed.
- [ ] **Step 4:** api suite + full `pnpm test` green.
- [ ] **Step 5: Commit** `feat(api): supervised throughput upgraded to merged-and-reviewed (PRD 1.7 north star)`

---

### Task 3: Master-key source seam (KMS-ready)

**Files:**
- Modify: `apps/github/src/crypto.ts`, `apps/github/src/crypto.test.ts`
- Modify: `apps/github/src/main.ts` (boot resolve), `apps/github/src/lib.ts` (re-export)

**Interfaces:**
- Produces `resolveMasterKey(env?: NodeJS.ProcessEnv): Promise<string | undefined>` — precedence `FOREMAN_MASTER_KEY` (existing 64-hex validation) → `FOREMAN_MASTER_KEY_FILE` (read file, trim, same validation) → `FOREMAN_MASTER_KEY_CMD` (run via `node:child_process` `execFile("/bin/sh", ["-c", cmd])` — win32: `cmd /c`; stdout trimmed, same validation) → `undefined`. Invalid key from any source throws loudly (never silently unencrypted). `keyFromEnv()` stays exported and untouched (setup/seed callers keep working).

- [ ] **Step 1: Failing tests** in `crypto.test.ts`: env wins over file; file provider reads+trims+validates (bad hex in file throws naming the source); cmd provider runs a `node -e "console.log('<64hex>')"` command; all unset ⇒ undefined; seal-with-resolved/open round-trip.
- [ ] **Step 2:** FAIL (no export).
- [ ] **Step 3: Implement**; `main.ts` awaits `resolveMasterKey()` once at boot and threads the value where `keyFromEnv()` results were used (lines ~33, ~50 — the privateKeyPem opener and the setup `masterKey` option).
- [ ] **Step 4:** github suite green; typecheck green.
- [ ] **Step 5: Commit** `feat(github): pluggable master-key source env|file|command - KMS as config, not SDK`

---

### Task 4: Extractor precision — nested Rails, Spring argument tolerance

**Files:**
- Modify: `apps/github/src/lifecycle/extract.ts` (`extractRails`, `extractSpring`), `extract.test.ts`

**Interfaces:** `extractRails`/`extractSpring` signatures unchanged (`(content: string) => Found[]`).

- [ ] **Step 1: Failing tests:**
  - Rails block nesting: `resources :posts do\n  resources :comments\nend` ⇒ the 5 post routes **plus** `/posts/:post_id/comments` GET+POST, `/posts/:post_id/comments/:id` GET+PATCH+DELETE (one nesting level; deeper nesting uses the immediate parent only, Rails' own shallow convention).
  - `resources :sessions, only: [:create, :destroy]` ⇒ exactly `POST /sessions`, `DELETE /sessions/:id`; `except: [:destroy]` ⇒ the other four.
  - Spring: `@RequestMapping(value = "/orders", method = RequestMethod.POST)` (value-first) and `@RequestMapping(path = "/orders", method = RequestMethod.GET)` (`path=` alias) both extract; Kotlin-style `@GetMapping("/items/{id}")` in a class with `@RequestMapping("/api")` joins to `/api/items/{id}` (already passing — keep as regression guard).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** — Rails: track a stack of `resources` block parents (`do`…`end` depth counting; only `resources ... do` pushes), member paths under a parent use `/:parent_singular_id`; parse `only:`/`except:` symbol arrays into the action set (`index,create,show,update,destroy` → the 5 routes). Spring: replace `SPRING_REQMAP_RE` with an argument-scanning parse of the `@RequestMapping(...)` arg list (split on commas, accept `value=|path=|bare-string` and `method = RequestMethod.X` in any order).
- [ ] **Step 4:** lifecycle tests + full github suite green (scan.test.ts must not regress).
- [ ] **Step 5: Commit** `feat(github): extractor precision - nested rails resources + only/except, order-insensitive spring mappings`

---

### Task 5: Migration 0008 + control-plane service (WL-8, WL-9)

**Files:**
- Create: `packages/db/migrations/0008_control_plane.sql`
- Create: `packages/db/src/usage.ts` (+ export from `index.ts`), `packages/db/src/control-plane.test.ts`
- Create: `apps/control/package.json`, `apps/control/tsconfig.json`, `apps/control/src/main.ts`, `apps/control/src/http.ts`, `apps/control/src/routes.ts`, `apps/control/src/routes.test.ts` (mirror `apps/ingest`'s minimal express layout; port **:3006**, env `FOREMAN_CONTROL_PORT`)

**Interfaces:**
- 0008: `do $$ begin create role foreman_control login password 'foreman_control' bypassrls; ...` (same guard idiom as 0002); grant all on `organisations`, `brands`, `organisation_members`, `users`, `usage_records` to `foreman_control`; **revoke insert, delete on `organisations`, `brands` from `foreman_app`**; table `usage_records (id uuid pk default gen_random_uuid(), organisation_id uuid not null references organisations(id) on delete cascade, period_start date not null, period_end date not null, metric text not null, value numeric not null, created_at timestamptz not null default now(), unique (organisation_id, period_start, metric))` — RLS enabled, org-scoped select policy for `foreman_app` (tenants may see their own usage; X-4).
- `meterUsage(pool: Pool, period: {start: Date; end: Date}): Promise<number>` in `usage.ts` — per organisation upserts metrics `events_ingested` (count events in period), `active_agents` (distinct agent_id), `items_completed` (work.completed), `seats` (organisation_members count); returns rows written. **No prices anywhere.**
- `apps/control` routes (all under bearer `FOREMAN_CONTROL_TOKEN`, timing-safe compare, 401 otherwise; connects with `FOREMAN_CONTROL_DATABASE_URL` as `foreman_control`):
  - `POST /tenants {slug, tier, isolation?, owner_email}` → creates org + user (find-or-create by email) + owner membership in one tx → `201 {organisation_id, user_id}`; duplicate slug → 409.
  - `PATCH /tenants/:id {tier?, isolation?}` → 200 fresh row; unknown id 404.
  - `POST /metering/run {period_start, period_end}` → runs `meterUsage` → `{records}`.
  - `GET /tenants/:id/usage?from=&to=` → usage_records rows.

- [ ] **Step 1: Failing tests:**
  - `control-plane.test.ts` (WL-8 architecture test): connect as `foreman_app` ⇒ `insert into organisations` and `delete from organisations` raise `permission denied`; connect as `foreman_control` ⇒ both succeed. Grep test: read every file under `apps/{api,github,ingest,mcp,scheduler,projector,gen,web}/src` and assert none contains `FOREMAN_CONTROL_TOKEN` or `foreman_control`.
  - `routes.test.ts`: no/wrong token 401; provision → org+member rows exist (queried via service pool) and repeat slug 409; PATCH tier; metering run then usage GET returns the four metrics with exact counts from a seeded fixture (2 events, 1 agent, 1 completion, 1 member).
- [ ] **Step 2:** FAIL (migration missing ⇒ role missing).
- [ ] **Step 3: Implement** migration + usage.ts + service. Register app in root `vitest.config.ts` projects list and pnpm workspace. `@foreman/db/testing` throwaway DBs run migrations 0001-0008, so the role exists in tests automatically (roles are cluster-global — the 0008 role-create must use the same exception-guard idiom as 0002 or parallel test DBs will race).
- [ ] **Step 4:** full `pnpm test` + `pnpm -r typecheck` green (RLS guard test from 0002 must still pass — new table has a policy).
- [ ] **Step 5: Commit** `feat(control): provisioning service + foreman_control role + neutral usage metering (WL-8, WL-9)`

---

### Task 6: Hosted story doc + README/quickstart + plan close-out

**Files:**
- Create: `docs/hosted.md`
- Modify: `README.md` (service map + port table + env table: control :3006, `FOREMAN_MASTER_KEY_FILE/CMD`, `FOREMAN_CONTROL_TOKEN`), `docs/quickstart.md` (note: provisioning beyond the seeded dev org happens via the control plane)

**Interfaces:** none (docs).

- [ ] **Step 1: Write `docs/hosted.md`** — sections: (1) planes & credentials — which role each service holds, why `foreman_app` cannot provision (WL-8), the arch test to point auditors at; (2) key management — the three master-key sources with copy-paste `FOREMAN_MASTER_KEY_CMD` examples for AWS KMS and Vault, rotation note (`enc:v1:` prefix leaves room for v2 dual-read); (3) domains & cookies — Cloudflare for SaaS for WL-4, PSL submission + separate admin apex for the WL-5 remainder, `__Host-` already shipped; (4) metering & billing — usage_records are neutral (WL-9), pricing is the partner's; (5) WL-10 partner-day checklist (manifest flow → control-plane provision → theme = future work, honestly flagged).
- [ ] **Step 2:** README/quickstart edits; every claimed port/env verified against source, not memory.
- [ ] **Step 3:** `pnpm test` green (unchanged), commit `docs(hosted): control-plane/KMS/domains posture + service map for phase 9`
- [ ] **Step 4:** Mark this plan EXECUTED (header note with commit range + test count), commit `docs(plan): mark phase 9 plan executed`.

## Self-Review

- Coverage: PR-review ingestion ✅ T1; north-star metric ✅ T2; KMS source ✅ T3 (deviation 1); precision extractors ✅ T4 (deviation 5); WL-8 ✅ T5 role+revoke+arch test; WL-9 ✅ T5 usage_records/meterUsage; WL-7 unchanged (0002 guard still enforced, new table gets a policy); hosted/WL-4/5/10 story ✅ T6 as docs (deviation 3). PSL submission, theming code, cost rollups, multi-project dashboard, plugin marketplace: explicitly out, recorded in hosted.md/memory.
- Types: `handlePullRequestReviewEvent` mirrors `handlePullRequestEvent`; `resolveMasterKey` returns `string | undefined` exactly like `keyFromEnv`; `meterUsage` takes the shared `Pool`.
- No placeholders: every task carries its test list, payload shapes, SQL, and commit message.
