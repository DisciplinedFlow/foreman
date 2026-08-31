create or replace function foreman.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function foreman.is_member(org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from organisation_members m
    where m.organisation_id = org and m.user_id = foreman.current_user_id()
  );
$$;

do $$ begin create role foreman_service login password 'foreman_service' bypassrls; exception when duplicate_object then null; when unique_violation then null; end $$;
do $$ begin create role foreman_app login password 'foreman_app'; exception when duplicate_object then null; when unique_violation then null; end $$;

grant usage on schema public, foreman to foreman_service, foreman_app;
grant select, insert, update, delete on all tables in schema public to foreman_service, foreman_app;
grant usage, select on all sequences in schema public to foreman_service, foreman_app;
alter default privileges in schema public grant select, insert, update, delete on tables to foreman_service, foreman_app;
alter default privileges in schema public grant usage, select on sequences to foreman_service, foreman_app;

alter table organisations enable row level security;
create policy organisations_tenant on organisations
  using (foreman.is_member(id)) with check (foreman.is_member(id));

alter table organisation_members enable row level security;
create policy organisation_members_tenant on organisation_members
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));

-- identical pattern for every remaining organisation_id table:
alter table projects enable row level security;
create policy projects_tenant on projects
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table agents enable row level security;
create policy agents_tenant on agents
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table work_items enable row level security;
create policy work_items_tenant on work_items
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table work_item_deps enable row level security;
create policy work_item_deps_tenant on work_item_deps
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table runs enable row level security;
create policy runs_tenant on runs
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table checkpoints enable row level security;
create policy checkpoints_tenant on checkpoints
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table agent_tokens enable row level security;
create policy agent_tokens_tenant on agent_tokens
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
alter table events enable row level security;
create policy events_tenant on events
  using (foreman.is_member(organisation_id)) with check (foreman.is_member(organisation_id));
