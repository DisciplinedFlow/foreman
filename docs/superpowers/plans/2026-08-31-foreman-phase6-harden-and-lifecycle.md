# Foreman Phase 6 — Hardening, Finishers, Browser Harness, Lifecycle View Implementation Plan

> **EXECUTED 31-08-2026** — all 11 tasks landed on main (commits 2db4994..b882358), 243 tests green.
> Browser smoke result: **60fps mean (16.7ms frames) at 2,000 Gantt rows, 32 bars in the DOM** —
> the GNT-9 target met outright, not just the deviation-5 floor. Deviations from plan text: the
> web client's csrf header (a plan gap, fixed as its own commit); the harness is Node playwright
> in one tsx script (webapp-testing skill's Python pattern applied, not its runtime — the seed
> needs @foreman/db); two harness fixes on first run (SSE breaks networkidle → waitForSelector;
> tsx's __name helper breaks page.evaluate → source-string form); root test script now carries
> --testTimeout=20000 --hookTimeout=40000 (structural fix for throwaway-DB contention flakes).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out v1 (SPEC §9 week 10) and ship the lifecycle view — WL-5 session/CSRF hardening, a real token-bucket rate budget (GHA-7), envelope encryption for GitHub App keys, SMTP brief delivery + overview version diffs, the first-ever browser smoke plus the GNT-9 scroll harness, and LFC-1..5: API-endpoint discovery with an evidence-backed lifecycle state machine.

**Architecture:** Hardening lands where each concern lives: cookies/CSRF in `apps/api` (double-submit token + Origin validation; `__Host-`+`Secure` prefix keyed off `NODE_ENV`), the token bucket inside `@foreman/github-client`'s existing pre-flight (a fixed-window counter on a new atomic `Kv.incr`), envelope encryption as an AES-256-GCM seam wrapping `github_apps.private_key_pem` (`enc:v1:` prefix; plaintext rows keep working — KMS later swaps the master-key source). Lifecycle discovery runs in `apps/github` (it owns the GitHub client): a `foreman.lifecycle_scan` sync job walks the repo tree via the API, pulls spec files and route files, and pure extractors produce endpoints that a state machine upserts with evidence. The browser harness is Playwright driving the real vite build against a seeded throwaway DB — outside `pnpm test` (needs a browser), run explicitly.

**Tech Stack:** existing workspace + `nodemailer` (SMTP behind the Phase 5 `Mailer` seam) + `playwright` (dev-only, apps/web). No tree-sitter (deviation 1).

**Spec:** SPEC §5.5/GHA-7, §7 WL-5 cookies, §6.2 LFC, §9 week 10, §10 test strategy; PRD §2.6 LFC-1..5, §2.3 GNT-9. Prior plans: phases 1-5.

## Global Constraints

Everything from Phases 1-5 holds. New:

- **Backward-compatible crypto**: un-prefixed `private_key_pem` values stay readable forever; encryption engages only when `FOREMAN_MASTER_KEY` (64 hex chars) is set. Decrypt failures are loud errors, never silent plaintext fallback.
- **CSRF protects mutations only** (POST/PUT/PATCH/DELETE under `/api`); reads stay header-free. The MCP/ingest/webhook services are bearer-token surfaces — no CSRF there.
- **Lifecycle states are evidence-backed** (LFC-2): every state transition stores `{kind, ref}` evidence; a state never regresses except via a fresh scan that no longer finds the endpoint (then `deprecated`).
- **Injection posture unchanged** (X-6): repo file contents are untrusted text — extractors parse structurally, never execute, and path/method strings are length-capped.

### Documented deviations (reviewers take note)

1. **No tree-sitter, three frameworks in v1**: extractors are structural line/regex parsers over API-fetched file contents for **OpenAPI/Swagger specs, Express/Fastify, FastAPI, and Next.js app-router**. Django/Rails/Spring + tree-sitter precision land when repo-checkout infra exists. The ≥90% recall target applies to the supported set (fixture-tested).
2. **Deployment evidence is repo-granular in v1**: a successful `deployment_status` webhook moves that repo's `tested`/`implemented` endpoints to `deployed` (evidence = deployment id) and appends `deploy.succeeded`. Commit-level endpoint mapping needs diff data we don't ingest yet.
3. **Work-item linkage is heuristic in v1** (LFC-3): `work_item_ids` = items whose title or intent contains the endpoint path (case-insensitive, path length ≥ 4). Honest, cheap, replaceable.
4. **`__Host-` cookie only in production mode** — browsers reject it on plain http; dev keeps `fmn_session`. The cookie name is derived in one place (`sessionCookieName(devAuth)`).
5. **Perf assertion is a floor, not 60fps**: headless CI jank makes a hard 60fps flaky; the harness asserts average scripted-scroll frame time < 33ms (30fps floor) AND ≤ 80 rendered bars at 2,000 rows. The 60fps target stays in the report output.
6. **Rate bucket is a fixed-window counter** at 80% of the observed hourly limit via atomic `Kv.incr` — simpler than a leaky bucket, satisfies "never exceed 80%" per window; the pre-flight header check from Phase 2 stays as the outer guard.

## File structure

```
packages/db/migrations/0007_endpoints_email.sql   # endpoints table, projects.brief_email
packages/events/src/registry.ts                    # + "lifecycle.scanned"
packages/github-client/src/kv.ts                   # Kv.incr (atomic)
packages/github-client/src/client.ts               # token bucket in pre/post-flight
apps/github/src/crypto.ts                          # sealPem/openPem envelope
apps/github/src/lifecycle/extract.ts               # PURE: spec + route extractors
apps/github/src/lifecycle/scan.ts                  # scanLifecycle + state machine
apps/github/src/handlers/{index,deployment}.ts     # foreman.lifecycle_scan + deployment_status routes
apps/api/src/csrf.ts, http.ts, routes.ts           # WL-5 + lifecycle/briefs/revisions endpoints
apps/gen/src/deliver.ts                            # SmtpMailer (nodemailer), email channel
apps/web/src/diff.ts                               # PURE line diff
apps/web/src/overview/OverviewTab.tsx              # revisions + diff expander
apps/web/src/lifecycle/LifecycleTab.tsx            # endpoint table + gaps
apps/web/e2e/smoke.spec.ts                         # Playwright: login→gantt→agents→2000-row scroll
apps/web/e2e/seed.ts                               # throwaway DB + api + built web server
```

---

### Task 1: Migration 0007 + registry

**Files:** `packages/db/migrations/0007_endpoints_email.sql`, registry addition, test `packages/db/src/phase6-schema.test.ts`

```sql
create table endpoints (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  gh_repo         text not null,
  method          text not null,
  path            text not null,
  state           text not null default 'planned'
    check (state in ('planned','stubbed','implemented','tested','deployed','deprecated')),
  evidence        jsonb not null default '[]',   -- [{kind, ref}] per LFC-2
  work_item_ids   uuid[] not null default '{}',
  in_spec         boolean not null default false,
  has_impl        boolean not null default false,
  has_test        boolean not null default false,
  first_seen      timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (project_id, method, path)
);
create index on endpoints (project_id, state);
alter table projects add column brief_email text;
-- RLS: 0002 pattern on endpoints.
```
Registry: `"lifecycle.scanned": z.object({ gh_repo: str, found: z.number().int(), changed: z.number().int() }).strict()`.
- [ ] Failing schema test (tables/columns/RLS, phase5 pattern) → migrate → db suite green → commit `feat(db): endpoints table + brief email (0007, LFC)`.

---

### Task 2: WL-5 — CSRF double-submit + Origin validation + prod cookie prefix

**Files:** `apps/api/src/csrf.ts`, modify `http.ts`, `auth.ts` (cookie name helper); tests extend `routes.test.ts` + new `csrf.test.ts`

- `sessionCookieName(devAuth: boolean)` → `devAuth ? "fmn_session" : "__Host-fmn_session"`; prod set-cookie adds `Secure`.
- On dev-login response ALSO set `fmn_csrf` cookie (NOT HttpOnly, `SameSite=Lax; Path=/`; `Secure` in prod) = 32-byte random hex.
- Middleware on mutations (POST/PUT/PATCH/DELETE under `/api`): (a) if an `Origin` header is present it must match `deps.allowedOrigin` (default derived from request host) else 403; (b) `x-csrf-token` header must equal the `fmn_csrf` cookie (timing-safe) else 403. GET/HEAD untouched.
- [ ] Failing tests: mutation without the header → 403; with matching header+cookie → passes; mismatched → 403; cross-site `Origin: https://evil.test` → 403 even with a valid token; GETs unaffected. Existing mutation tests updated to send the token (helper `authedHeaders(cookie)` returns cookie+csrf pair).
- [ ] Implement → green → commit `feat(api): WL-5 - csrf double-submit, origin validation, __Host- cookie in prod`.

---

### Task 3: GHA-7 — atomic token bucket in the github client

**Files:** `packages/github-client/src/kv.ts` (+`incr`), `src/client.ts`; tests extend `client.test.ts`

- `Kv.incr(k: string, ttlSec: number): Promise<number>` — atomic increment-and-expire (InMemory: map counter; Redis: `INCR` + `EXPIRE NX`).
- Client: after each response stores `ghlimit:{installationId}` = observed `x-ratelimit-limit` (TTL 1h). Pre-flight: when a limit is known, `incr("ghwin:{installationId}:{floor(now/3600)}", 3600)`; if count > `0.8 * limit` → `RateLimitedError(windowEnd)` without calling fetch (deviation 6). Header floor check from Phase 2 stays.
- [ ] Failing tests: with observed limit 10, the 9th request in the window throws without fetch (8 = 80% cap); a new window admits again; unknown limit → no bucket enforcement.
- [ ] Implement → green (whole package) → commit `feat(github-client): 80% fixed-window token bucket on atomic kv incr (GHA-7)`.

---

### Task 4: Envelope encryption for App private keys

**Files:** `apps/github/src/crypto.ts`; wire into `setup.ts` (store sealed), `scripts/seed-app.ts`, and the two `getApp` readers (`apps/github/src/main.ts`, `apps/api`? no — only github + roundtrip use pems); tests `crypto.test.ts` + setup test extension

- `sealPem(pem, masterKeyHex)` → `enc:v1:<iv b64>:<tag b64>:<ciphertext b64>` (AES-256-GCM); `openPem(stored, masterKeyHex | undefined)` — `enc:v1:` prefix requires the key (loud error if absent/wrong), un-prefixed returns as-is.
- `keyFromEnv()` reads `FOREMAN_MASTER_KEY`; setup/seed seal when key present; every `getApp`/token-source path opens.
- [ ] Failing tests: seal/open round-trip; tampered tag throws; open without key on `enc:` throws; plaintext passes through; setup with env key stores an `enc:v1:` value and the manifest flow still mints tokens (fake GH test passes the opened pem to `appJwt`).
- [ ] Implement → green → commit `feat(github): envelope-encrypted app private keys with plaintext compatibility (hardening)`.

---

### Task 5: SMTP + email brief delivery + delivery status

**Files:** `apps/gen/src/deliver.ts` (SmtpMailer, email channel), `apps/gen/package.json` (+nodemailer), `apps/api/src/routes.ts` (briefs list gains `delivered` channels); tests extend `deliver.test.ts`, `routes.test.ts`

- `SmtpMailer implements Mailer` — `nodemailer.createTransport(smtpUrl)`; `mailerFromEnv()` → SmtpMailer when `FOREMAN_SMTP_URL` set else LogMailer. `deliverBrief` email path: when `projects.brief_email` set and a mailer is provided → `mailer.send(brief_email, "Foreman brief — {window_end date}", renderBriefHtml(content))` + `brief.delivered {channel:'email'}`; mailer failure logs, no event. Scheduler passes `mailerFromEnv()`.
- Briefs list endpoint adds `delivered: string[]` per brief (from `brief.delivered` events).
- [ ] Failing tests: fake Mailer receives the html and the event lands; no `brief_email` → mailer untouched; SmtpMailer built with `jsonTransport` sends through nodemailer; briefs list carries `delivered: ["webhook"]` for the fixture.
- [ ] Implement → green → commit `feat(gen,api): smtp mailer behind the seam, email channel, delivery status (BRF-4/6)`.

---

### Task 6: Overview version diffs (OVW-2)

**Files:** `apps/web/src/diff.ts` (pure LCS line diff → `Array<{op:'same'|'add'|'del', text}>`), `apps/api/src/routes.ts` (`GET /api/projects/:id/overview/:sectionId/revisions` newest-first `{version, content, caused_by, created_at}`), `apps/web/src/overview/OverviewTab.tsx` (History expander per section: fetch revisions, render diff of latest vs previous with +/− colouring); tests `diff.test.ts`, routes + OverviewTab extensions

- [ ] Failing tests: diff of "a\nb\nc" vs "a\nx\nc" → same/del(b)/add(x)/same; identical → all same; revisions endpoint lists both versions after an override; History click renders an `ins`-marked line.
- [ ] Implement → green → commit `feat(web,api): overview revision history with readable line diffs (OVW-2)`.

---

### Task 7: Lifecycle extractors (pure)

**Files:** `apps/github/src/lifecycle/extract.ts`; test `extract.test.ts`

**Produces** (`Found = {method, path, source: 'spec'|'impl', framework?, trivial?: boolean}`):
- `extractOpenApi(content: string): Found[]` — JSON or YAML-lite (indentation walk for `paths:` block; JSON via JSON.parse) → one per path+method, `source:'spec'`.
- `extractExpress(content)` — `(app|router)\s*\.\s*(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)` → impl; `trivial` when the handler body within the next ~120 chars matches only `res.(send|json|status)` -one-liner or `NotImplemented|TODO`.
- `extractFastApi(content)` — `@(app|router)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)` ; trivial when the following `def` body is `pass`/`raise NotImplementedError` within 3 lines.
- `extractNextRoutes(path, content)` — for files matching `app/**/route.(ts|js)`: exported `GET|POST|PUT|PATCH|DELETE` functions; path derived from the file path (`app/api/users/[id]/route.ts` → `/api/users/:id`).
- `detectTests(content, endpoints)` — a test file's content referencing an endpoint path string marks `has_test`.
- All extractors cap path length at 200 and drop non-`/`-prefixed paths (X-6).
- [ ] Failing fixture tests per extractor (recall fixture: every seeded route found; a decoy string in a comment NOT found for Next; trivial detection positive+negative) → implement → green → commit `feat(github): lifecycle extractors - openapi, express, fastapi, next.js (LFC-1)`.

---

### Task 8: Lifecycle scan + state machine + triggers

**Files:** `apps/github/src/lifecycle/scan.ts`, `handlers/index.ts` (+`foreman.lifecycle_scan`), new `handlers/deployment.ts` (`deployment_status`), `apps/api/src/routes.ts` (`POST /api/projects/:id/lifecycle/scan` enqueues), reconcile enqueue extension; tests `scan.test.ts` + handler tests

- `scanLifecycle(tx, gh, project)` — per `gh_repos`: `GET /repos/{o}/{r}/git/trees/HEAD?recursive=1` (stubbed in tests) → pick spec files (`openapi.*`, `swagger.*`, `asyncapi.*`), route files (`*.ts/js` with express markers fetched selectively: any `src/**/*.{ts,js,py}` up to 50 files, `app/**/route.*`), test files (`*.test.*`, `*_test.py`, `tests/**`); fetch contents (base64 via contents API); run extractors; merge per (method, path): `in_spec`, `has_impl`, `trivial`, `has_test`.
- State machine (LFC-2, monotone per scan): spec-only → `planned`; impl trivial → `stubbed`; impl non-trivial → `implemented`; impl+test → `tested`; previously `deployed` stays deployed if still found; found-before-but-now-absent → `deprecated`. Evidence array rebuilt each scan (`{kind:'spec'|'impl'|'test', ref: file path}`); work_item_ids via the deviation-3 heuristic; upsert + `state_changed_at` only on change; append one `lifecycle.scanned` per repo.
- `handleDeploymentStatus(tx, job)` — `state === 'success'` → repo's `implemented|tested` endpoints → `deployed` (evidence `{kind:'deploy', ref: deployment id}`) + `deploy.succeeded`; failure → `deploy.failed` event only.
- Routing: `foreman.lifecycle_scan` job (payload `{project_id}`) → scanLifecycle with ctx.gh; reconcile cron also enqueues one per GitHub-connected project; api POST enqueues (202).
- [ ] Failing tests: stubbed tree+contents fixture (openapi with 2 paths, express file with 3 routes incl 1 trivial, a test file referencing one path) → endpoint rows with exact states (`planned` for spec-only, `stubbed`, `implemented`, `tested`), evidence refs, `in_spec/has_impl/has_test` flags; second scan idempotent; removing a route → `deprecated`; deployment_status success promotes; api POST enqueues job for own org and 404s cross-org.
- [ ] Implement → green → commit `feat(github,api): lifecycle scan - evidence-backed endpoint state machine + deployment promotion (LFC-1/2/5)`.

---

### Task 9: Lifecycle reads + UI tab (LFC-3/4)

**Files:** `apps/api/src/routes.ts` (`GET /api/projects/:id/lifecycle` → `{endpoints, gaps}` where gaps = `{untested: n, unspecced: n, unimplemented: n}` set differences), `apps/web/src/lifecycle/LifecycleTab.tsx` (+ ProjectView fifth tab); tests both sides

- Table: METHOD chip, path, state chip (colour per state), evidence file refs, linked work items count; gaps summary line on top ("3 implemented without tests · 1 spec without implementation · 2 implemented without spec").
- [ ] Failing tests: api returns the Task 8 fixture with computed gaps; UI renders states + the gaps line; clicking an endpoint row shows evidence refs.
- [ ] Implement → green → commit `feat(web,api): lifecycle view - endpoint states and coverage gaps (LFC-3/4)`.

---

### Task 10: Browser smoke + GNT-9 harness (Playwright)

**Files:** `apps/web/e2e/seed.ts`, `apps/web/e2e/smoke.spec.ts`, `apps/web/package.json` (+`playwright` dev dep + `test:e2e` script), NOT in root vitest projects.
**Process note:** invoke the `webapp-testing` skill when building this task.

- `seed.ts`: create throwaway DB (`@foreman/db/testing`), seed org/user/project + 2,000 dated work items with a dependency chain + 3 agents; boot foreman-api on a port; `vite build` + `vite preview` for the web app with `/api` proxied (preview supports proxy via config).
- `smoke.spec.ts` (chromium headless): login with the seeded email → project list → open project → Gantt bars visible (`[data-item-id]` count ≤ 80 — virtualisation at 2,000 rows) → Agents tab shows 3 rows → Overview tab regenerate button present → **scroll harness**: scripted `scrollTop` sweep over the Gantt container while sampling `requestAnimationFrame` deltas for ~3s; assert mean frame < 33ms (deviation 5) and report the fps number.
- [ ] Write spec → `pnpm --filter foreman-web exec playwright install chromium` → run `test:e2e` → fix whatever the first-ever browser run exposes → green → commit `test(web): first browser smoke + GNT-9 virtualised scroll harness (playwright)`.

---

### Task 11: Phase e2e + full suite

- [ ] Extend `apps/gen/src/e2e.test.ts` or add `apps/api/src/phase6.e2e.test.ts`: CSRF-protected mutation round-trip (fetch csrf cookie, answer a checkpoint with the header); sealed App key still completes the manifest→token path; lifecycle scan job through `handleSyncJob` with stubbed gh produces endpoints visible via the api with gaps; brief with `brief_email` + fake mailer → `delivered: ["webhook","email"]` in the briefs list.
- [ ] `pnpm test && pnpm -r typecheck` all green.
- [ ] Commit `test(e2e): csrf mutations, sealed keys, lifecycle scan to UI read, dual-channel brief delivery`.

---

## Self-review checklist

- Coverage: WL-5 ✅ T2 (PSL/apex split stays hosted-deploy work, noted); GHA-7 ✅ T3 (deviation 6); key encryption ✅ T4 (KMS = master-key source swap); BRF-4 email ✅ T5, BRF-6 status ✅ T5; OVW-2 diff ✅ T6; LFC-1 ✅ T7/T8 (deviation 1 scope), LFC-2 ✅ T8 evidence machine, LFC-3 ✅ deviation 3, LFC-4 ✅ T9 gaps, LFC-5 ✅ T8 deployment promotion; GNT-9 ✅ T10 (deviation 5 floor); §10 injection/RLS already standing from prior phases.
- Placeholders: none — extractor patterns, state transitions, cookie/CSRF mechanics, and harness assertions are all specified.
- Type consistency: `Found`/`Endpoint` shapes flow T7→T8→T9; `Kv.incr` added T3 used nowhere else; `Mailer` seam unchanged from Phase 5; csrf helper names shared between T2 and T11.
