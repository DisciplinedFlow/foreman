import type pg from "pg";
import type { Queryable } from "@foreman/db";

export interface EventRow {
  id: string;
  organisation_id: string;
  project_id: string | null;
  agent_id: string | null;
  work_item_id: string | null;
  run_id: string | null;
  type: string;
  payload: unknown;
  occurred_at: Date;
  recorded_at: Date;
}

// §1.1: idempotent and replayable from offset 0 — apply twice over the same
// events must produce identical tables. §1.3: reads events, writes only proj_*.
export interface Projection {
  name: string;
  handles(type: string): boolean;
  apply(tx: Queryable, events: EventRow[]): Promise<void>;
}

export async function runOnce(pool: pg.Pool, projections: Projection[], batch = 500): Promise<number> {
  let maxFetched = 0;
  for (const projection of projections) {
    await pool.query(
      "insert into projection_cursors (name) values ($1) on conflict do nothing", [projection.name]);
    const cur = await pool.query(
      "select last_event_id from projection_cursors where name = $1", [projection.name]);
    const cursor = Number(cur.rows[0].last_event_id);

    const res = await pool.query(
      "select * from events where id > $1 order by id limit $2", [cursor, batch]);
    if (res.rowCount === 0) continue;
    maxFetched = Math.max(maxFetched, res.rowCount ?? 0);
    const rows = res.rows as EventRow[];
    const handled = rows.filter((e) => projection.handles(e.type));
    const lastId = rows[rows.length - 1]!.id;

    // apply + cursor advance in ONE tx: a throwing projection leaves the cursor put.
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (handled.length > 0) await projection.apply(client, handled);
      await client.query(
        "update projection_cursors set last_event_id = $2, updated_at = now() where name = $1",
        [projection.name, lastId]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
  return maxFetched;
}

// LISTEN wake (0004 trigger) with a 2s poll fallback; drains until caught up.
export async function runForever(pool: pg.Pool, projections: Projection[]): Promise<never> {
  const listener = await pool.connect();
  let wake: (() => void) | null = null;
  listener.on("notification", () => { wake?.(); });
  listener.on("error", (err) => { console.error("listen connection error", err); });
  await listener.query("listen foreman_events");

  for (;;) {
    try {
      while ((await runOnce(pool, projections)) > 0) { /* drain until caught up */ }
    } catch (err) {
      console.error("projection pass failed; retrying", err);
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 2000);
    });
    wake = null;
  }
}
