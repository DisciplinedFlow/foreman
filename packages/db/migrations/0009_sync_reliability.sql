-- Phase 10 audit #1: sync_jobs reliability & observability. Failures were
-- silently swallowed (console.warn+return) and a worker crash mid-job left
-- the row stuck 'running' forever with no record of why. This adds a
-- surfaced error column and a lock timestamp the reaper can compare against.
alter table sync_jobs add column last_error text;
alter table sync_jobs add column locked_at timestamptz;
