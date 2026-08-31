-- One row per GitHub App we can act as (first-party or a WL-6 partner-created App).
-- Columns mirror POST /app-manifests/{code}/conversions (verified 31-08-2026: returns
-- client_id, client_secret, pem, webhook_secret) so the Phase 3 manifest UI is an INSERT.
create table github_apps (
  app_id          bigint primary key,
  organisation_id uuid references organisations(id) on delete cascade,  -- null = shared first-party App
  slug            text not null,
  private_key_pem text not null,
  webhook_secret  text not null,
  client_id       text,
  client_secret   text,
  created_at      timestamptz not null default now()
);

create table github_installations (
  installation_id bigint primary key,
  app_id          bigint not null references github_apps(app_id) on delete cascade,
  organisation_id uuid not null references organisations(id) on delete cascade,
  account_login   text,
  created_at      timestamptz not null default now()
);
create index on github_installations (organisation_id);

-- Global webhook dedupe (GHA-2 step 3). Pre-tenant, so no organisation_id, no RLS.
create table github_deliveries (
  delivery_id text primary key,
  received_at timestamptz not null default now()
);

create table sync_jobs (
  id              bigserial primary key,
  organisation_id uuid not null references organisations(id) on delete cascade,
  installation_id bigint not null,
  delivery_id     text not null,
  event_name      text not null,
  action          text,
  payload         jsonb not null,
  status          text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts        int not null default 0,
  run_after       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index on sync_jobs (status, run_after) where status = 'queued';

create table projection_cursors (
  name          text primary key,
  last_event_id bigint not null default 0,
  updated_at    timestamptz not null default now()
);

-- GNT-5 critical path projection: day-granularity CPM per work item.
create table proj_schedule (
  work_item_id    uuid primary key references work_items(id) on delete cascade,
  organisation_id uuid not null,
  project_id      uuid not null,
  earliest_start  int not null,
  earliest_finish int not null,
  latest_start    int not null,
  latest_finish   int not null,
  slack           int not null,
  critical        boolean not null,
  computed_at     timestamptz not null default now()
);
create index on proj_schedule (project_id);

create table proj_project_health (
  project_id      uuid primary key references projects(id) on delete cascade,
  organisation_id uuid not null,
  has_dep_cycle   boolean not null default false,
  cycle_members   uuid[] not null default '{}',
  computed_at     timestamptz not null default now()
);

alter table work_items add column gh_issue_id bigint;  -- REST database id (sub-issues/deps API needs it)

create or replace function foreman.notify_event() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin perform pg_notify('foreman_events', new.id::text); return new; end $$;
create trigger events_notify after insert on events
  for each row execute function foreman.notify_event();

-- RLS (WL-7): every organisation_id table gets the 0002 policy pattern.
alter table github_apps enable row level security;
create policy github_apps_tenant on github_apps
  using (organisation_id is null or foreman.is_member(organisation_id))
  with check (organisation_id is null or foreman.is_member(organisation_id));
alter table github_installations enable row level security;
create policy github_installations_tenant on github_installations
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table sync_jobs enable row level security;
create policy sync_jobs_tenant on sync_jobs
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table proj_schedule enable row level security;
create policy proj_schedule_tenant on proj_schedule
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table proj_project_health enable row level security;
create policy proj_project_health_tenant on proj_project_health
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));

-- Deviation 2: credentials are service-only, like agent_tokens in 0003.
revoke all on github_apps from foreman_app;
