# Why Vibe Kanban sunset — and what Foreman should take from it

*SPEC §11 item 10. Researched 31-08-2026.*

## The record

**The spec's premise was correct.** On **10 April 2026**, Louis Knight-Webb announced the shutdown
of bloop (YC-backed) and with it the commercial life of Vibe Kanban, the kanban-style orchestrator
for AI coding agents (Claude Code, Gemini CLI, Codex, etc.) launched in **June 2025**.

The stated facts:

- **Usage was real, revenue was not.** "Thousands of software engineers use Vibe Kanban every
  day," but the vast majority were free users; the team "couldn't find a business model that it
  could get excited about."
- **The thesis was ours too.** Knight-Webb's diagnosis — as coding automates, engineers' time
  shifts to *planning and review* — is precisely the PRD's opening argument. The market thesis
  did not fail; the monetization of it did.
- **The product outlived the company.** Cloud services (shared boards, comments, orgs) ran 30
  more days then shut off; the local-first core went **Apache 2.0, community-maintained**, with a
  data-export release shipped on the way out. Releases have since slowed; no commercial support.
- Post-mortem commentary (Agiflow) frames it as **category-timing + conversion failure, not
  product failure**: real demand for "durable project state outside chat transcripts," but no
  settled answer to *which layer gets monetized* — board, IDE companion, or workflow — and a
  free local tool trains users that the category costs nothing.

## Five lessons, mapped onto Foreman decisions

1. **Don't sell the board; sell the accountability layer.** Vibe Kanban monetized nothing because
   its free local core *was* the product. Foreman's paid surface must be what a local tool cannot
   do: multi-tenant fleet visibility, briefs with delivery, audit-grade event history, white-label
   (PRD §1.5's tiers). **Validates**: keeping the event log + RLS + WL-* machinery central rather
   than shipping a fancier local board. **Challenges**: any roadmap idea that leads with a free
   local-first client.

2. **Free telemetry, paid coordination.** The ten-second hooks-plugin onboarding (our activation
   metric) mirrors what made Vibe Kanban spread — and what made it unmonetizable when everything
   stayed free. The claim queue, directives, checkpoints and briefs are the coordination layer
   worth gating; passive visibility is the top of the funnel, not the product.

3. **Survive the platform's gravity.** Vibe Kanban orchestrated agents through their CLIs; every
   agent vendor is now absorbing orchestration (subagents, tasks, teams). Foreman's defensibility
   argument (PRD §"three things that make it defensible") — the *cross-vendor* event log, the
   GitHub-native backbone, and the PM-shaped views (Gantt/critical path/brief) — is exactly the
   ground a CLI-orchestration layer never held. **Validates** the Backbone seam and the
   protocol-conformant MCP tasks surface over any bespoke agent-driving.

4. **Cloud shutoffs are the trust killer — architect for export from day one.** Their 30-day
   cloud wind-down killed shared state; the goodwill move was data export. Foreman's append-only
   event log *is* the export story — but we should make that explicit for design partners: a
   documented "your events, your Postgres, replayable projections" posture is a sales asset
   against the category's shutdown-scarred memory. **Action**: add an export/backup section to
   the quickstart when partner-facing.

5. **Being early looks identical to being wrong — instrument the difference.** The Agiflow
   post-mortem's sharpest point: conversion and retention are the only signals separating
   category-timing failure from product failure. Foreman's PRD success metrics (§1.7) should be
   tracked from the first design partner (time-to-detect-stall, weekly active supervisors,
   brief-open rate), not after a pricing page exists.

## Sources

- Goodbye bloop (shutdown announcement, Louis Knight-Webb, 2026-04-10): https://www.vibekanban.com/blog/shutdown
- Agiflow, "Building before the market is ready" (post-mortem analysis): https://agiflow.io/blog/building-before-the-market-is-ready
- BigGo Finance coverage: https://finance.biggo.com/news/59670028d308ba97
- Community-transition explainers (Nimbalyst): https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/

*Accessed 31-08-2026. Claims not found in these sources are marked as commentary above.*
