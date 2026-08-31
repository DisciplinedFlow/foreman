import type pg from "pg";
import { appendEvent, type Queryable } from "@foreman/db";

export interface BriefContent {
  window: { start: string; end: string };
  shipped: Array<{ work_item_id: string; title: string; completed_at: string }>;
  in_flight: Array<{ work_item_id: string; title: string; status: string; agent: string | null }>;
  blocked: Array<{ work_item_id: string; title: string; reason: string | null; since: string | null }>;
  decisions: Array<{ checkpoint_id: string; work_item_id: string; question: string; opened_at: string }>;
  cost: { window_usd: string; previous_window_usd: string };
  forecast: { horizon_days: number | null; previous_horizon_days: number | null };
  risks: { stalled_agents: number; expired_leases: number; dep_cycle: boolean };
}

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

// BRF-7: a pure function of (db state, window). Every list is ordered by a
// stable key; regenerating an old window must be byte-identical. Deterministic
// sections only — LLM prose is deferred (Phase 4 deviation 4).
export async function assembleBrief(
  q: Queryable, projectId: string, window: { start: string; end: string },
): Promise<BriefContent> {
  const shipped = await q.query(
    `select e.work_item_id, w.title, e.occurred_at
     from events e join work_items w on w.id = e.work_item_id
     where e.project_id = $1 and e.type = 'work.completed'
       and e.occurred_at >= $2 and e.occurred_at < $3
     order by e.work_item_id`, [projectId, window.start, window.end]);

  const inFlight = await q.query(
    `select w.id, w.title, w.status, a.display_name
     from work_items w left join agents a on a.id = w.claimed_by
     where w.project_id = $1 and w.status in ('claimed','in_progress')
     order by w.id`, [projectId]);

  const blocked = await q.query(
    `select w.id, w.title,
            (select e.payload->>'reason' from events e
             where e.work_item_id = w.id and e.type = 'work.blocked' order by e.id desc limit 1) as reason,
            (select e.occurred_at from events e
             where e.work_item_id = w.id and e.type = 'work.blocked' order by e.id desc limit 1) as since
     from work_items w where w.project_id = $1 and w.status = 'blocked'
     order by w.id`, [projectId]);

  const decisions = await q.query(
    `select id, work_item_id, question, created_at from checkpoints
     where project_id = $1 and status = 'open' order by id`, [projectId]);

  // Previous window = the same span immediately before this one.
  const cost = await q.query(
    `select
       coalesce(sum(cost_usd) filter (where started_at >= $2 and started_at < $3), 0) as window_usd,
       coalesce(sum(cost_usd) filter (where started_at >= $2::timestamptz - ($3::timestamptz - $2::timestamptz)
                                        and started_at < $2), 0) as previous_usd
     from runs r join agents a on a.id = r.agent_id
     where a.project_id = $1`, [projectId, window.start, window.end]);

  const horizon = await q.query(
    "select max(earliest_finish) as h from proj_schedule where project_id = $1", [projectId]);
  const previousBrief = await q.query(
    `select content from briefs where project_id = $1 and window_end <= $2
     order by window_end desc limit 1`, [projectId, window.start]);

  const risks = await q.query(
    `select
       (select count(*)::int from agents where project_id = $1 and status = 'stalled') as stalled,
       (select count(*)::int from events where project_id = $1 and type = 'work.lease_expired'
          and occurred_at >= $2 and occurred_at < $3) as expired,
       coalesce((select has_dep_cycle from proj_project_health where project_id = $1), false) as cycle`,
    [projectId, window.start, window.end]);

  return {
    window: { start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() },
    shipped: shipped.rows.map((r: any) => ({
      work_item_id: r.work_item_id, title: r.title, completed_at: iso(r.occurred_at)!,
    })),
    in_flight: inFlight.rows.map((r: any) => ({
      work_item_id: r.id, title: r.title, status: r.status, agent: r.display_name ?? null,
    })),
    blocked: blocked.rows.map((r: any) => ({
      work_item_id: r.id, title: r.title, reason: r.reason ?? null, since: iso(r.since),
    })),
    decisions: decisions.rows.map((r: any) => ({
      checkpoint_id: r.id, work_item_id: r.work_item_id, question: r.question, opened_at: iso(r.created_at)!,
    })),
    cost: {
      window_usd: Number(cost.rows[0].window_usd).toFixed(2),
      previous_window_usd: Number(cost.rows[0].previous_usd).toFixed(2),
    },
    forecast: {
      horizon_days: horizon.rows[0].h === null ? null : Number(horizon.rows[0].h),
      previous_horizon_days: previousBrief.rowCount
        ? ((previousBrief.rows[0].content as BriefContent).forecast.horizon_days ?? null)
        : null,
    },
    risks: {
      stalled_agents: risks.rows[0].stalled,
      expired_leases: risks.rows[0].expired,
      dep_cycle: risks.rows[0].cycle,
    },
  };
}

export interface BriefRow {
  id: string; organisation_id: string; project_id: string;
  window_start: Date; window_end: Date; content: BriefContent; generated_at: Date;
}

// Window chains off the previous brief (BRF-2); generation is the only write.
export async function generateBrief(pool: pg.Pool, projectId: string, windowEnd = new Date()): Promise<BriefRow> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const proj = await client.query("select organisation_id from projects where id = $1", [projectId]);
    if (proj.rowCount === 0) throw new Error(`unknown project ${projectId}`);
    const prev = await client.query(
      "select window_end from briefs where project_id = $1 order by window_end desc limit 1", [projectId]);
    const windowStart: Date = prev.rowCount ? prev.rows[0].window_end : new Date(0);

    const content = await assembleBrief(client, projectId,
      { start: windowStart.toISOString(), end: windowEnd.toISOString() });
    const ins = await client.query(
      `insert into briefs (organisation_id, project_id, window_start, window_end, content)
       values ($1,$2,$3,$4,$5) returning *`,
      [proj.rows[0].organisation_id, projectId, windowStart, windowEnd, JSON.stringify(content)]);
    await appendEvent(client, {
      organisation_id: proj.rows[0].organisation_id, project_id: projectId,
      type: "brief.generated",
      payload: {
        brief_id: ins.rows[0].id,
        window_start: windowStart.toISOString(), window_end: windowEnd.toISOString(),
      },
    });
    await client.query("commit");
    return ins.rows[0] as BriefRow;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
