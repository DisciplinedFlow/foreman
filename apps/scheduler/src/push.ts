import type pg from "pg";
import { regenerateOverview, type Llm } from "foreman-gen/lib";

// OVW-2 push (closes the Phase 5 cron-only deviation): a cursor loop in the
// projector-runner style over work.completed events. One-way rule: reads
// events, writes only via regenerateOverview + sync_jobs inserts. Replay-safe —
// regenerateOverview's evidence-hash gating makes re-running a batch free.

const CURSOR = "overview_push";

export async function runPushOnce(
  pool: pg.Pool, deps: { llm: Llm }, batch = 200,
): Promise<{ projects: string[] }> {
  await pool.query("insert into projection_cursors (name) values ($1) on conflict do nothing", [CURSOR]);
  const cur = await pool.query("select last_event_id from projection_cursors where name = $1", [CURSOR]);
  const cursor = Number(cur.rows[0].last_event_id);

  const rows = await pool.query(
    "select id, project_id, type from events where id > $1 order by id limit $2", [cursor, batch]);
  if (rows.rowCount === 0) return { projects: [] };
  const lastId = rows.rows[rows.rows.length - 1].id;

  const projects = [...new Set(
    rows.rows
      .filter((r: any) => r.type === "work.completed" && r.project_id !== null)
      .map((r: any) => r.project_id as string))];

  for (const projectId of projects) {
    await regenerateOverview(pool, projectId, { llm: deps.llm, causedBy: "push" });
    const proj = await pool.query(
      `select organisation_id, gh_installation_id from projects
       where id = $1 and cardinality(gh_repos) > 0 and gh_installation_id is not null`, [projectId]);
    if (proj.rowCount) {
      await pool.query(
        `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)
         values ($1,$2,$3,'foreman.lifecycle_scan',$4)`,
        [proj.rows[0].organisation_id, proj.rows[0].gh_installation_id,
         `push:${projectId}:${cursor}`, JSON.stringify({ project_id: projectId })]);
    }
  }

  await pool.query(
    "update projection_cursors set last_event_id = $2, updated_at = now() where name = $1", [CURSOR, lastId]);
  return { projects };
}

// LISTEN wake with poll fallback; per-window debounce so a completion burst
// regenerates once (deviation 2).
export async function watchPush(
  pool: pg.Pool, deps: { llm: Llm; debounceMs?: number },
): Promise<never> {
  const debounce = deps.debounceMs ?? 2000;
  const listener = await pool.connect();
  let pending = false;
  listener.on("notification", () => { pending = true; });
  listener.on("error", (err) => console.error("push listener error", err));
  await listener.query("listen foreman_events");

  for (;;) {
    await new Promise((r) => setTimeout(r, debounce));
    if (!pending) continue;
    pending = false;
    try {
      // drain until caught up
      while ((await runPushOnce(pool, deps)).projects.length >= 0) {
        const more = await pool.query(
          `select 1 from events e, projection_cursors c
           where c.name = 'overview_push' and e.id > c.last_event_id limit 1`);
        if (more.rowCount === 0) break;
      }
    } catch (err) {
      console.error("push pass failed; will retry", err);
    }
  }
}
