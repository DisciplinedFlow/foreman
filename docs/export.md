# Your events, your Postgres — Foreman's data posture

The AI-agent-tooling category has shutdown-scarred memory (see
[`docs/research/2026-08-31-vibe-kanban.md`](research/2026-08-31-vibe-kanban.md): bloop's cloud
wind-down deleted shared state with 30 days' notice). Foreman is architected so that question
never has teeth.

## The guarantees

1. **The append-only event log is the source of truth.** Everything you see in the UI — Gantt,
   critical path, health, metrics, briefs, overview — is a *projection* of `events`, and every
   projection is replayable from offset 0 (reset the row in `projection_cursors` and the
   projector rebuilds; the overview regenerates deterministically from evidence).
2. **It runs on your Postgres.** Self-hosted deployments own the database outright. `pg_dump`
   is a complete, restorable export at any moment.
3. **Per-project export is one request:**
   ```
   GET /api/projects/{id}/export
   ```
   Streams every event of the project as NDJSON (all columns, id-ordered), RLS-scoped to your
   session. Also linked from the project's Settings tab.
4. **What leaves with you**: the event log (the full history), work items and dependencies,
   briefs (content + delivery record), overview sections *and every revision*, endpoints and
   their evidence, agent and run records. GitHub-side state (issues, Projects fields, check
   runs) already lives in your GitHub org — Foreman synced it there all along.
5. **Secrets stay decryptable by you**: GitHub App keys sealed with `FOREMAN_MASTER_KEY` are
   AES-256-GCM under a key *you* hold; nothing in an export depends on Foreman-side services.

## Restoring / replaying

```sql
-- rebuild all projections from scratch
update projection_cursors set last_event_id = 0;
-- then let foreman-projector and the scheduler's push loop catch up
```

A restored `pg_dump` plus running services is a working Foreman; there is no hidden state in
any other store (Redis holds only TTL caches — echo suppression, token cache, rate windows —
all safely cold-startable).
