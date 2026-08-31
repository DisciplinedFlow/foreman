-- Task ids are bearer tokens (AGT-8): random 32B base64url, stored verbatim.
-- Poll-through design (Phase 4 deviation 2): tasks/get on a working claim task
-- attempts the claim inline, so no background completer touches this table.
create table mcp_tasks (
  task_id         text primary key,
  organisation_id uuid not null references organisations(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  kind            text not null check (kind in ('claim','checkpoint')),
  status          text not null default 'working'
    check (status in ('working','input_required','completed','failed','cancelled')),
  checkpoint_id   uuid references checkpoints(id) on delete cascade,
  result          jsonb,
  poll_interval_ms int not null default 2000,
  ttl_ms          bigint,
  created_at      timestamptz not null default now(),
  last_updated_at timestamptz not null default now()
);
create index on mcp_tasks (agent_id, status);

create table briefs (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  content         jsonb not null,
  generated_at    timestamptz not null default now()
);
create index on briefs (project_id, window_end desc);

-- GHA-5: one check run per work item, updated in place (Phase 4 deviation 5).
alter table work_items add column gh_check_run_id bigint;
-- X-3/AVW-6: metadata-only capture unless the tenant explicitly opts in.
alter table organisations add column capture_tool_input boolean not null default false;

-- RLS (WL-7): 0002 policy pattern on every organisation_id table.
alter table mcp_tasks enable row level security;
create policy mcp_tasks_tenant on mcp_tasks
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table briefs enable row level security;
create policy briefs_tenant on briefs
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
