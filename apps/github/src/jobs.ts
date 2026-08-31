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
    `update sync_jobs set status='running', attempts=attempts+1
     where id = (select id from sync_jobs where status='queued' and run_after <= now()
                 order by id limit 1 for update skip locked)
     returning *`);
  return res.rowCount ? (res.rows[0] as SyncJob) : null;
}

export async function completeSyncJob(q: Queryable, id: string, ok: boolean): Promise<void> {
  if (ok) {
    await q.query("update sync_jobs set status='done' where id = $1", [id]);
    return;
  }
  await q.query(
    `update sync_jobs set status = case when attempts >= 5 then 'failed' else 'queued' end,
       run_after = now() + interval '30 seconds' * attempts
     where id = $1`, [id]);
}
