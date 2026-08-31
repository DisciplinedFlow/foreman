# Foreman — Product Requirements Document

**A plug-and-play project-management control plane for AI agent fleets.**

| | |
|---|---|
| **Working codename** | Foreman *(placeholder — the product is white-labelable, so the name is a tenant-level setting, not an identity)* |
| **Version** | 1.0 (draft) |
| **Date** | 31 August 2026 |
| **Status** | For review → then hand Part II to Claude Code as a build brief |
| **Source** | Handwritten concept notes, "Agent Workforce SaaS app / Wrapper" |
| **Audience** | Layered. Part 0–I: founders, investors, design partners. Part II–IV: engineering (human or agent). |

---

# Part 0 — Executive Summary

## The one-paragraph version

Teams now run fleets of AI coding agents. The agents got fast; the humans supervising them did not. Telemetry across 22,000 developers shows epics completed per developer up 66% while median time in review rose 441% and bugs per developer rose 54% — the work moved, the *supervision* broke. Today that supervision happens in terminal tabs and a kanban board built for one developer's laptop. **Foreman is the missing management layer**: a scrum-native Gantt, a live per-agent view, a prioritised handoff queue, a self-updating project overview, and a daily brief — sitting over any agent that speaks MCP, backed by GitHub as the system of record, and shippable under anyone's brand.

## What it is, concretely

Six surfaces, all driven by the same event stream:

1. **Gantt on scrum principles** — sprints as iterations, work items as bars, dependency arrows, critical path. Derived from GitHub Projects v2 iteration + date fields, so it round-trips with GitHub's native Roadmap rather than forking it.
2. **Living project overview** — a document that describes the system as it actually is now, regenerated on every completed work item, versioned and diffable. Not a wiki someone forgot to update.
3. **Agent view** — for each connected agent: current work item, current tool call, token/cost burn, who it is talking to (parent, subagents, peers), and how long it has been stuck.
4. **Handoff queue** — the PM drops work in, priority-ordered; agents pull from it. Not "assign to a name" — a real queue with claim semantics, WIP limits, and backpressure.
5. **Lifecycle view** — the app being built, seen through its API surface: endpoints discovered, implemented, tested, deployed, deprecated. A build's progress measured in capability, not commits.
6. **Brief** — daily/weekly, delivered to the human: what shipped, what stalled, what needs a decision, what it cost.

## Why now

- The bottleneck moved from generation to verification, and every credible practitioner says so. Addy Osmani: *"Once you're running multiple agents in parallel, you stop just debugging context and start managing a team."*
- MCP's **2026-07-28 revision** made this architecturally possible. Its `tasks` extension gives long-running, resumable, pollable work a protocol-level home, and its Multi Round-Trip Request model turns "agent is blocked, needs a human decision" from a bespoke integration into a standard message. Foreman is not a scraper of agent logs — it is a first-class MCP participant.
- The category is unclaimed. Orchestrators are engineer-shaped. Observability tools have no project semantics. AI-native PM tools treat the agent as a black box between assignment and PR. Nobody has shipped a schedule over a fleet.

## The three things that make it defensible

1. **The protocol position.** Foreman is an MCP *server* that agents connect to. Anything that speaks MCP — Claude Code, Agent SDK fleets, Codex, a local Ollama agent with an MCP client, a custom Python loop — is manageable with zero bespoke work. "Works with any agent" is table stakes in 2026; *"any agent works with us without us building an adapter"* is not.
2. **GitHub as the backbone, not a sync target.** Sub-issues give hierarchy (100 children, 8 levels, cross-repo). Issue dependencies give the Gantt's arrows. Projects v2 iterations give the sprint calendar. Check runs give an agent control surface inside the PR UI. We are not maintaining a parallel truth — we are reading and writing GitHub's, which means zero drift and instant credibility with engineering.
3. **White-label at the identity layer.** Most "white-label" is a logo swap. Foreman uses the GitHub App Manifest flow so each customer creates *their own* GitHub App in their own org — meaning the bot that opens PRs is `acme-foreman[bot]`, not ours. That plus custom domains and design tokens is a genuinely resellable product, not a reskin.

## The honest risks

| Risk | Severity | Position |
|---|---|---|
| **The PM persona may not exist yet.** Every practitioner data point is a *developer* supervising agents. No evidence found of non-engineer PMs running fleets. | **High — this is the bet** | Ship to the tech lead / EM who is doing this badly today. Design for the PM. Validate with discovery before building for them. |
| **The "3–5 agents" ceiling.** Consensus sweet spot is 3–5 concurrent agents per human. A Gantt for four bars is absurd. | High | The unit of value is the *team*: 10 devs × 4 agents = 40 concurrent workstreams. Price and pitch at team level. Never demo with one project. |
| **Two closest competitors are dead.** Vibe Kanban ("PM tool for teams building with AI agents") shut down Apr 2026; Terragon shut down Jan 2026. | High | Vibe Kanban's stated cause was its parent company Bloop winding down, not a product verdict — better than it looks, but not exoneration. Diligence whether it had *paying teams* before writing a line of code. |
| **Atlassian has named this problem.** Jira's agent messaging is literally "from agent sprawl to seamless alignment," and Jira already has Gantt. | Medium-high | They have the board and the timeline; they do not have the live agent runtime view. Depth of runtime integration is the moat. Be acquirable-adjacent, not head-on. |
| **Platform dependency.** Claude Code's own Agent View covers the single-developer case natively and will keep improving. | Medium | Never compete with the CLI. Be the surface the CLI cannot be: multi-user, persistent, scheduled, reportable, brandable. |
| **Entry-tier price is commoditised.** Devin went ~$500 → $20. | Medium | Free entry tier is mandatory. Monetise seats + agent slots at team level, and OEM per branded instance. |

