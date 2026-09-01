import type { Queryable } from "@foreman/db";

export interface SyncJob {
  id: string;
  organisation_id: string;
  installation_id: string | number;
  delivery_id: string;
  event_name: string;
  action: string | null;
  payload: any;
  status: string;
  attempts: number;
}

export async function claimSyncJob(q: Queryable): Promise<SyncJob | null> {
  const res = await q.query(
    `update sync_jobs set status='running', attempts=attempts+1, locked_at=now()
     where id = (select id from sync_jobs where status='queued' and run_after <= now()
                 order by id limit 1 for update skip locked)
     returning *`);
  return res.rowCount ? (res.rows[0] as SyncJob) : null;
}

export async function completeSyncJob(q: Queryable, id: string, ok: boolean, error?: string): Promise<void> {
  if (ok) {
    await q.query("update sync_jobs set status='done', last_error=null, locked_at=null where id = $1", [id]);
    return;
  }
  await q.query(
    `update sync_jobs set status = case when attempts >= 5 then 'failed' else 'queued' end,
       run_after = now() + interval '30 seconds' * attempts,
       last_error = $2, locked_at = null
     where id = $1`, [id, error ?? null]);
}

// Audit #1: a worker crash (OOM, kill -9, deploy) between claim and complete
// leaves a job 'running' forever with a stale locked_at — the scheduler tick
// resets those back to 'queued' so they get retried instead of stuck.
export async function reapStuckSyncJobs(q: Queryable, olderThanSec = 120): Promise<number> {
  const res = await q.query(
    `update sync_jobs set status='queued', last_error='reaped: stuck', locked_at=null
     where status='running' and locked_at < now() - make_interval(secs => $1)`,
    [olderThanSec]);
  return res.rowCount ?? 0;
}
