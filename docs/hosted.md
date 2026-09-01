# Running Foreman as a hosted / multi-tenant platform

This is the honest state of Foreman's hosted story: what's implemented and proven by a test
today, versus what's designed and documented but not yet code (PRD §2.9 whitelabel/multi-tenant
work list, `WL-1`..`WL-10`; SPEC §12). Phase 9 landed the control-plane split, KMS-ready key
source, and neutral metering (`WL-8`, `WL-9`); it did **not** land domains, theming, or a timed
partner runbook — those stay design-only and are flagged as such below.

## 1. Planes & credentials

Foreman runs two planes, and the boundary between them is enforced by Postgres roles, not by
convention:

| Plane | Services | Postgres role(s) | Can provision tenants? |
|---|---|---|---|
| **Application** | `apps/api`, `apps/github`, `apps/ingest`, `apps/mcp`, `apps/scheduler`, `apps/projector`, `apps/gen`, `apps/web` | `foreman_app` (RLS-bound, `DATABASE_URL_APP`) and `foreman_service` (bypasses RLS for workers/seed, `DATABASE_URL`) | No |
| **Control** | `apps/control` (`:3006`, `FOREMAN_CONTROL_PORT`) | `foreman_control` (`FOREMAN_CONTROL_DATABASE_URL`) | Yes — the only role that can |

Migration `0008_control_plane.sql` is what makes "no" true, not a policy on paper:

- `revoke insert, delete on organisations, brands from foreman_app` — the application plane
  physically cannot create or destroy a tenant, regardless of what application code does or a
  future bug ships.
- `usage_records` ships with a single `select`-only RLS policy (`usage_records_tenant_select`,
  scoped by `foreman.is_member(organisation_id)`) and **no insert/update policy at all** — so
  `foreman_app`'s table-level grants (from 0002's `alter default privileges`) are moot; RLS
  denies the write outright. Only `foreman_control` (`bypassrls`) can write usage.
- `apps/control` is a separate deployable (own `package.json`, own port, own bearer token
  `FOREMAN_CONTROL_TOKEN`, timing-safe compared). No application-plane service imports it,
  proxies to it, or holds its credential.

**Point auditors at `packages/db/src/control-plane.test.ts`** — this is the WL-8 architecture
test, and it proves the boundary two ways:

1. A live-permission test: connecting as `foreman_app` and running
   `insert into organisations` / `delete from organisations` raises `permission denied`;
   connecting as `foreman_control` the same statements succeed. A second case does the matching
   check for `usage_records` writes (`rejects.toThrow(/row-level security/)`), so RLS drift or a
   migration regression trips the test, not a code review.
2. A static grep test: it walks every file under
   `apps/{api,github,ingest,mcp,scheduler,projector,gen,web}/src` and fails if any of them
   contain the literal strings `FOREMAN_CONTROL_TOKEN` or `foreman_control` — so even a
   correctly-scoped role can't quietly grow a second caller.

Run it directly with `pnpm --filter @foreman/db test -- control-plane`.

## 2. Key management (KMS-ready, not KMS-integrated)

GitHub App private keys are sealed at rest with AES-256-GCM (`enc:v1:<iv>:<tag>:<ciphertext>`,
base64 parts) whenever a master key is configured; unprefixed rows are read as legacy plaintext.
Decrypt failures are always loud (`openPem` throws) — there is no silent unencrypted fallback.

`resolveMasterKey()` (`apps/github/src/crypto.ts`) tries three sources in order, and validates
64-hex (32 bytes) from every one of them so a bad key from any source throws immediately, naming
which source produced it:

1. **`FOREMAN_MASTER_KEY`** — the key material directly, as an env var. Same validation as the
   legacy `keyFromEnv()`, which stays exported for existing seed/setup callers.
2. **`FOREMAN_MASTER_KEY_FILE`** — path to a file (e.g. a mounted Kubernetes secret or Docker
   secret); the file is read, trimmed, then validated. Read failures name the path in the error.
