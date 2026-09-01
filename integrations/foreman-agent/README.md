# foreman-agent

A provider-agnostic agent runner: connects to Foreman's MCP server as an
external agent (bearer token, `foreman__*` tools) and drives the work loop —
announce, claim, do the work with whichever model you point it at, report,
complete. Foreman is a control plane; it never runs models or holds a
provider key. This process does, and it stays outside Foreman's services.

Model calls are made with plain `fetch` — no `openai`, `ollama`, or
`@google/*` SDKs. The only Foreman-side dependency is
`@modelcontextprotocol/sdk`, used here as an MCP **client**.

## Run

Pick a provider with `FOREMAN_AGENT_PROVIDER` + `FOREMAN_AGENT_MODEL`, point
it at your Foreman MCP endpoint and agent token, and start it:

```sh
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

Add `-- --once` to process a single work item and exit, useful for smoke
testing a token/provider combination:

```sh
FOREMAN_AGENT_PROVIDER=ollama FOREMAN_AGENT_MODEL=llama3.1 \
FOREMAN_MCP_URL=http://localhost:8811/mcp FOREMAN_AGENT_TOKEN=fmn_agt_... \
pnpm --filter foreman-agent start -- --once
```

Get `FOREMAN_AGENT_TOKEN` from Foreman's Settings → Tokens UI (or the
`/api/projects/:id/tokens` endpoint) — it's an `fmn_agt_` bearer token scoped
to one organisation/project.

## Environment variables

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

## What the loop does

1. `foreman__agent_announce` — binds this token to an agent identity.
2. `foreman__work_claim { wait: true }` — blocks (via MCP's tasks surface,
   polled with `tasks/get`/`tasks/result`) until a work item is assigned.
3. `foreman__agent_heartbeat { status: "working" }`.
4. Builds a system/user prompt from the item's title/intent/acceptance
   criteria and calls `provider.complete(system, user)`.
5. `foreman__work_report` with the model's reply as the progress note.
6. `foreman__work_complete` with an acceptance verdict — every stated
   criterion is marked `met: true`, since this loop has no independent
   verifier of its own. If the provider call fails, the item is
   `foreman__work_block`ed with the error instead.
7. `foreman__agent_heartbeat { status: "idle" }`, then repeats.

`Ctrl-C` (SIGINT) finishes the item in flight and shuts down cleanly.
`--once` processes exactly one item (or one block, on a provider error) and
returns — handy for CI smoke tests or manually verifying a new token.
