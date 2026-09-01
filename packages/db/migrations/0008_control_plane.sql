-- WL-8/WL-9: a provisioning role the application plane cannot reach, plus
-- neutral usage metering. Same cluster-global-role guard idiom as 0002 so
-- parallel throwaway test databases don't race on role creation.
do $$ begin create role foreman_control login password 'foreman_control' bypassrls; exception when duplicate_object then null; when unique_violation then null; end $$;

grant usage on schema public, foreman to foreman_control;
grant all on organisations, brands, organisation_members, users to foreman_control;
-- Deviation from the brief's grant list: meterUsage (WL-9) reads the event
-- log across every organisation to compute events_ingested/active_agents/
-- items_completed. BYPASSRLS alone doesn't imply table-level SELECT — grant
-- it explicitly. Read-only; foreman_control never writes events.
grant select on events to foreman_control;

-- WL-8: the application plane loses the ability to create or destroy tenants.
-- Only foreman_control (apps/control) provisions; foreman_service (workers,
-- seed) and foreman_app (RLS-bound reads/writes) never do.
revoke insert, delete on organisations, brands from foreman_app;

-- WL-9: neutral usage metering — (org, period, metric, value) only, no prices
-- or currency anywhere.
create table usage_records (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  metric text not null,
  value numeric not null,
  created_at timestamptz not null default now(),
  unique (organisation_id, period_start, metric)
);
create index on usage_records (organisation_id, period_start);

grant all on usage_records to foreman_control;

-- X-4: tenants may see their own usage; only the control plane writes it.
alter table usage_records enable row level security;
create policy usage_records_tenant_select on usage_records for select
  using (foreman.is_member(organisation_id));
