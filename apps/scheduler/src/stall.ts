import type pg from "pg";
import { appendEvent } from "@foreman/db";

// AVW-3: "an agent stuck in a loop looks like an agent doing work" — rule B is
// exactly the counter to that. Both rules flag once; recovery is the MCP
// heartbeat path (agent.resumed).
export async function detectStalls(pool: pg.Pool): Promise<number> {
  // Rule A: silence past the project threshold (default 900s without a project).
  const silent = await pool.query(
    `select a.id, a.organisation_id, a.project_id,
            coalesce(p.stall_threshold_sec, 900) as threshold,
            max(e.recorded_at) as last_seen
     from agents a
     left join projects p on p.id = a.project_id
     join events e on e.agent_id = a.id
     where a.status = 'working'
     group by a.id, a.organisation_id, a.project_id, p.stall_threshold_sec
     having max(e.recorded_at) < now() - make_interval(secs => coalesce(p.stall_threshold_sec, 900))`);

  // Rule B: the last 5 tool.invoked events are byte-identical (same call ×5).
  const looping = await pool.query(
    `select id, organisation_id, project_id, threshold, last_seen from (
       select a.id, a.organisation_id, a.project_id,
              coalesce(p.stall_threshold_sec, 900) as threshold,
              (select max(recorded_at) from events where agent_id = a.id) as last_seen,
              (select count(distinct md5(e.payload::text))
               from (select payload from events
                     where agent_id = a.id and type = 'tool.invoked'
                     order by id desc limit 5) e) as distinct_calls,
              (select count(*) from events where agent_id = a.id and type = 'tool.invoked') as total_calls
       from agents a
       left join projects p on p.id = a.project_id
       where a.status = 'working'
     ) s where total_calls >= 5 and distinct_calls = 1`);

  const flagged = new Map<string, { organisation_id: string; project_id: string | null; threshold: number; last_seen: Date }>();
  for (const r of [...silent.rows, ...looping.rows]) flagged.set(r.id, r);

  let n = 0;
  for (const [agentId, r] of flagged) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const upd = await client.query(
        "update agents set status='stalled' where id = $1 and status = 'working'", [agentId]);
      if (upd.rowCount) {
        await appendEvent(client, {
          organisation_id: r.organisation_id, project_id: r.project_id ?? undefined, agent_id: agentId,
          type: "agent.stalled",
          payload: { threshold_sec: r.threshold, last_transition_at: new Date(r.last_seen).toISOString() },
        });
        n += 1;
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return n;
}
