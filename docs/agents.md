# Connecting agents to Foreman

Foreman is a control plane, not a model runtime: it never holds a provider API key and never
calls a model itself. Every agent — whatever it's built on — connects the same way: an
`fmn_agt_` bearer token, scoped to one organisation/project, authenticating against
`foreman-mcp`'s `foreman__*` tools. This page covers the three ways to get an agent talking to
that surface, from lightest to heaviest integration.

Mint (and revoke) tokens in **Settings → Agent tokens** in the web UI, or via
`POST /api/projects/:id/tokens` (see `docs/quickstart.md` §4). `db:seed` prints one for the
first bootstrap only — every token after that comes from the UI or the API.

## 1. Claude Code plugin — passive telemetry, ten seconds

`integrations/claude-code-plugin/foreman-plugin` is a Claude Code plugin: hooks that POST to
`foreman-ingest` on every session/tool-use event (`SessionStart`, `PreToolUse`, `PostToolUse`,
`SubagentStart`/`Stop`, `Stop`, `Notification` — see `hooks/hooks.json`), plus an `.mcp.json`
entry that wires the same token into `foreman-mcp` so the session can also pick up and complete
work items. A bundled skill (`skills/foreman/SKILL.md`) teaches Claude the
announce → claim → report → checkpoint → complete loop described in `docs/quickstart.md` §4.

```bash
claude plugin install foreman@<path-or-marketplace-for-this-repo>/integrations/claude-code-plugin/foreman-plugin \
  --config endpoint=http://localhost:3004 --config token=<fmn_agt_... from Settings → Agent tokens>
```

The plugin's hooks target `${endpoint}/ingest/hook` (the **ingest** service, `:3004` by
default); its MCP entry targets `${endpoint}/mcp` on the same origin. In plain local dev those
are different ports (`:3004` vs `:8811`), so configure the MCP server manually instead of
relying on the plugin's single `endpoint` config:

```bash
claude mcp add --transport http foreman http://localhost:8811/mcp --header "Authorization: Bearer <token>"
```

This path requires no code changes to the agent's own logic — it's the "any Claude Code
session becomes visible in the Agent View" story from the top of the quickstart.

## 2. Claude Agent SDK — first-class options transformer

`integrations/agent-sdk` (`@foreman/agent-sdk`) turns a Foreman MCP endpoint + token into the
options object the [Claude Agent
SDK](https://docs.claude.com/en/api/agent-sdk/overview) expects, so an SDK-driven agent
picks up the `foreman__*` tools alongside its own. Use this when you're already building on
the Agent SDK and want Foreman's queue/MCP surface available inside that agent's tool set,
rather than running a separate process.

## 3. `integrations/foreman-agent` — provider-agnostic runner

For every other model — a local Ollama, or a raw OpenAI/Anthropic/Google API key with no
existing agent harness — `integrations/foreman-agent` is a standalone runner: it connects to
Foreman as an MCP **client** (bearer token, same as the plugin), drives the full work loop
(`announce` → `work_claim {wait:true}` → `heartbeat` → call the model → `work_report` →
`work_complete`/`work_block` → `heartbeat` → repeat), and never lets a provider key anywhere
near a Foreman service — the key lives in this process's environment only. Model calls are
plain `fetch` against each provider's HTTP API; the only Foreman-side dependency is
`@modelcontextprotocol/sdk` used as an MCP client, not a server.

```bash
# Ollama — local, no API key
FOREMAN_AGENT_PROVIDER=ollama \
FOREMAN_AGENT_MODEL=llama3.1 \
FOREMAN_MCP_URL=http://localhost:8811/mcp \
FOREMAN_AGENT_TOKEN=fmn_agt_... \
pnpm --filter foreman-agent start

# OpenAI
FOREMAN_AGENT_PROVIDER=openai \
FOREMAN_AGENT_MODEL=gpt-4o \
OPENAI_API_KEY=sk-... \
FOREMAN_MCP_URL=http://localhost:8811/mcp \
FOREMAN_AGENT_TOKEN=fmn_agt_... \
pnpm --filter foreman-agent start

# Anthropic
FOREMAN_AGENT_PROVIDER=anthropic \
FOREMAN_AGENT_MODEL=claude-fable-5 \
ANTHROPIC_API_KEY=sk-ant-... \
FOREMAN_MCP_URL=http://localhost:8811/mcp \
FOREMAN_AGENT_TOKEN=fmn_agt_... \
pnpm --filter foreman-agent start

# Google
FOREMAN_AGENT_PROVIDER=google \
FOREMAN_AGENT_MODEL=gemini-2.5-pro \
GOOGLE_API_KEY=... \
FOREMAN_MCP_URL=http://localhost:8811/mcp \
FOREMAN_AGENT_TOKEN=fmn_agt_... \
pnpm --filter foreman-agent start
```

Add `-- --once` to process exactly one work item (or one block, on a provider error) and exit —
useful for a CI smoke test or manually verifying a new token before leaving the runner
long-lived. `Ctrl-C` finishes the item in flight before shutting down.

| Variable | Required | Notes |
|---|---|---|
| `FOREMAN_MCP_URL` | yes | Foreman MCP endpoint, e.g. `http://localhost:8811/mcp` |
| `FOREMAN_AGENT_TOKEN` | yes | `fmn_agt_...` bearer token |
| `FOREMAN_AGENT_PROVIDER` | yes | `ollama` \| `openai` \| `anthropic` \| `google` |
| `FOREMAN_AGENT_MODEL` | yes | model name/id passed straight through to the provider |
| `OLLAMA_URL` | no | default `http://localhost:11434` |
| `OPENAI_API_KEY` | if `openai` | |
| `OPENAI_BASE` | no | default `https://api.openai.com/v1`, for OpenAI-compatible proxies |
| `ANTHROPIC_API_KEY` | if `anthropic` | |
| `GOOGLE_API_KEY` | if `google` | |

Full loop details, verdict semantics, and the SIGINT/`--once` shutdown behavior are documented
in `integrations/foreman-agent/README.md`.

## Which path to pick

- Already using Claude Code day-to-day → the plugin (§1); zero agent-side code.
- Building on the Claude Agent SDK → `@foreman/agent-sdk` (§2); Foreman's tools join your
  existing tool set.
- Anything else (Ollama, a bare provider API key, a homegrown harness you don't want to touch)
  → `foreman-agent` (§3); point it at a model and a token, nothing else to write.
