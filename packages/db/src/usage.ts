import type pg from "pg";

// WL-9: neutral usage metering — (organisation, period, metric, value) only.
// No prices, no currency, anywhere. One row per organisation per metric,
// upserted so re-running metering for the same period is idempotent.
const UPSERT = (metric: string, join: string, select: string) => `
  insert into usage_records (organisation_id, period_start, period_end, metric, value)
  select o.id, $1::date, $2::date, '${metric}', ${select}
  from organisations o
  ${join}
  group by o.id
  on conflict (organisation_id, period_start, metric)
  do update set value = excluded.value, period_end = excluded.period_end
`;

const METRICS = [
  UPSERT("events_ingested",
    "left join events e on e.organisation_id = o.id and e.recorded_at >= $1 and e.recorded_at < $2",
    "count(e.id)"),
  UPSERT("active_agents",
    `left join events e on e.organisation_id = o.id and e.agent_id is not null
       and e.recorded_at >= $1 and e.recorded_at < $2`,
    "count(distinct e.agent_id)"),
  UPSERT("items_completed",
    `left join events e on e.organisation_id = o.id and e.type = 'work.completed'
       and e.recorded_at >= $1 and e.recorded_at < $2`,
    "count(e.id)"),
  UPSERT("seats",
    "left join organisation_members m on m.organisation_id = o.id",
    "count(m.user_id)"),
];

export async function meterUsage(pool: pg.Pool, period: { start: Date; end: Date }): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    let written = 0;
    for (const sql of METRICS) {
      const res = await client.query(sql, [period.start, period.end]);
      written += res.rowCount ?? 0;
    }
    await client.query("commit");
    return written;
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
}
