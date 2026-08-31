-- 0002 defined foreman.is_member/current_user_id as SECURITY DEFINER with `set search_path = public`
-- and an unqualified `organisation_members` reference. Postgres searches pg_temp FIRST regardless of
-- search_path unless pg_temp is placed explicitly LAST, so any RLS-enforced session could
-- `create temp table organisation_members (...)` with a forged row and defeat every tenant policy.
-- Pin search_path with pg_temp last and schema-qualify the table reference; signature/behaviour
-- otherwise unchanged from 0002. 0002 is already applied in dev DBs so it is left alone; this
-- migration only replaces the function bodies.
create or replace function foreman.current_user_id() returns uuid
language sql stable set search_path = public, pg_temp as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create or replace function foreman.is_member(org uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.organisation_members m
    where m.organisation_id = org and m.user_id = foreman.current_user_id()
  );
$$;

-- Duplicate of the primary key (organisation_id, user_id); the PK already covers this access path.
drop index if exists organisation_members_organisation_id_user_id_idx;

-- events are append-only at the privilege level: no code path updates or deletes rows, and 0002's
-- blanket grant gave foreman_service/foreman_app more than they need.
revoke update, delete on public.events from foreman_service, foreman_app;
revoke update, delete, truncate on public.schema_migrations from foreman_service, foreman_app;
