import type { Queryable } from "./events.js";

// GHA reconciliation (Phase 2 deviation 6): dependency changes have no webhook, so a
// cron enqueues a foreman.reconcile job per GitHub-connected project; the github
// worker routes it to fullSync.
export async function enqueueReconcileJobs(q: Queryable): Promise<number> {
  const res = await q.query(
    `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)
     select organisation_id, gh_installation_id,
            'reconcile:' || id || ':' || extract(epoch from now())::bigint,
            'foreman.reconcile', jsonb_build_object('project_id', id)
     from projects
     where gh_project_node_id is not null and gh_installation_id is not null`);
  // LFC: the same cadence keeps endpoint states fresh (repos, not project boards).
  const scans = await q.query(
    `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)
     select organisation_id, coalesce(gh_installation_id, 0),
            'lifecycle:' || id || ':' || extract(epoch from now())::bigint,
            'foreman.lifecycle_scan', jsonb_build_object('project_id', id)
     from projects
     where cardinality(gh_repos) > 0 and gh_installation_id is not null`);
  return (res.rowCount ?? 0) + (scans.rowCount ?? 0);
}