---

# Part I — Market & Positioning

## 1.1 The problem, with evidence

**Faros AI, *The Acceleration Whiplash* (12 April 2026)** — telemetry from 22,000 developers, 4,000+ teams, two years. Vendor-published; read directionally, but it is measurement, not a survey.

| Gains | | Costs | |
|---|---|---|---|
| Epics completed / dev | **+66%** | Median time in review | **+441.5%** |
| Task throughput / dev | +33.7% | Median time to first review | +156.6% |
| PR merge rate / dev | +16.2% | PRs merged with **no review at all** | **+31.3%** |
| AI code acceptance rate | 20% → **60%** | Bugs / dev | **+54%** (was +9% in 2025) |
| Teams >50% weekly AI use | 80% | Incidents-to-PR ratio | +242.7% |
| | | Tasks stalled 7+ days | +26% |

Takeaway 9 of that report is the one that matters commercially: **engineering maturity provides no protection.** Mature DevOps orgs degrade the same way. This is not a "get better at process" problem; it is a missing-tool problem.

**LinearB 2026 benchmarks** (8.1M PRs, 4,800 teams) corroborate independently: AI-assisted PRs are 400+ lines at p75 vs 157 unassisted; **AI-assisted PRs wait ~1,000 minutes (16+ hours) for pickup versus ~200 minutes for unassisted — 4.6× longer in queue**; 30-day merge rate collapses from 84.5% to **32.7%**. Two thirds of agent-written PRs never merge.

The nuance that sharpens the argument: once review actually *begins*, AI PRs are reviewed **faster** (194 min vs 252 min). They wait five times longer to be looked at and then get less attention. That is a queueing and triage failure, which is a tooling problem — precisely the one Foreman addresses.

**The human ceiling.** Simon Willison runs four agents in parallel and is depleted by 11am. Addy Osmani puts the sweet spot at 3–5 and states plainly: *"The bottleneck is no longer generation. It's verification."* Superset's operator guide: *"If you run 10 agents and each produces a diff in 15 minutes, you have 10 diffs to review per hour."* Gartner's 2026 market guide names the three needs as **concurrency, visibility and control of agent behavior** — which is, near enough, this product's feature list.

**Charlie Labs** names a second-order problem worth designing for: as agents accelerate, *task generation* becomes the bottleneck. A PM tool for agents is not only a monitoring surface — it is a **task supply** surface. That is what the handoff queue is for.

## 1.2 Competitive landscape

Three adjacent categories, each stopping short.

### Agent orchestrators — engineer-shaped, no schedule

| Product | Position | Gap |
|---|---|---|
| **Devin Desktop** (Cognition, Jun 2026) | Kanban command center, Spaces, open **Agent Client Protocol** supporting Claude/Codex/OpenCode | IDE-shaped, single-dev. No schedule, no portfolio, no brief, no white-label. $20→$200 ladder |
| **GitHub Copilot desktop app** (Jun 2026) | Worktree-isolated sessions, Plan/Autopilot modes, "My Work" | Repo-scoped, credits-priced. Board, not timeline |
| **Claude Code Agent View** (v2.1.139) | Running/Blocked/Done/Failed, live token budget, Agent Teams | **Closest substitute and our platform dependency.** CLI, single-user, ephemeral |
| **Conductor** | macOS + cloud sandboxes, $50/mo | Mac-only, no manager persona |
| **Cursor cloud agents** (Aug 2026) | Event subscriptions, isolated VMs, mid-run steering | Concurrency limits and pricing unpublished |
| **Factory** ($1.5B val.) | Multi-surface, SOC 2 + ISO 42001, integrates *into* Jira/Linear | Own-agent lock-in; integrates with PM rather than being it |
| **Sculptor** (Imbue) | Parallel Claude Code in Docker, pairing mode, free beta | Explicitly for "Claude Code power users with 3+ agents" |
| **Vibe Kanban** | *"PM tool for teams building with AI agents"* | ⚠️ **Shut down 10 Apr 2026** — its parent company Bloop wound down; project continues open-source, community-maintained, fully local |
| **Terragon** | Cloud background-agent orchestration | ⚠️ **Shut down**; source released as-is, Jan 2026, no maintenance |

Two structural facts: (a) the model-agnostic axis has dissolved — everyone supports every agent now, so "works with any agent" sells nothing; (b) the two most PM-adjacent entrants died inside eight months.

**On Vibe Kanban specifically** — the closest-positioned competitor and the most important cautionary tale. Its shutdown post (10 April 2026) attributes the end to **its parent company Bloop shutting down**, not to a stated failure of the product thesis. That is a materially better signal than "the market rejected it," but it is not exoneration: a product with real traction usually finds a home. Treat this as *partially answered* — Open Question #2 stands, and the specific thing to learn is whether it had paying teams, not just installs.

### Observability — traces without project semantics

Langfuse ($199/mo), LangSmith ($39/seat + $5/1k traces), Braintrust ($249/mo), Arize, Weave, Helicone, Datadog LLM Obs. All excellent at spans, tokens, latency, eval scores. None of them know what a *task*, a *sprint*, a *deadline* or a *blocker* is. And the failure mode they explicitly cannot catch is ours: **"an agent stuck in a loop looks like an agent doing work."**

⚠️ **OpenTelemetry GenAI semantic conventions are not stable.** As of 16 July 2026, every `gen_ai.*` attribute carries the "Development" badge; the conventions were split into a separate repo in June 2026 with no tagged releases; `gen_ai.system` was renamed `gen_ai.provider.name`. **Do not architect ingestion as if OTel GenAI is a stable contract.** Consume it as one optional input, normalise into our own schema.

