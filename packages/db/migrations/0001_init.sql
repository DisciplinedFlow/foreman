create schema if not exists foreman;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tokens jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table organisations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  tier text not null default 'free' check (tier in ('free','team','business','oem')),
  isolation text not null default 'pooled' check (isolation in ('pooled','siloed')),
  brand_id uuid references brands(id),
  created_at timestamptz not null default now()
);

create table organisation_members (
  organisation_id uuid not null references organisations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','supervisor','viewer')),
  primary key (organisation_id, user_id)
);
create index on organisation_members (organisation_id, user_id);

create table projects (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  name text not null,
  backbone text not null default 'github',
  gh_installation_id bigint,
  gh_project_node_id text,
  gh_repos text[] not null default '{}',
  field_map jsonb not null default '{}',
  wip_limit int not null default 10,
  stall_threshold_sec int not null default 900,
  created_at timestamptz not null default now()
);

create table agents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  display_name text not null,
  platform text not null,
  model text,
  capabilities text[] not null default '{}',
  integration_depth text not null default 'telemetry'
    check (integration_depth in ('telemetry','mcp','managed')),
  parent_agent_id uuid references agents(id),
  wip_limit int not null default 1,
  status text not null default 'idle'
    check (status in ('idle','working','blocked','stalled','offline','error')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table work_items (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  parent_id uuid references work_items(id),
  title text not null,
  intent text,
  acceptance jsonb not null default '[]',
  priority int not null default 100,
  status text not null default 'queued'
    check (status in ('draft','queued','claimed','in_progress','blocked','in_review','done','cancelled','failed')),
  kind text not null default 'task' check (kind in ('epic','story','task','bug','chore')),
  gh_issue_node_id text,
  gh_issue_number int,
  gh_repo text,
  gh_item_node_id text,
  start_at date,
  target_at date,
  iteration_id text,
  claimed_by uuid references agents(id),
  lease_expires_at timestamptz,
  enqueued_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on work_items (project_id, status, priority, enqueued_at);
create index on work_items (organisation_id);

create table work_item_deps (
  organisation_id uuid not null,
  blocked_id uuid not null references work_items(id) on delete cascade,
  blocker_id uuid not null references work_items(id) on delete cascade,
  source text not null default 'github',
  primary key (blocked_id, blocker_id)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  agent_id uuid not null references agents(id) on delete cascade,
  work_item_id uuid references work_items(id),
  external_session_id text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  cost_usd numeric(12,6) not null default 0
);

create table checkpoints (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  work_item_id uuid not null references work_items(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  question text not null,
  options jsonb,
  context text,
  status text not null default 'open' check (status in ('open','answered','expired')),
  answer text,
  answered_by uuid references users(id),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index on checkpoints (organisation_id, status);

create table agent_tokens (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  token_hash text not null unique,
  agent_id uuid references agents(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Phase 1 deliberately unpartitioned; see plan "Documented deviations" #1.
create table events (
  id bigserial primary key,
  organisation_id uuid not null,
  project_id uuid,
  agent_id uuid,
  work_item_id uuid,
  run_id uuid,
  type text not null,
  payload jsonb not null,
  idempotency_key text,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create unique index events_org_idem on events (organisation_id, idempotency_key)
  where idempotency_key is not null;
create index on events (organisation_id, project_id, recorded_at desc);
create index on events (agent_id, recorded_at desc);
