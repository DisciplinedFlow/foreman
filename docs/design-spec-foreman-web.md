# Foreman — Web UI Design Spec

A brief for redesigning / mocking up the Foreman web app. Every screen, what it does,
what it shows, the controls on it, and its empty/loading/error states. Pair this with the
screenshots already captured.

---

## 1. Product in one paragraph

**Foreman is a project-management control plane for fleets of AI coding agents.** An engineering
lead who is running more agents than they can personally watch uses it to see what every agent is
doing, what's blocked, what needs a human decision, and whether reviewed-and-merged work is actually
flowing. It connects to a team's GitHub (two-way issue sync, a Gantt from GitHub Projects, PR/review
signals) and to the agents themselves (Claude Code hooks + an MCP server). The hero surfaces are the
**Gantt schedule**, the **Agents live table**, and the **Metrics** readout — not a marketing site,
a working operator dashboard.

**Audience:** technical operators (eng leads, staff engineers). Dense, data-first, glanceable.
Think Linear / Vercel dashboard / the Insighta reference, not a consumer landing page.

---

## 2. Design language (current direction — evolve or replace freely)

The app currently ships a hand-built, theme-aware token system. Treat this as the starting point.

- **Aesthetic:** premium dark analytics dashboard, Apple-grade craft (hairline separators, soft
  cards, generous-but-efficient spacing, tabular figures), with a **violet** brand accent. Fully
  theme-aware: a **premium dark** mode (default in the screenshots) and a clean **light** mode.
- **Accent (one, locked):** violet. `#6d47ff` (light) / `#8b6dff` (dark). Gradient for highlight
  tiles: `#7c5cff → #9b6bff`. Do **not** introduce a second brand accent.
- **Neutrals (dark):** canvas `#0c0c0f`, card surface `#161619`, elevated `#1e1e24`, control fill
  `#232329`. Text `#f5f5f7` / secondary `#a1a1a6` / tertiary `#8e8e93`. Hairlines are translucent
  white at 7–12%.
- **Neutrals (light):** canvas `#f5f5f7`, card `#ffffff`, fill `#ececef`. Text `#1d1d1f` /
  `#6e6e73` / `#8e8e93`.
- **Semantic (state only, not brand):** success green `#34a853`/`#30d158`, warning amber
  `#b26a00`/`#ffd60a`, danger red `#e0402f`/`#ff453a`. Used for status dots, delta pills, alerts.
- **Type:** system UI stack (SF Pro on Apple devices). Tight tracking on large numbers/headings.
  **All numeric/data columns use tabular figures.** Weights: 400 body, 500 medium, 600 headings.
- **Radii:** 6px inner, 9px controls, 13px cards, 20px large panels, full-pill for primary buttons.
- **Elevation:** soft, cool-tinted shadows; cards are surface + 1px hairline + a whisper of shadow.
- **Motion:** restrained. 0.2s ease on hover/press; `scale(0.97)` press feedback; skeleton shimmer
  for loading. Honors reduced-motion.

### Component vocabulary (already in use — keep or restyle)