### AI-native PM — the agent is a black box

- **Linear**: agents are app users; you assign or @mention. Docs are explicit that *"the human assignee remains responsible for the issue, even after delegation to an agent."* No Gantt, no fleet monitoring, no live per-agent view. **Agents do not consume billable seats on any plan** (though some AI features consume AI credits, and third-party agent providers price separately) — which caps what anyone can charge for basic agent-assignment.
- **Jira / Rovo**: agents in open beta since 25 Feb 2026. Atlassian's own copy is *"from agent sprawl to seamless alignment."* They have distribution and Advanced Roadmaps. They do not have the runtime view. **This is the strategic threat.**
- **GitHub Copilot + Projects**: single-repo sessions, 59-minute hard timeout, one branch/PR per task. Strong on execution, absent on planning.

### The white space, stated precisely

> No shipped product provides a **schedule** over an agent fleet, a **portfolio** view above the repo, or a **manager persona** as the primary user. Orchestrators stop at the kanban board. Observability stops at the trace. PM tools stop at the assignment.

## 1.3 Users

| Persona | Job | Today | Success |
|---|---|---|---|
| **Ada — Tech Lead / EM** *(primary, v1)* | Keep 4 devs × 4 agents from producing 40 unreviewable PRs | Terminal tabs, Slack, memory | Sees the whole fleet in one view; knows what's stuck before standup |
| **Priya — Product/Project Manager** *(the bet)* | Know what will land, when, and what's at risk — without reading diffs | Asks Ada | Reads the Gantt and the brief; hands work off directly |
| **The agents** *(first-class users)* | Get unambiguous work; report status; ask for a decision when blocked | Prompted ad hoc, no shared queue | Claim from a queue, report progress, block explicitly |
| **Rafael — Platform/DevEx** | Roll this out safely across an org | — | One GitHub App install, SSO, audit trail |
| **OEM partner** *(v2)* | Resell this to their customers under their brand | — | Own domain, own bot identity, own palette, in a day |

## 1.4 Positioning

> **For engineering leaders running more AI agents than they can personally supervise**, Foreman is a project-management control plane that turns agent activity into a schedule, a status, and a decision queue.
> Unlike agent orchestrators, which stop at a per-developer kanban board, and unlike LLM observability, which reports traces with no notion of a deliverable, Foreman is built for the person accountable for the outcome — and it plugs in over any agent that speaks MCP, using GitHub as the system of record.

**Anti-positioning — what we are deliberately not:**
- Not an agent. We never write code. We schedule, observe, and route.
- Not an IDE or terminal. The agent's home stays where it is.
- Not an evals platform. We surface cost and stall, not model quality.
- Not a new source of truth. GitHub is the truth; we are the lens and the scheduler.

## 1.5 Business model

**Pricing hypothesis** (anchored between Linear at $16/user and observability at $199+/team base):

| Tier | Price | Contents |
|---|---|---|
| **Free** | $0 | 1 project, 3 agent slots, 7-day history. Non-negotiable — every orchestrator competitor is free |
| **Team** | **$39 / human seat / mo** + **$15 / concurrent agent slot / mo** | Unlimited projects, Gantt, briefs, GitHub App, 90-day history |
| **Business** | $79 / seat + $15 / slot | SSO, audit export, custom SLAs, RLS-siloed data, unlimited history |
| **OEM / White-label** | **Fixed fee per branded instance + revenue share** | Own GitHub App identity, custom domain, full theming, reseller rights |

**Why the hybrid meter.** Foreman is a copilot for a human (who logs in daily → per-seat works) sitting over agents (which never log in → per-seat breaks). Salesforce's Agentforce ran three pricing models in eighteen months before landing on per-user licences sold on predictability; GitHub moved to AI Credits at $0.01 on 1 June 2026. Action-metering is normalised with buyers. A **per-agent-slot** meter tracks the customer's own scaling and is legible.

⚠️ **Do not meter per-agent-hour or per-token.** Customers already pay $300–400/day for a 10-dev team running 30 parallel Claude Code sessions. A second meter on top of that will be resented. **Better: show them that number and cut it.** Cost visibility is a feature, not a billing line.

## 1.6 Market sizing

- **Gartner**: enterprise AI coding agent market **$9.8–11.0B annualised (run-rate) as of April 2026** — note this is a run-rate, not booked annual revenue; average net productivity gain 19.3%; by 2027 >65% of engineering teams using agentic coding will treat the IDE as optional.
- **Anthropic / Material, *2026 State of AI Agents*** (500+ US technical leaders, surveyed late 2025 — vendor-sponsored, respondents skew Anthropic customers): **86%** of organisations use AI coding agents in production; **42%** trust agents to lead development work with human oversight; only **16%** deploy agents for cross-functional processes spanning teams.
- **Salesforce 2026 Connectivity Benchmark**: enterprises run an average of **12 AI agents**, projected to grow **67% within two years** (≈20); roughly half run in isolation without connecting to other agents.
- **Bear case, stated up front — Futurum 1H 2026**: 71% claim agent deployment but **only 11% of intended agentic use cases reached production.** Our TAM is the 11%, not the 71%.

**The sentence for a deck:** *Gartner sizes enterprise AI coding agents at $9.8–11B annualised (Apr 2026), on an installed base where 86% of organisations already run coding agents in production and enterprises average 12 agents each. We monetise the management layer over that base — the way observability and project management both monetised on top of, not instead of, the tools they watch.*

## 1.7 Success metrics

**North star: Supervised Throughput** — work items completed per week that were *reviewed and merged*, per human supervisor. It rewards exactly what the industry data says is broken, and it cannot be gamed by generating more PRs.

