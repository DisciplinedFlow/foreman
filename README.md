# Foreman

Foreman is a control plane for fleets of AI coding agents: a work queue agents claim from over
MCP, passive telemetry that makes any Claude Code session visible in seconds, bidirectional
GitHub sync (issues, Projects v2, check runs), a live Gantt with critical path, stall detection,
human↔agent checkpoints and directives, reproducible daily briefs, a living evidence-backed
project overview, and an API-endpoint lifecycle view — all built on an append-only event log
with row-level-security tenancy.

Specs: [`docs/PRD-Foreman.md`](docs/PRD-Foreman.md) · [`docs/SPEC-Foreman.md`](docs/SPEC-Foreman.md) ·
executed phase plans in [`docs/superpowers/plans/`](docs/superpowers/plans/) ·
**[Quickstart](docs/quickstart.md)** for the end-to-end setup path ·
**[Connecting agents](docs/agents.md)** for the plugin/SDK/provider-agnostic-runner paths.

## Architecture

```
foreman-mcp ────┐
foreman-ingest ─┼─► events (append-only) ─► foreman-projector ─► projections ─► foreman-api ─► web UI
foreman-github ─┘                                   │
                                                    └─► foreman-scheduler ─► events (derived)
```

| Service | Dir | Port | Role |
|---|---|---|---|
| foreman-mcp | `apps/mcp` | 8811 (`PORT`) | MCP server agents connect to (tools + tasks surface) |
| foreman-ingest | `apps/ingest` | 3004 | Claude Code hook receiver (observe-only telemetry) |
| foreman-api | `apps/api` | 3003 | Web BFF: RLS-scoped REST + per-project SSE |
| foreman-github | `apps/github` | 3002 | GitHub App: webhooks, sync worker, manifest onboarding |
| foreman-scheduler | `apps/scheduler` | — | Leases, stall detection, briefs, reconciliation, regen push |
| foreman-projector | `apps/projector` | — | Event log → projections (critical path, health) |
| foreman-gen | `apps/gen` | — | Brief assembly/delivery + living overview (library; crons run in scheduler) |
| web UI | `apps/web` | 5173 | React: Gantt, Agents, Graph, Overview, Lifecycle |
| foreman-control | `apps/control` | 3006 | Provisioning + usage metering; the only service holding `foreman_control` (WL-8) |

Packages: `@foreman/events` (schema registry), `@foreman/db` (migrations, RLS, queue),
`@foreman/github-client` (REST/GraphQL, rate budget, echo cache), `@foreman/backbone`
(work-backbone seam).
Integrations (see [`docs/agents.md`](docs/agents.md)): `integrations/claude-code-plugin`
(hooks + MCP + skill), `integrations/agent-sdk` (`@foreman/agent-sdk`, Claude Agent SDK options
transformer), `integrations/foreman-agent` (provider-agnostic MCP-client agent runner —
Ollama/OpenAI/Anthropic/Google).

## Dev loop

```bash
pnpm install
pnpm db:up          # Postgres 16 :5433, Redis 7 :6380 (docker compose)
pnpm db:migrate     # create + migrate the `foreman` database
pnpm db:seed        # dev org/user/project + a fresh agent token (printed)
pnpm test           # full suite (throwaway DB per test file)
pnpm typecheck
pnpm --filter foreman-web test:e2e   # browser smoke + GNT-9 scroll harness (playwright)
pnpm --filter foreman-mcp test:load  # §10 load harness (100 agents, 2,000 items)
```

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://foreman_service:foreman_service@localhost:5433/foreman` (mcp: **required**) | all services |
| `DATABASE_URL_APP` | `postgres://foreman_app:foreman_app@localhost:5433/foreman` | api (RLS role) |
| `DATABASE_URL_ADMIN` | `postgres://postgres:postgres@localhost:5433/postgres` | db:migrate |
| `PORT` / `FOREMAN_API_PORT` / `FOREMAN_GITHUB_PORT` / `FOREMAN_INGEST_PORT` / `FOREMAN_CONTROL_PORT` | 8811 / 3003 / 3002 / 3004 / 3006 | mcp / api / github / ingest / control |
| `FOREMAN_CONTROL_DATABASE_URL` | `postgres://foreman_control:foreman_control@localhost:5433/foreman` | control (provisioning role, unreachable from the app plane — WL-8) |
| `FOREMAN_CONTROL_TOKEN` | unset (**required**) | control bearer auth |
| `FOREMAN_SESSION_SECRET` | unset (dev-only default, loud warning — **required, ≥32 chars, in production**) | api cookies, github setup state (audit C2 fail-fast) |
| `FOREMAN_DEV_AUTH` | unset (off) | api: `1` mounts `/auth/dev-login`; never set this in production (audit C3) |
| `FOREMAN_PUBLIC_URL` | `http://localhost:3002` | github manifest flow |
| `REDIS_URL` | unset (in-memory Kv) | github worker echo/rate caches |
| `FOREMAN_MASTER_KEY` / `FOREMAN_MASTER_KEY_FILE` / `FOREMAN_MASTER_KEY_CMD` | unset (plaintext keys) | 64-hex AES key sealing GitHub App PEMs — env value, file path, or shell command (KMS-ready; precedence in that order, see [`docs/hosted.md`](docs/hosted.md)) |
| `FOREMAN_SMTP_URL` / `FOREMAN_SMTP_FROM` | unset (log mailer) / `foreman@localhost` | brief email delivery |
| `ANTHROPIC_API_KEY` / `FOREMAN_OVERVIEW_MODEL` | unset (extractive) / `claude-opus-5` | overview prose generation (also used, separately, by foreman-agent's anthropic provider) |
| `SWEEP_INTERVAL_MS` | 30000 | lease sweeper |
| `FOREMAN_STALL_INTERVAL_SEC` | 60 | stall detection (0 off) |
| `FOREMAN_BRIEF_TICK_SEC` | 60 | brief schedule tick (0 off) |
| `FOREMAN_RECONCILE_INTERVAL_SEC` | 3600 | GitHub full-sync + lifecycle rescan (0 off) |
| `FOREMAN_REAP_INTERVAL_SEC` | 60 | scheduler: reaps `sync_jobs` stuck `running` past 120s back to `queued` (0 off) |
| `FOREMAN_OVERVIEW_INTERVAL_SEC` | 0 (off; push covers it) | overview cron |
| `FOREMAN_PUSH_DEBOUNCE_MS` | 2000 | work.completed → regen push ("0" off) |
| `NODE_ENV` | — | `production` enables `__Host-` Secure cookies and requires `FOREMAN_SESSION_SECRET` |
| `FOREMAN_MCP_URL` / `FOREMAN_AGENT_TOKEN` / `FOREMAN_AGENT_PROVIDER` / `FOREMAN_AGENT_MODEL` | — (all **required**) | `integrations/foreman-agent` runner: MCP endpoint, `fmn_agt_` token, `ollama`\|`openai`\|`anthropic`\|`google`, model id — see [`docs/agents.md`](docs/agents.md) |
| `OLLAMA_URL` | `http://localhost:11434` | foreman-agent (ollama provider) |
| `OPENAI_API_KEY` / `OPENAI_BASE` | unset / `https://api.openai.com/v1` | foreman-agent (openai provider; `OPENAI_BASE` for OpenAI-compatible proxies) |
| `GOOGLE_API_KEY` | unset | foreman-agent (google provider) |
