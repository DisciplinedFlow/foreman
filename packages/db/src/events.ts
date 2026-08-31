import { validateEventPayload, type NewEvent } from "@foreman/events";
import type pg from "pg";

export type Queryable = { query(text: string, values?: unknown[]): Promise<pg.QueryResult> };

export async function appendEvent(q: Queryable, evt: NewEvent): Promise<{ id: string | null; deduped: boolean }> {
  const v = validateEventPayload(evt.type, evt.payload);
  if (!v.ok) throw new Error(`invalid event ${evt.type}: ${v.error}`);
  const res = await q.query(
    `insert into events (organisation_id, project_id, agent_id, work_item_id, run_id, type, payload, idempotency_key, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9, now()))
     on conflict (organisation_id, idempotency_key) where idempotency_key is not null do nothing
     returning id`,
    [evt.organisation_id, evt.project_id ?? null, evt.agent_id ?? null, evt.work_item_id ?? null,
     evt.run_id ?? null, evt.type, JSON.stringify(v.payload), evt.idempotency_key ?? null, evt.occurred_at ?? null]);
  return res.rowCount ? { id: String(res.rows[0].id), deduped: false } : { id: null, deduped: true };
}