| Layer | Metric | v1 target |
|---|---|---|
| Activation | Time from GitHub App install → first agent event | **< 10 min** |
| Activation | Fleets reaching 3+ connected agents in week 1 | 50% |
| Engagement | Weekly active supervisors / paid seats | 70% |
| Value | Median time-to-detect a stalled agent | **< 5 min** (vs. hours today) |
| Value | Reduction in "merged with no review" rate, 60 days post-install | −25% |
| Value | Brief open rate | 60% |
| Retention | Net revenue retention | >110% |

---

# Part II — Product Requirements

Requirement IDs are stable. `MUST` / `SHOULD` / `MAY` per RFC 2119. Every requirement has an acceptance criterion written to be verifiable by a test, because Part II is a build brief.

## 2.0 Architecture in one picture

```
        ┌──────────────── Foreman Control Plane (multi-tenant) ─────────────────┐
        │                                                                        │
 agents │   MCP Server        Event Ingest        Scheduler        Projector      │
 ──────►│   (foreman-mcp)  ◄──  (hooks/OTel)  ──►  (queue,      ──► (Gantt, over- │
 (MCP)  │   claim/report/       normalise           priority,       view, life-   │
        │   block/handoff       to WorkEvent        WIP, SLA)       cycle, brief) │
        │        │                   │                  │                │        │
        │        └───────────────────┴──────────────────┴────────────────┘        │
        │                              Event Store (append-only)                   │
        │                                       │                                  │
        │                          GitHub Sync (App, 2-way)                        │
        └───────────────────────────────────────┼──────────────────────────────────┘
                                                ▼
                    Issues · Sub-issues · Dependencies · Projects v2 · Checks · PRs
```

**One rule governs the whole system: every surface is a projection of one append-only event stream.** The Gantt, the agent view, the overview doc, the lifecycle map and the brief are all reads over the same log. No surface holds private state. This is what makes the overview "actively update based on completed tasks" without a synchronisation nightmare.

## 2.1 Universal agent interface (the wrapper)

The wrapper is an **MCP server**. Agents connect to it as clients. This inverts the usual orchestrator design — we do not launch or contain agents, they attach to us — and it is what makes the product universal, including for local agents we have never heard of.

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **AGT-1** | Foreman MUST expose an MCP server over Streamable HTTP implementing the `2026-07-28` revision, and MUST negotiate down to `2025-06-18` and `2025-11-25` clients | A conformance suite connects as each revision and completes claim→report→complete |
| **AGT-2** | Foreman MUST implement the `io.modelcontextprotocol/tasks` extension so `work.claim` and `work.checkpoint` can return `CreateTaskResult` and be polled via `tasks/get` | An agent calls `work.claim` on an empty queue, receives a `working` task, polls, and receives the assignment when a PM enqueues one |
| **AGT-3** | An agent MUST be able to register itself in one call, declaring capabilities, and receive a stable `agent_id` | `agent.announce` returns an id; the agent appears in the Agent View within 2s |
| **AGT-4** | Foreman MUST support agents that cannot or will not call tools, via passive telemetry ingest (Claude Code hooks, OTel, log shipper) | A Claude Code session with only the hooks plugin installed produces a live Agent View row with current tool call |
| **AGT-5** | When an agent is blocked on a human decision, it MUST be able to surface that as a first-class state that pages the PM, using MRTR `input_required` where the client supports it and a polled task otherwise | `work.checkpoint` → PM sees a decision card → PM answers → agent's `tasks/get` returns the answer |
| **AGT-6** | Agent-to-agent communication MUST be recorded as edges, so the Agent View can show "whom they communicate to" | Parent→subagent spawn and peer message both produce a `comm` edge rendered in the fleet graph |
| **AGT-7** | Foreman MUST NOT require the agent to run inside Foreman-managed infrastructure | A local Ollama agent on a laptop with an MCP client appears in the fleet with no Foreman code on that machine |
| **AGT-8** | Task IDs MUST be unguessable bearer tokens with sufficient entropy, per the MCP tasks extension | Static analysis + test asserts ≥128 bits from a CSPRNG |

⚠️ **Spec risk to track.** The `2026-07-28` release notes describe the tasks extension as polling-based (`tasks/get`, `tasks/update`, opt-in `subscriptions/listen`), while the tasks SEP text references protocol version `2026-06-30`. Pin against the published schema at implementation time and re-verify; do not build from these notes alone. Note also that **Roots, Sampling and Logging are deprecated** with a 12-month minimum window — do not depend on them.

## 2.2 Handoff queue

The PM's primary write surface, and the answer to the task-supply problem.

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **QUE-1** | A PM MUST be able to create a work item and place it in a project queue in under 30 seconds, with title, intent, acceptance criteria, priority and optional repo/branch | Timed usability test, 5 users, median < 30s |
| **QUE-2** | The queue MUST be strictly priority-ordered with a stable tiebreak (priority desc, then enqueued_at asc) | Property test: enqueue order is deterministic under concurrent inserts |
| **QUE-3** | Claiming MUST be atomic — exactly one agent receives a given work item | 100 concurrent `work.claim` calls against 10 items yield 10 distinct assignments and 90 empty/queued responses |
| **QUE-4** | A claim MUST carry a lease with a TTL; an expired lease returns the item to the queue and records a `lease_expired` event | Agent claims, goes silent past TTL, item reappears at its original priority |
| **QUE-5** | Foreman MUST enforce per-project and per-agent **WIP limits**, refusing claims above the limit | Claim beyond WIP returns a typed `wip_limit_exceeded` error, not a silent no-op |
| **QUE-6** | Work items MUST support blocking dependencies, and a blocked item MUST NOT be claimable | Item B `blocked_by` A is invisible to `work.claim` until A completes |
| **QUE-7** | Every queue item MUST have an acceptance criteria field, and completion MUST record whether they were met | Completing without an acceptance verdict is rejected |
| **QUE-8** | A PM MUST be able to re-prioritise, cancel, or reassign an in-flight item, and cancellation MUST propagate as an MCP `tasks/cancel` | Cancel from UI → agent's next poll returns `cancelled` |

