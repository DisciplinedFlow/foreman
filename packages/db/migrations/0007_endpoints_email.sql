-- LFC-2: endpoint lifecycle, every state transition evidence-backed.
create table endpoints (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  project_id      uuid not null references projects(id) on delete cascade,
  gh_repo         text not null,
  method          text not null,
  path            text not null,
  state           text not null default 'planned'
    check (state in ('planned','stubbed','implemented','tested','deployed','deprecated')),
  evidence        jsonb not null default '[]',
  work_item_ids   uuid[] not null default '{}',
  in_spec         boolean not null default false,
  has_impl        boolean not null default false,
  has_test        boolean not null default false,
  first_seen      timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (project_id, method, path)
);
create index on endpoints (project_id, state);

-- BRF-4: email delivery target per project.
alter table projects add column brief_email text;

alter table endpoints enable row level security;
create policy endpoints_tenant on endpoints
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