| Component | What it is |
|---|---|
| **Top bar** | Frosted, sticky, 54px. Back link + current title (+ future: search / notifications / avatar like the Insighta reference). |
| **Segmented control** | The tab bar. A pill group; the active tab is an elevated pill. |
| **Card** | Surface + hairline + soft shadow, 13px radius. The base container for every section. |
| **Stat tile** | Label (small, secondary) → big tabular value → optional sub-line or delta pill. |
| **Delta pill** | Rounded pill, green ▲ / red ▼, e.g. `▲ +2 wk`. |
| **Badge** | Small rounded label for status/metadata (e.g. `v3`, `Pinned`, `revoked`, `GitHub connected`). |
| **Status dot** | 8px colored dot for agent/endpoint state. |
| **Chip** | Monospace pill for provenance/evidence refs (e.g. `impl: src/server.ts`). |
| **Highlight card** | Violet-gradient tile with white text — for a hero insight (see Insighta's "Insights" tile). |
| **Empty state** | Centered title + one line + (optional) action. Shown when a list/graph has no data. |
| **Skeleton** | Shimmer blocks matching final layout, for loading. |
| **Alert** | Inline tinted box (danger for errors, amber for decisions, violet for the minted-token notice). |
| **Buttons** | Primary = filled violet pill. Default = subtle fill. Ghost = transparent + accent text. Danger = outline + red. |

---

## 3. Sitemap

```
/login                     → Login
/                          → Projects (list of orgs → projects)
/projects/:id              → Project workspace (7 tabs)
      ├── Gantt        (default)
      ├── Agents
      ├── Graph        (agent communication)
      ├── Overview     (living project overview)
      ├── Lifecycle    (API endpoint lifecycle)
      ├── Metrics
      └── Settings     (Integrations · GitHub · Queue · Brief · Tokens · Data)
```

A **Decision-needed banner** can appear above the tabs on any project screen (see §5).

---

## 4. Screens

### 4.1 Login

- **Purpose:** sign in to a workspace. (Dev mode: email only, no password. A real IdP is future work — design for an email field now, but leave room for SSO buttons.)
- **Layout:** a single centered card on the canvas. Brand name, a one-line subtitle, an email field
  with a label above it, and a full-width primary button.
- **Controls:** Email input (labeled, placeholder `you@company.com`); **Log in** (primary).
- **States:** default; **error** = an inline alert under the form ("unknown user" / "login failed").
- **Design notes:** the calmest screen. One clear action.

### 4.2 Projects

- **Purpose:** pick a project to work in. Projects are grouped under the organisation(s) the user
  belongs to.
- **Layout:** top bar (brand). A "Projects" heading. For each org: a small uppercase org label, then
  a card containing project rows.
- **Content per row:** project name, an optional badge listing linked GitHub repos, a right chevron.
- **Controls:** each row is a link into the project.
- **States:** **empty** = "No workspaces yet"; an org with no projects shows "No projects."
- **Design notes:** rows over cards-in-a-grid; the org is the grouping. Fast to scan a long list.

### 4.3 Project workspace — shell

Everything below lives inside the project workspace, which provides:

- **Top bar:** `‹ Projects` back link + the project name as the title. (Reference direction: this is
  where a global search, a notifications bell, and an account avatar would live, like Insighta.)
- **Decision-needed banner** (see §5) — appears above the tabs when any agent is waiting on a human.
- **Segmented tab bar:** Gantt · Agents · Graph · Overview · Lifecycle · Metrics · Settings.
- The selected tab's content renders below.

---

### 4.4 Gantt tab (default)

- **Purpose:** the schedule. A dependency-aware timeline of work items, showing the critical path
  and live agent state, built from GitHub Projects v2 iterations. This is the hero surface.
- **Layout:** a `+ New item` button (primary), then the Gantt itself — a virtualized SVG timeline:
  rows are work items, bars are their scheduled start→target, arrows are dependencies, the critical
  path is emphasized. Bars are draggable to reschedule (drag/resize snaps to days; the change writes
  back to GitHub).
- **Content per bar:** title, status (queued / claimed / in progress / blocked / in review / done /
  cancelled / failed), kind (epic / story / task / bug / chore), critical-path flag, slack.
- **Controls:** **+ New item** opens an inline form (Title, Intent, Kind select, Priority number,
  **Create**). Dragging a bar reschedules it. Collapsing parent rows.
- **States:** **empty** = an empty timeline with just the `+ New item` button (this is what a fresh
  project shows — worth designing a friendlier empty state here). Optimistic update on drag; the
  server confirms via a live stream.
- **Design notes:** must stay legible at 2,000 rows. Critical path and agent-touched items should
  pop. Consider a mini-map or a "today" line. The reference's line-chart card is a good stylistic
  cue for the timeline chrome.

### 4.5 Agents tab

- **Purpose:** the live roster of every agent reporting in, with stall detection. Answers "who is
  working, on what, and is anyone stuck?"
- **Layout:** a filter input, then a table inside a card.
- **Columns:** Name · Platform · Model · **Status** (colored status dot + label: working / idle /
  blocked / stalled / offline / error) · Current work item · Last seen (relative, e.g. "3m ago") ·
  Tokens (in/out) · Cost · Session · Actions.
- **Behavior:** sortable headers (Name, Platform, Status, Cost, Last seen); text filter across
  name/platform/status. A **null field renders as an em-dash with a tooltip** ("not reported by this
  integration") — a deliberate "integration-depth gap," never a blank cell.
- **Actions per agent** (a small inline control cluster): **Pause / Resume**, **Message…** (opens an
  inline text field → Send), **Checkpoint…** (ask the agent a question → Send), **Cancel item**
  (when the agent holds a work item). These create "directives" the agent picks up on its next
  heartbeat — offers, not force.
- **States:** **empty** = "No agents connected / Agents report in over MCP and appear here live."
- **Design notes:** this is a dense data table — tabular figures, tight rows, clear status color. The
  status dot is the primary scannable signal. Consider a per-row expand for detail.

### 4.6 Graph tab

- **Purpose:** the communication graph — how agents spawned sub-agents and messaged each other.
- **Layout:** a force-directed node/edge graph (custom SVG). Nodes are agents (labeled, colored by
  status, parent/child relationships), edges are spawns or messages (with counts).
- **States:** **empty** = "No communication yet / Agent spawns and messages will map here."
- **Design notes:** keep it calm and readable, not a hairball. Node = agent chip; edge weight =
  message volume. A legend for edge kinds (spawn vs message).

### 4.7 Overview tab

- **Purpose:** a living, auto-generated project overview — 8 fixed sections regenerated from the
  event log, each with provenance and human override.
- **Layout:** a header row ("Living overview" + a **Regenerate** primary button), then one card per
  section.
- **Sections (fixed set):** Purpose · Architecture · Data model · Interfaces · Recently shipped ·
  In flight · Conventions · Risks.
- **Content per section card:** title + badges (`v{n}`, `Pinned`, `Human-authored`); the section
  body (prose lines); **source chips** (monospace provenance refs); and a control row.
- **Controls per section:** **Edit** (inline textarea → Save / Cancel) · **Pin/Unpin** (pinned
  sections aren't overwritten by regeneration) · **History** (expands a readable diff of the latest
  vs previous revision — green additions, red deletions).
- **States:** **empty** = "No overview yet / Regenerate to build one from the event log."
- **Design notes:** reads like a document, not a dashboard. Cards stacked, comfortable measure
  (~800px). Provenance chips are the trust signal.

### 4.8 Lifecycle tab

- **Purpose:** track each API endpoint's maturity — planned → stubbed → implemented → tested →
  deployed → deprecated — discovered by scanning the connected repos. Progress measured in
  capability, not commits.
- **Layout:** a header row: gap **badges** (`N untested`, `N unimplemented`, `N unspecced`) on the
  left, a **Rescan** button on the right. Then a table inside a card.
- **Columns:** Method · Path · **State** (status dot + label) · Spec (✓/—) · Test (✓/—) · Items
  (count of linked work items). Rows are expandable.
- **Row expand:** shows **evidence chips** (e.g. `impl: src/server.ts`, `test: tests/x.test.ts`) or
  "no evidence recorded."
- **States:** **empty** = "No endpoints discovered / Run a scan to map the repo's lifecycle."
  Rescan shows a "Scan queued…" busy state.
- **Design notes:** a state machine as a table. The state dot color-codes maturity. The gap badges
  are the at-a-glance health line.

### 4.9 Metrics tab

- **Purpose:** the numbers a design partner is judged on (the PRD §1.7 north star). Deterministic,
  windowed.
- **Layout:** a responsive grid of **stat tiles**, then a small method footnote.
- **Tiles:**
  1. **Supervised throughput (wk)** — big number + a **delta pill** (`▲ +2 wk` green / `▼` red) +
     sub-line ("N total completions"). *The hero metric: reviewed-and-merged work per week.*
  2. **Stall detection** — median time-to-detect (e.g. `1.5m`) + sub ("p95 … · N samples, target < 5m"),
     or "—" / "no stalls detected this week."
  3. **Active agents (24h)**
  4. **Open decisions**
  5. **Briefs delivered (7d)** — `delivered / generated`
  6. **Cost (7d)** — `$x.xx` + "prev $y.yy"
  7. **Lease expiries (7d)**
- **Footnote:** names the throughput method ("merged and reviewed" for GitHub-connected projects,
  else "completions with acceptance verdicts").
- **States:** **loading** = a grid of shimmer skeletons matching the tiles.
- **Design notes:** this screen should feel like the Insighta stat row — icon + label + big tabular
  number + delta pill. This is the most reference-aligned surface; consider adding a small sparkline
  or a heatmap tile (like the reference's activity heatmap) for throughput-over-time.

### 4.10 Settings tab

A stack of cards, top to bottom:

1. **Integrations** — connection status badge (green "GitHub connected" / grey "Not connected"), a
   "Your GitHub organisation" field, and a **Connect GitHub** button (→ "Reconnect" once connected)
   that starts the GitHub App manifest flow. A line noting Slack/GitLab/other backends aren't
   available yet. *(This is the main integration entry point — worth strong visual treatment; the
   reference's top-right account/connect controls are a cue.)*
2. **GitHub repositories** — Repositories field (`owner/name`, comma-separated), Installation select
   (populated after connecting), Projects v2 board node id.
3. **Queue** — WIP limit (number), Stall threshold (seconds).
4. **Brief** — Schedule select (off / daily / weekly), Timezone (IANA), Webhook URL, Email. **Save
   settings** (primary) applies the whole form.
5. **Agent tokens** — **Mint token** (shows the raw token **once** in a violet notice, copy-only),
   and a table of existing tokens (id prefix, bound agent, last used, **Revoke** danger button /
   "revoked" badge). Empty = "No tokens yet."
6. **Data** — a link to export the full event log as NDJSON.

- **Design notes:** label-above-input throughout. Group into the 6 cards above. The token notice and
  the Integrations status are the two moments that deserve emphasis.

---

## 5. Decision-needed banner (cross-cutting)

- **Purpose:** the human side of an agent checkpoint. When an agent blocks on a question, a card
  appears above the tabs so the operator can answer without hunting.
- **Per card:** a `Decision needed` badge (amber) + the work-item title; the question; optional
  context; then either **option buttons** (primary, one per choice) or a free-text **Answer** field
  + **Send**. Answering completes the agent's task on its next poll.
- **States:** hidden when there are no open decisions. Multiple decisions stack.
- **Design notes:** amber left-accent card; the most attention-grabbing element on the page when
  present, but calm when absent.

---

## 6. Global states & rules for the designer

- **Theme:** design **both** light and dark; dark is the default shown in the screenshots. One theme
  per view, never a section that flips mode mid-page.
- **Empty / loading / error** are first-class — every list, table, and graph needs an empty state; the
  data tabs need a skeleton; forms show inline errors (never a browser alert).
- **Numbers** are always tabular-figure and right-comparable.
- **One accent** (violet) across everything; semantic colors are for state only.
- **Density:** operator-grade. Comfortable but efficient; this is a cockpit, not a landing page.
- **Accessibility:** visible focus rings, labels on every control, status conveyed by more than color
  (dot + text label), reduced-motion respected.

---

## 7. What's real vs aspirational (so mockups don't over-promise)

- **Real, shipped:** all 7 tabs, the decision banner, GitHub integration (issue sync, PR/review,
  Gantt, lifecycle scan), Claude Code agents (via plugin + MCP), brief delivery, token management,
  export.
- **New but thin:** the Connect GitHub button (just added) — good candidate for a richer "connect"
  flow / wizard in the mockups.
- **Not built (design opportunities, clearly future):** in-app global search, notifications, account
  menu/avatar in the top bar; an in-UI "install the Claude Code plugin" helper; Slack / GitLab /
  Linear / Jira integrations; a multi-project org dashboard; throughput-over-time charts (sparkline /
  heatmap) on Metrics.

---

## 8. Handoff notes

- Screenshots already captured cover: Login, Projects, the project shell + segmented tabs, and the
  Metrics tab (dark). Use them for current-state reference.
- If you produce new screens, the highest-value ones to design are: **Metrics** (make it the
  Insighta-grade hero), the **Gantt empty state**, the **Agents** table, and the **Settings /
  Integrations** connect flow.
- Deliver back as: annotated mockups or a component sheet (tokens + the components in §2). I'll wire
  whatever you return into the existing React + CSS-token system.
