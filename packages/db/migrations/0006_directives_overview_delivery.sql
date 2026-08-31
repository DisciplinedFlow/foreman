-- AVW-5: directives are offers a human writes and an agent drains via its
-- heartbeat reply — never remote control of the agent process.
create table directives (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  agent_id        uuid not null references agents(id) on delete cascade,
  kind            text not null check (kind in ('pause','resume','cancel_item','message','request_checkpoint')),
  payload         jsonb not null default '{}',
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index on directives (agent_id) where delivered_at is null;

-- OVW: current section state; every publish also lands in overview_revisions.
create table overview_sections (
  project_id      uuid not null references projects(id) on delete cascade,
  organisation_id uuid not null,
  section_id      text not null check (section_id in
    ('purpose','architecture','data_model','interfaces','shipped','in_flight','conventions','risks')),
  version         int not null default 1,
  content         text not null,
  sources         jsonb not null,          -- OVW-3: non-empty array enforced in code
  pinned          boolean not null default false,
  human_authored  boolean not null default false,
  evidence_hash   text not null,
  generator       jsonb not null,          -- {llm, model, prompt_version} pins
  updated_at      timestamptz not null default now(),
  primary key (project_id, section_id)
);

create table overview_revisions (
  id              bigserial primary key,
  organisation_id uuid not null,
  project_id      uuid not null references projects(id) on delete cascade,
  section_id      text not null,
  version         int not null,
  content         text not null,
  sources         jsonb not null,
  caused_by       text,                     -- 'cron' | 'manual' | 'human' | work item id
  created_at      timestamptz not null default now()
);
create index on overview_revisions (project_id, section_id, version desc);

-- BRF-1/4 delivery configuration.
alter table projects add column brief_schedule text check (brief_schedule in ('daily','weekly'));
alter table projects add column brief_timezone text not null default 'UTC';
alter table projects add column brief_webhook_url text;

-- RLS (WL-7): 0002 policy pattern.
alter table directives enable row level security;
create policy directives_tenant on directives
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table overview_sections enable row level security;
create policy overview_sections_tenant on overview_sections
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table overview_revisions enable row level security;
create policy overview_revisions_tenant on overview_revisions
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