**QUE-7 is the most important requirement in this document.** The Faros data says the failure is unreviewed work, not unwritten work. A queue that does not force a definition of done just makes the problem faster.

## 2.3 Gantt on scrum principles

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **GNT-1** | The timeline MUST render sprints from GitHub Projects v2 **iteration fields**, using `startDate` + `duration` and both `iterations` and `completedIterations` | A project with a configured iteration field renders the same sprint boundaries as GitHub's Roadmap view |
| **GNT-2** | Bars MUST be positioned from a configurable start-field and target-field, each of which MAY be a date field or an iteration field — mirroring GitHub's Roadmap field-selection model | Changing the field mapping in Foreman and in GitHub produces identical bars |
| **GNT-3** | Dependency arrows MUST be sourced from GitHub **issue dependencies** (`blocked_by` / `blocking`) | Adding a dependency in GitHub appears as an arrow within one webhook round-trip |
| **GNT-4** | Hierarchy MUST be sourced from GitHub **sub-issues** — epic → story → task — supporting cross-repo children | A parent in repo A with a child in repo B renders as one collapsible group |
| **GNT-5** | The critical path MUST be computed and visually distinguished, and MUST update on every relevant event | Golden-file test over a fixture DAG; recompute latency < 500ms at 2,000 items |
| **GNT-6** | Bars MUST show live agent state — in progress / blocked / awaiting review / stalled — not just planned dates | An agent going silent past its stall threshold turns its bar amber within 5 minutes |
| **GNT-7** | The Gantt MUST render a **forecast** band: projected completion from the current queue, WIP, and observed throughput, with an explicit confidence interval | Forecast is reproducible from the event log and labelled with its method and inputs |
| **GNT-8** | Editing a bar (dates, sprint) MUST write back to GitHub | Drag a bar → `updateProjectV2ItemFieldValue` → GitHub reflects it, and the change is idempotent under webhook echo |
| **GNT-9** | The Gantt MUST remain usable at 2,000 work items | Virtualised rendering; interaction stays at 60fps in a scripted scroll test |

**Design note.** Deriving sprints from Projects v2 iteration fields is the single highest-leverage decision here: `startDate + duration` *is* a Gantt row, `completedIterations + iterations` *is* the time axis, and because it mirrors GitHub's own Roadmap model, customers keep both views without reconciling them.

⚠️ **Permission trap:** Projects v2 is **GraphQL-only** and requires **organization** project permissions — repository project permission is explicitly insufficient. User-owned (non-org) projects are unreachable from an org installation; design for that.

## 2.4 Agent view

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **AVW-1** | For each agent, display: identity, platform, model, status, current work item, current tool call, elapsed time, tokens and cost this run, session link | Fields populate for a Claude Code agent within 2s of the hook firing |
| **AVW-2** | Show the **communication graph** — parent/subagent edges and peer messages — as a live view | Spawning a subagent renders a new node and edge within 2s |
| **AVW-3** | **Stall detection**: an agent MUST be flagged when it exceeds a per-project threshold with no state transition, or exhibits repeated identical tool calls | Loop fixture (same tool call ×5) raises `agent.stalled` within the threshold |
| **AVW-4** | Cost and token burn MUST be aggregated per agent, per work item, per project, per day | Sum over the event log equals the SDK-reported `total_cost_usd` within 1% |
| **AVW-5** | The PM MUST be able to act on an agent from this view: pause, cancel, re-prioritise, send a message, request a checkpoint | Each action produces an event and a visible agent-side effect (or a typed "unsupported by this agent" response) |
| **AVW-6** | Sensitive content MUST be redactable per tenant — tool inputs, file paths, prompt text — with a default of **metadata only** | With default settings, no prompt text is persisted; enabling capture is an explicit, audited tenant action |
| **AVW-7** | The view MUST degrade gracefully by integration depth, showing clearly which fields are unavailable for a given agent | A telemetry-only agent shows current tool call but greys out "current work item" with a reason |

**AVW-3 is the differentiator against observability tools.** Their own comparative literature concedes that *"an agent stuck in a loop looks like an agent doing work."* Detecting that in under five minutes is a claim no trace tool makes.

## 2.5 Living project overview

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **OVW-1** | Foreman MUST maintain a generated document describing the project's current structure: components, data model, external interfaces, and shipped features | Present and non-empty within 10 minutes of first repo sync |
| **OVW-2** | It MUST regenerate on completion of a work item, and MUST be **versioned with a readable diff** between versions | Completing an item produces v(n+1) and a diff naming what changed and which item caused it |
| **OVW-3** | Every claim in the document MUST be traceable to evidence — a file, a commit, a merged PR, or a completed work item | Each section carries provenance links; a "citation coverage" check gates publication |
| **OVW-4** | Generation MUST be incremental, not a full rewrite, so history stays reviewable and cost stays bounded | Cost per regeneration is sublinear in project size; measured on a 50k-LOC fixture |
| **OVW-5** | A human MUST be able to pin, correct, or override any section, and overrides MUST survive regeneration | An edited section persists across three regenerations and is marked human-authored |
| **OVW-6** | New features detected in merged work MUST be added to a "recently shipped" section automatically | Merge a feature PR → it appears with a link, within one sync cycle |