3. **`FOREMAN_MASTER_KEY_CMD`** — a shell command whose stdout is the key. This is the KMS
   integration point: it turns "call a cloud KMS" into "run its CLI," so Foreman never vendors an
   AWS/GCP/Vault SDK. On Windows it runs via `cmd /c` (with `windowsVerbatimArguments` so the
   command's own quoting survives); everywhere else via `/bin/sh -c`.

Copy-paste examples (the command's stdout must be 64 hex characters — decode/convert accordingly):

```bash
# AWS KMS — decrypt a sealed data key, base64-decode, hex-encode
export FOREMAN_MASTER_KEY_CMD='aws kms decrypt \
  --key-id alias/foreman-master \
  --ciphertext-blob fileb:///run/secrets/foreman-master-key.enc \
  --query Plaintext --output text | base64 -d | xxd -p -c 256'
```

```bash
# HashiCorp Vault — KV v2 secret holding the 64-hex key directly
export FOREMAN_MASTER_KEY_CMD='vault kv get -field=key secret/foreman/master-key'
```

**Rotation note:** the `enc:v1:` prefix is a version tag on purpose. Rotating to a new master key
without re-encrypting every row in place means adding an `enc:v2:` writer while `openPem` keeps
reading both prefixes with their respective keys (dual-read), then backfilling `enc:v1:` rows to
`v2` at your own pace. That dual-read path is not built yet — today there is exactly one active
key and one format — but the prefix leaves the room for it deliberately.

## 3. Domains & cookies

| Item | Status |
|---|---|
| `__Host-` prefixed session cookie (`Secure; HttpOnly; Path=/`, no `Domain` attribute) | **Shipped.** `apps/api/src/auth.ts` uses the `__Host-` prefix whenever `devAuth` is off (production); CSRF tokens are required on every mutating request (`apps/api/src/csrf.ts`). |
| Custom hostnames per tenant via Cloudflare for SaaS (`WL-4`) | **Planned, not built.** No code in this repo calls the Cloudflare for SaaS API. Budget for its operational limits before building it: 100 custom hostnames included per plan ($0.10/hostname/month beyond, 50,000 pay-as-you-go cap), 15 certificate issuances/minute then a 30s lockout, hostnames over 64 characters need `cloudflare_branding: true`, and certificate-ready webhooks are Enterprise-only (poll status otherwise). Prefer TXT or Delegated DCV over HTTP DCV — HTTP DCV races DNS cutover and can't do wildcards. |
| PSL submission of the shared tenant apex + a separate admin-console apex (remainder of `WL-5`) | **Planned, not built.** Until the shared apex (e.g. `*.foreman.example`) is on the Public Suffix List, a cookie set by one tenant's subdomain is a same-site cookie the browser will also send to every other tenant's subdomain — the `__Host-` prefix alone doesn't fix cross-tenant cookie scope, only cross-origin leakage. The admin console needs its own, unrelated apex so an operator session is never a same-site neighbor of any tenant's. |

## 4. Metering & billing neutrality (WL-9)

`usage_records (organisation_id, period_start, period_end, metric, value)` — that's the whole
shape. There is no price column, no currency column, and no code anywhere in this repo that
attaches a dollar amount to a metric. Pricing is explicitly the partner's problem, per PRD `WL-9`:
"Metering emits a neutral usage record; pricing is a separate, replaceable service."

`meterUsage()` (`packages/db/src/usage.ts`) computes four metrics per organisation for a given
period, upserted (idempotent re-run for the same period):

- `events_ingested` — count of events recorded in the window.
- `active_agents` — distinct agents that produced an event in the window.
- `items_completed` — count of `work.completed` events in the window.
- `seats` — current `organisation_members` count (not windowed; a point-in-time seat count).

Control-plane API surface (`apps/control`, bearer `FOREMAN_CONTROL_TOKEN`):

- `POST /metering/run {period_start, period_end}` — runs `meterUsage`, returns `{records}`
  written. Intended to be called on a schedule (cron/step function) by whoever operates the
  control plane — there is no built-in scheduler for it in this phase.
- `GET /tenants/:id/usage?from=&to=` — the raw `usage_records` rows for a tenant. A tenant can
  also read their own rows directly through the application plane's RLS (§1), so a partner's
  billing system can point at either the control plane or a service account against `foreman_app`.

A partner applies their own price sheet to these metrics however they like; nothing here assumes
per-seat, per-event, or any other pricing model.

## 5. WL-10 partner-day checklist — honest status

PRD `WL-10`: "An OEM partner MUST be able to stand up a fully branded instance in under one day
without our engineering involvement." The intended flow is **manifest → control-plane provision →
theme**. Here is what each step actually is today:

1. **GitHub App manifest flow (bot identity, `WL-6`)** — **shipped.** `GET
   /setup/github/start?org_slug=&gh_org=` walks the manifest conversion and install callback
   (`docs/quickstart.md` §5); the resulting App's bot appears as `foreman-<partner>[bot]` on the
   partner's repos (`manifest.name = foreman-${orgSlug}`, `apps/github/src/setup.ts`) — real,
   exercised code, not aspirational. Note this is Foreman-first naming: the PRD's `WL-6` wording
   implies a partner-first bot identity (e.g. `<partner>-foreman[bot]`), which would need the
   manifest name to become a tenant-configurable value rather than the fixed `foreman-` prefix
   used today — that's future work, not yet built.
2. **Control-plane provisioning** — **shipped.** `POST /tenants {slug, tier, isolation?,
   owner_email}` creates the organisation, finds-or-creates the owner user, and adds them as
   `owner` in one transaction (`apps/control/src/routes.ts`); `PATCH /tenants/:id` changes tier or
   isolation after the fact. This is the "stand up a tenant" half of the day-one story.
3. **Branded theme** — **not built.** PRD `WL-2`/`WL-3` describe a validated tenant theme JSON
   (CSS custom properties, contrast-checked at save time against every foreground/background
   pair) served by the control plane. No theme storage, validation, or rendering exists yet; a
   partner today gets Foreman's own look.
4. **Custom domain for the branded instance** — **not built.** Depends on §3's Cloudflare for
   SaaS work (`WL-4`) and the PSL/admin-apex split (`WL-5` remainder); until then a partner
   instance is reachable only on Foreman's own domain/subdomain scheme.
5. **The "under one day, no engineering involvement" claim itself is untested.** `WL-10`'s
   acceptance criterion is "timed run-through by someone outside the team" — that run-through has
   not happened. Steps 1-2 are real and fast; steps 3-4 being absent means today's honest answer
   is "a partner can get a working, unbranded, un-customized-domain tenant in minutes, and
   everything past that is future work," not "under a day, fully branded."

Nothing in this section should be read as more finished than it is: sections 3's two rows and
this section's items 3-5 are the concrete list of what's left before `WL-4`, `WL-5`, and `WL-10`
can be marked done.
