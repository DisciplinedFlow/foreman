# Foreman quickstart — zero to a visible agent

The design-partner path: infrastructure → seed → services → first agent in the Agent View →
GitHub connected. Every command below is copy-pasteable from the repo root; anything that still
requires manual SQL says so explicitly.

## 1. Infrastructure

```bash
pnpm install
pnpm db:up        # Postgres 16 on :5433, Redis 7 on :6380
pnpm db:migrate   # creates the `foreman` database and applies migrations 0001-0007
pnpm db:seed      # org `dev`, user dev@localhost, project `dev-project`, and an agent token
```

`db:seed` prints an `fmn_agt_…` token — copy it, you'll use it twice below. Re-running seed is
safe and mints a fresh token each time.

## 2. Services

Each service is a separate process; run the ones you need in separate terminals:

```bash
pnpm --filter foreman-api start                          # :3003 — BFF for the UI
pnpm --filter foreman-web dev                            # :5173 — the UI (proxies /api + /auth to :3003)
pnpm --filter foreman-ingest start                       # :3004 — Claude Code hook receiver
DATABASE_URL="postgres://foreman_service:foreman_service@localhost:5433/foreman" pnpm --filter foreman-mcp start   # :8811 — MCP server (DATABASE_URL required)
pnpm --filter foreman-scheduler start                    # leases, stalls, briefs, regen push
pnpm --filter foreman-projector start                    # critical-path projection
pnpm --filter foreman-github start                       # :3002 — only needed for GitHub sync
```

> PowerShell equivalent for the env var: `$env:DATABASE_URL = "postgres://foreman_service:foreman_service@localhost:5433/foreman"; pnpm --filter foreman-mcp start`

Open http://localhost:5173, log in with **dev@localhost** (dev-login; no password), and open
**dev-project**. The Gantt/Agents/Graph/Overview/Lifecycle tabs are all live — empty until agents
and items exist.

## 3. First agent (ten-second path: passive telemetry)

Install the Claude Code plugin from this repo and point it at your Foreman:

```bash
claude plugin install foreman@<path-or-marketplace-for-this-repo>/integrations/claude-code-plugin/foreman-plugin \
  --config endpoint=http://localhost:3004 --config token=<the fmn_agt_ token from db:seed>
```

> The plugin's hooks POST to `${endpoint}/ingest/hook` — for hooks-only telemetry the endpoint is
> the **ingest** service (`:3004`). If you front all services with one reverse proxy, use that
> origin instead; the plugin's MCP entry expects `${endpoint}/mcp` on the same origin, which in
> plain local dev is the MCP server on `:8811` — configure the `foreman` MCP server manually in
> that case: `claude mcp add --transport http foreman http://localhost:8811/mcp --header "Authorization: Bearer <token>"`.

Start any Claude Code session in any repo: the `SessionStart` hook announces a telemetry agent
automatically and it appears in the Agent View within seconds. Tool calls stream in as activity
(metadata only — tool inputs are dropped unless the org opts in).

## 4. First work item over MCP (full loop)

With the `foreman` MCP server configured (step 3 note), an agent can run the whole loop:
`foreman__agent_announce` → `foreman__work_claim {wait:true}` → poll `tasks/get` →
`foreman__work_report` → `foreman__work_checkpoint` (answer it in the UI's decision card) →
`foreman__work_complete`. The bundled skill (`skills/foreman/SKILL.md` in the plugin) teaches
Claude this loop; enqueue work by creating items via GitHub sync (step 5) — or, until you connect
GitHub, by SQL (**manual-SQL gap**, admin UI pending):

```sql
insert into work_items (organisation_id, project_id, title, intent, acceptance)
select organisation_id, id, 'my first item', 'do the thing', '["it works"]'
from projects where name = 'dev-project';
```

(`docker exec -it <postgres-container> psql -U postgres foreman` to get a prompt.)

## 5. Connect GitHub

With `foreman-github` running and reachable from GitHub (use a tunnel for local dev, e.g.
`cloudflared tunnel --url http://localhost:3002`, and set `FOREMAN_PUBLIC_URL` to the tunnel URL):

1. Visit `http://localhost:3002/setup/github/start?org_slug=dev&gh_org=<your-github-org>`.
2. Approve the App manifest on GitHub → you're redirected back → install the App on your repos.
3. Link the project to repos/board (**manual-SQL gap**, Phase 3 UI pending):
   ```sql
   update projects set gh_repos = array['your-org/your-repo'], gh_installation_id = <id>
   where name = 'dev-project';
   ```
   (the installation id is printed in the `github_installations` table by the install callback.)
4. Issues sync both ways within a webhook round-trip; the Lifecycle tab's **Rescan** discovers
   your API endpoints; drag a Gantt bar and watch the Projects v2 date move.

## 6. Briefs and overview

```sql
update projects set brief_schedule = 'daily', brief_timezone = 'Europe/Amsterdam',
  brief_webhook_url = 'https://your-webhook', brief_email = 'you@example.com'
where name = 'dev-project';
```

Briefs fire at 07:00 project-local time (email needs `FOREMAN_SMTP_URL`). The Overview tab's
**Regenerate** works with no API key (deterministic extractive sections); set
`ANTHROPIC_API_KEY` for generated prose.

## Verifying an install

```bash
pnpm test                            # 240+ tests, throwaway DBs
pnpm --filter foreman-web test:e2e   # real-browser smoke, 60fps Gantt check
pnpm --filter foreman-mcp test:load  # 100 concurrent agents, p95 event→SSE
```