## 2.6 Lifecycle view (API-endpoint driven)

The notes ask for "overview of the life cycle of the app being built (through api endpoints)". This is a genuinely novel view and worth building deliberately: progress measured in **capability**, not commits.

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **LFC-1** | Foreman MUST discover the app's API surface from the repo — OpenAPI/AsyncAPI specs first, then framework route introspection (Express, FastAPI, Next.js route handlers, Rails, Django, Spring) | ≥90% endpoint recall on a fixture set of five repos, one per framework |
| **LFC-2** | Each endpoint MUST carry a lifecycle state: `planned → stubbed → implemented → tested → deployed → deprecated` | State transitions are derived from evidence (spec entry, handler body, test reference, deploy event) and each is auditable |
| **LFC-3** | Endpoints MUST be linkable to the work items and agents that produced them | Click an endpoint → see its work items, PRs and agent runs |
| **LFC-4** | The view MUST show coverage gaps: endpoints with no tests, specs with no implementation, implementations with no spec | Fixture repo with a known gap surfaces exactly that gap |
| **LFC-5** | Where a deployment signal exists (GitHub Deployments, check runs, or a configured webhook), the deployed state MUST reflect it | A successful deployment moves affected endpoints to `deployed` |

## 2.7 Brief and the human↔fleet portal

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **BRF-1** | Foreman MUST generate a daily and a weekly brief per project, on a tenant-configured schedule and timezone | Fires within ±2 minutes of schedule; timezone-correct across DST |
| **BRF-2** | The brief MUST contain: shipped, in flight, **blocked and why**, **decisions needed from you**, cost, forecast change since last brief, and risks | Schema-validated; each section either has content or an explicit "nothing here" |
| **BRF-3** | Every brief item MUST link to its evidence | Zero unlinked claims — enforced at generation |
| **BRF-4** | Delivery MUST support email and webhook in v1; Slack in v1.1 | Delivered and rendered correctly in Gmail, Outlook and a plain webhook consumer |
| **BRF-5** | The brief MUST be **actionable in place**: answering a decision from the brief MUST unblock the waiting agent | Click a decision → answer → the blocked agent resumes on its next poll |
| **BRF-6** | The PM MUST be able to send a directive to a specific agent, a project, or the whole fleet, and see delivery status | Message shows delivered / acknowledged / unsupported per target |
| **BRF-7** | Briefs MUST be generated from the event log, and MUST be reproducible for any past date | Regenerating yesterday's brief produces byte-identical content |

## 2.8 GitHub App integration

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **GHA-1** | Foreman MUST ship as a GitHub App requesting the minimum viable permission set: `metadata:read`, `issues:write`, `pull_requests:write`, `contents:read` (write only when writing), `checks:write`, `organization_projects:write`, `actions:write` (optional, for dispatch) | Permission manifest matches the list; each permission is justified in code comments and in the install screen copy |
| **GHA-2** | Webhook receipt MUST verify `X-Hub-Signature-256` (HMAC-SHA256 over the **raw** body) in constant time, and MUST dedupe on `X-GitHub-Delivery` | Tampered payload rejected; replayed delivery is a no-op |
| **GHA-3** | Sync MUST be **webhook-first**, with reconciliation polling as a bounded fallback | Steady-state polling is zero; reconciliation runs on a schedule and on webhook gap detection |
| **GHA-4** | Work items MUST map 1:1 to GitHub Issues; hierarchy to sub-issues; dependencies to issue dependencies; scheduling to Projects v2 fields | Round-trip test: create in Foreman → exists in GitHub → edit in GitHub → matches in Foreman |
| **GHA-5** | Agent runs MUST surface as **check runs** on the relevant commit/PR, with `actions` buttons for control | Check run appears with ≤3 buttons; `requested_action` webhook routes to the right handler |
| **GHA-6** | Installation tokens MUST be cached with their 1-hour expiry, minted per installation, scoped down where possible | Token cache respects expiry; no token outlives 60 minutes; ≤500 repos per scoped token |
| **GHA-7** | Rate limiting MUST be handled with per-installation budgets, respecting `x-ratelimit-*`, the 100-concurrent secondary limit, and GraphQL's 2,000 points/min | Load test at 2× expected peak triggers backpressure, never a 403 storm |
| **GHA-8** | Foreman MUST handle `installation`, `installation_repositories`, suspension and uninstall lifecycle events, including data retention on uninstall | Uninstall → tenant marked suspended, data retained per policy, no orphaned webhooks |
| **GHA-9** | Where a tenant enables it, Foreman SHOULD dispatch agent runs into the customer's own repo via `workflow_dispatch` or `repository_dispatch` | Dispatch returns a `workflow_run_id`; the run is linked to the work item |

**Two facts worth designing around:**
1. **Only GitHub Apps can write check runs.** OAuth apps and users cannot. This is a structural reason to be an App.
2. **Events triggered by `GITHUB_TOKEN` do not start new workflow runs — but events from an App installation token do.** Our writes can cascade into customer CI where a plain Actions bot's cannot.

⚠️ **If we ever want to dispatch GitHub's own Copilot coding agent as a backend**, note that the agent-tasks API supports **user-to-server tokens only** — installation tokens are not accepted. That requires a dual-token architecture (installation token for the backbone, refreshable user token for delegation). Defer to v2 and treat the GraphQL assignment path as unstable — it is still behind a `GraphQL-Features` header.

## 2.9 White-label

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **WL-1** | Every brand-affecting value MUST be tenant configuration, never code: name, wordmark, favicon, colour tokens, type scale, radius, email sender, support URL, legal links | Grep test: zero hard-coded brand strings or hex values outside the token layer |
| **WL-2** | Theming MUST use **design tokens** exposed as CSS custom properties, and tenants MUST be constrained to token values rather than arbitrary CSS | A tenant theme is a validated JSON document; invalid tokens are rejected at save |
| **WL-3** | Every tenant theme MUST pass **WCAG AA contrast** automatically; failing themes MUST be rejected at save with the offending pair named | Automated contrast check over all foreground/background pairs in both light and dark |
| **WL-4** | Custom domains MUST be supported with automatic TLS via Cloudflare for SaaS | `pm.acme.com` serves the tenant with a valid cert, end to end, unattended |
| **WL-5** | Tenants on shared subdomains MUST be protected from cookie-scope attacks: session cookies use the `__Host-` prefix, `Secure; HttpOnly; Path=/`, **no `Domain` attribute**, plus Origin validation and CSRF tokens; the shared apex SHOULD be submitted to the Public Suffix List and the admin console SHOULD live on a different apex | Security test asserts a tenant page cannot set a cookie readable by another tenant or by the console |
| **WL-6** | The **GitHub bot identity** MUST be white-labelable via the GitHub App Manifest flow, so a partner's customers see `acme-foreman[bot]` | Partner completes the flow, credentials (`id`, `pem`, `webhook_secret`) are captured, and the resulting App works end to end. ⚠️ Verify whether `client_id`/`client_secret` are returned by the conversion endpoint — the docs describe `id`, `pem`, `webhook_secret`; if OAuth is needed, plan a manual step |
| **WL-7** | Tenant isolation MUST be pooled-with-RLS by default and siloed for Business/OEM tiers (the **bridge** model), with the tenant boundary being the **organisation, not the user** | Every tenant-scoped table has RLS enabled and FKs to `organisations(id)`; a migration test fails the build if any table lacks a policy |
| **WL-8** | The control plane (provisioning, billing, tenant registry) MUST be separated from the application plane, with provisioning permissions unreachable from tenant-facing code | Architecture test: no application-plane service holds a provisioning credential |
| **WL-9** | Usage MUST be metered in the platform and priced elsewhere, so OEM partners can apply their own pricing | Metering emits a neutral usage record; pricing is a separate, replaceable service |
| **WL-10** | An OEM partner MUST be able to stand up a fully branded instance in **under one day** without our engineering involvement | Timed run-through by someone outside the team |

⚠️ **Cloudflare for SaaS operational limits:** 100 custom hostnames included on every plan (Enterprise included), $0.10/hostname/month beyond, pay-as-you-go cap 50,000; **15 cert issuances per minute then a 30-second lockout**; hostnames over 64 characters require `cloudflare_branding: true`; **certificate webhooks are Enterprise-only**, so plan to poll status on lower plans. Prefer **TXT DCV** or **Delegated DCV** over HTTP DCV — HTTP DCV races DNS cutover and cannot do wildcards.

## 2.10 Cross-cutting requirements

| ID | Requirement | Acceptance criterion |
|---|---|---|
| **X-1** | All state changes MUST be recorded as immutable events in an append-only store; all views MUST be projections | Replaying the log from zero reproduces every current view exactly |
| **X-2** | All ingest endpoints MUST be idempotent on a caller-supplied key | Duplicate delivery of any event is a no-op |
| **X-3** | Default data capture MUST be **metadata only**. Prompt text, tool inputs and file contents are opt-in per tenant and audited | Fresh tenant produces zero prompt text in storage |
| **X-4** | Tenants MUST be able to export everything and delete everything | Export produces a complete archive; deletion is verified by a scan |
| **X-5** | Foreman MUST NOT have write access to customer source code by default | `contents:write` is off unless a tenant explicitly enables a feature needing it, and the install screen says so |
| **X-6** | Agent-supplied content is **untrusted input**. It MUST never be interpreted as instructions by Foreman's own generation steps (overview, brief) | Prompt-injection fixture in an agent status message does not alter brief content or trigger any action |
| **X-7** | p95 event-ingest to UI latency MUST be under 2 seconds at 100 concurrent agents per tenant | Load test |
| **X-8** | Every automated action MUST be attributable and reversible, with a full audit log | Audit export shows actor, action, before/after for every mutation |

**X-6 deserves emphasis.** We ingest text written by agents and render it to a human who then makes decisions, and we feed it to an LLM that writes the overview and the brief. That is a prompt-injection surface with real consequences. Treat all agent output as data, never as instruction, and say so in the code.

---

# Part III — Scope and Roadmap

## v1 — "See the fleet" (target: 10 weeks)

The bet: visibility alone is worth paying for, because nobody has it.

**In:** MCP server with claim/report/block/complete · Claude Code hooks plugin for passive telemetry · Agent View with stall detection · Handoff queue with atomic claim, leases and WIP limits · GitHub App with two-way issue sync, sub-issue hierarchy and check runs · Gantt from Projects v2 iterations with dependency arrows · daily brief by email · single-tenant-per-org pooled RLS · one brand (ours).

**Out:** white-label, custom domains, lifecycle view, forecasting, Slack, non-GitHub backends, non-MCP agents.

**Ship gate:** three design-partner teams run ≥10 concurrent agents through it for two weeks and the median time-to-detect a stalled agent is under five minutes.

## v1.1 — "Understand the project" (+6 weeks)

Living project overview with versioned diffs · lifecycle/API view · weekly brief · Slack delivery · forecast band on the Gantt · actionable decisions in the brief.

## v2 — "Sell it as yours" (+8 weeks)

Full theming with token validation and contrast gating · custom domains via Cloudflare for SaaS · GitHub App Manifest flow for partner-owned bot identity · siloed tier · OEM metering and billing separation · partner admin console.

## v3 — "Beyond GitHub, beyond Claude"

GitLab and Linear backbones behind the same `Backbone` interface · Agent Client Protocol adapter (Devin/Codex/OpenCode) · local-agent quickstart (Ollama/LM Studio + MCP client) · Copilot coding agent as a dispatchable backend, with the dual-token architecture.

## Explicit non-goals

Writing code · being an IDE · model evaluation · being the agent runtime · replacing GitHub as source of truth · supporting agents that cannot emit any telemetry at all.

---

# Part IV — Open Questions

These need answers before or during v1. Each has an owner and a decision deadline.

| # | Question | Why it matters | Proposed resolution |
|---|---|---|---|
| 1 | **Does the PM persona exist?** | The entire positioning rests on it | 15 discovery interviews with EMs and PMs at teams running ≥5 agents, before v1.1 scope lock. Ship v1 to tech leads regardless |
| 2 | **Did Vibe Kanban have paying teams?** *(Partially answered: it shut down because parent company Bloop wound down, not from a stated product failure.)* | Closest positioned competitor, dead in 8 months. Whether it had revenue distinguishes "bad luck" from "no willingness to pay" | Read the shutdown post and repo issues, contact the maintainers directly. One week, before build starts |
| 3 | **Is the unit of value the team or the individual?** | Determines pricing shape and whether the Gantt is even the right hero surface | Instrument v1 to measure agents-per-supervisor and supervisors-per-tenant |
| 4 | **Issue fields vs Projects v2 fields as the canonical home for agent metadata?** | Issue fields travel with the issue; project fields are per-board | Prototype both in week 1. Lean issue fields for anything that should outlive a board |
| 5 | **How much prompt/tool content do customers actually want captured?** | Drives the entire privacy and storage design | Default metadata-only, measure opt-in rate |
| 6 | **Do we ever launch agents ourselves?** | v1 says no — agents attach to us. But "plug and play" may imply provisioning | Hold the line on v1. Revisit only if attach friction proves fatal |
| 7 | **Is GitHub-only acceptable for v1?** | GitLab-based teams are excluded | Yes for v1, but the `Backbone` interface must be real from day one, not retrofitted |

---

## Sources

**MCP:** [Specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18) · [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/) · [Tasks extension SEP 2663](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2663-tasks-extension.md)

**Claude platform:** [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) · [Hooks reference](https://code.claude.com/docs/en/hooks) · [Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage) · [Observability with OpenTelemetry](https://code.claude.com/docs/en/agent-sdk/observability) · [Plugins reference](https://code.claude.com/docs/en/plugins-reference) · [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) · [Headless mode](https://code.claude.com/docs/en/headless)

**GitHub:** [Authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) · [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) · [GraphQL rate & node limits](https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api) · [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) · [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) · [Projects v2 GraphQL reference](https://docs.github.com/en/graphql/reference/projects) · [Automating projects with the API](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) · [Roadmap layout](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-roadmap-layout) · [Check runs](https://docs.github.com/en/rest/checks/runs) · [Sub-issues](https://docs.github.com/en/rest/issues/sub-issues) · [Issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies) · [Registering an App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) · [Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent) · [Agent tasks API](https://docs.github.com/en/rest/agent-tasks/agent-tasks)

**Market:** [Faros AI, The Acceleration Whiplash (Apr 2026)](https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways) · [Faros full report PDF](https://pages.faros.ai/hubfs/AI_Engineering_Report_2026_The_Acceleration_Whiplash_Faros.pdf) · [LinearB 2026 benchmarks](https://linearb.io/dev-interrupted/podcast/linearb-2026-benchmarks-ai-pr-merge-rate) · [Vibe Kanban shutdown post (10 Apr 2026)](https://www.vibekanban.com/blog/shutdown) · [Salesforce 2026 Connectivity Benchmark](https://www.salesforce.com/news/stories/connectivity-report-announcement-2026/) · [Addy Osmani, Your AI coding agents need a manager (Jan 2026)](https://addyosmani.com/blog/coding-agents-manager/) · [Addy Osmani, The Code Agent Orchestra (Mar 2026)](https://addyosmani.com/blog/code-agent-orchestra/) · [Superset, parallel agents guide (Feb 2026)](https://superset.sh/blog/parallel-coding-agents-guide) · [Gartner enterprise AI coding agent market](https://www.gartner.com/en/articles/enterprise-ai-coding-agent-market) · [Anthropic, 2026 State of AI Agents](https://resources.anthropic.com/hubfs/The%202026%20State%20of%20AI%20Agents%20Report.pdf) · [Linear agents documentation](https://linear.app/docs/agents-in-linear) · [Atlassian, AI agents in Jira (Feb 2026)](https://www.atlassian.com/blog/rovo/ai-agents-in-jira) · [Devin Desktop](https://devin.ai/desktop) · [Vibe Kanban](https://www.vibekanban.com/) · [OTel GenAI semconv stability (Jul 2026)](https://dev.to/azena-ai/opentelemetrys-genai-semantic-conventions-are-not-stable-yet-heres-what-actually-shipped-in-2026-3mke) · [CloudZero, Claude Code parallel session cost (May 2026)](https://www.cloudzero.com/blog/claude-code-agents/)

**Multi-tenancy & white-label:** [Cloudflare for SaaS reference architecture](https://developers.cloudflare.com/reference-architecture/design-guides/leveraging-cloudflare-for-your-saas-applications/) · [Vercel multi-tenant domains](https://vercel.com/docs/platforms/multi-tenant-platforms/configuring-domains) · [AWS, multi-tenant isolation with Postgres RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security)
