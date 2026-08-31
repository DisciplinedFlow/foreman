import type { Queryable } from "@foreman/db";
import type { EventRow, Projection } from "../runner.js";

export interface ScheduleInput {
  id: string;
  start_at: string | Date | null;
  target_at: string | Date | null;
  deps: string[];
}

export interface ScheduleRow {
  id: string;
  earliest_start: number;
  earliest_finish: number;
  latest_start: number;
  latest_finish: number;
  slack: number;
  critical: boolean;
}

const DAY_MS = 86_400_000;

function durationDays(item: ScheduleInput): number {
  if (item.start_at === null || item.target_at === null) return 1;
  const start = new Date(item.start_at).getTime();
  const target = new Date(item.target_at).getTime();
  return Math.max(1, Math.round((target - start) / DAY_MS));
}

// GNT-5: day-granularity CPM. A cycle returns its members and no rows —
// §5.3 says surface as a health warning rather than throwing.
export function computeSchedule(items: ScheduleInput[]): { rows: ScheduleRow[]; cycle: string[] } {
  const ids = new Set(items.map((i) => i.id));
  const dur = new Map(items.map((i) => [i.id, durationDays(i)]));
  const blockers = new Map(items.map((i) => [i.id, i.deps.filter((d) => ids.has(d))]));
  const dependents = new Map<string, string[]>(items.map((i) => [i.id, []]));
  for (const i of items) for (const d of blockers.get(i.id)!) dependents.get(d)!.push(i.id);

  // Kahn topological sort
  const indegree = new Map(items.map((i) => [i.id, blockers.get(i.id)!.length]));
  const queue = items.filter((i) => indegree.get(i.id) === 0).map((i) => i.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dep of dependents.get(id)!) {
      const left = indegree.get(dep)! - 1;
      indegree.set(dep, left);
      if (left === 0) queue.push(dep);
    }
  }
  if (order.length < items.length) {
    return { rows: [], cycle: items.map((i) => i.id).filter((id) => !order.includes(id)) };
  }

  // Forward pass: ES = max(EF of blockers), anchored at day 0.
  const es = new Map<string, number>(), ef = new Map<string, number>();
  for (const id of order) {
    const start = Math.max(0, ...blockers.get(id)!.map((b) => ef.get(b)!));
    es.set(id, start);
    ef.set(id, start + dur.get(id)!);
  }
  const horizon = Math.max(0, ...order.map((id) => ef.get(id)!));

  // Backward pass from the horizon.
  const ls = new Map<string, number>(), lf = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const finish = Math.min(horizon, ...dependents.get(id)!.map((d) => ls.get(d)!));
    lf.set(id, finish);
    ls.set(id, finish - dur.get(id)!);
  }

  const rows = items.map((i) => {
    const slack = ls.get(i.id)! - es.get(i.id)!;
    return {
      id: i.id,
      earliest_start: es.get(i.id)!, earliest_finish: ef.get(i.id)!,
      latest_start: ls.get(i.id)!, latest_finish: lf.get(i.id)!,
      slack, critical: slack === 0,
    };
  });
  return { rows, cycle: [] };
}

const HANDLED = new Set([
  "github.issue_synced", "github.project_item_changed", "work.rescheduled",
  "work.created", "work.completed", "work.cancelled",
]);

// Recompute affected projects wholesale — no incremental cleverness at Phase 2 scale.
export const criticalPathProjection: Projection = {
  name: "critical_path",
  handles: (type) => HANDLED.has(type),
  async apply(tx: Queryable, events: EventRow[]): Promise<void> {
    const projectIds = [...new Set(events.map((e) => e.project_id).filter((p): p is string => p !== null))];
    for (const projectId of projectIds) {
      const proj = await tx.query("select organisation_id from projects where id = $1", [projectId]);
      if (proj.rowCount === 0) continue;
      const orgId: string = proj.rows[0].organisation_id;

      const items = await tx.query(
        "select id, start_at, target_at from work_items where project_id = $1", [projectId]);
      const deps = await tx.query(
        `select d.blocked_id, d.blocker_id from work_item_deps d
         join work_items w on w.id = d.blocked_id where w.project_id = $1`, [projectId]);
      const depsByBlocked = new Map<string, string[]>();
      for (const d of deps.rows as Array<{ blocked_id: string; blocker_id: string }>) {
        (depsByBlocked.get(d.blocked_id) ?? depsByBlocked.set(d.blocked_id, []).get(d.blocked_id)!)
          .push(d.blocker_id);
      }

      const { rows, cycle } = computeSchedule((items.rows as any[]).map((w) => ({
        id: w.id, start_at: w.start_at, target_at: w.target_at,
        deps: depsByBlocked.get(w.id) ?? [],
      })));

      await tx.query("delete from proj_schedule where project_id = $1", [projectId]);
      for (const r of rows) {
        await tx.query(
          `insert into proj_schedule (work_item_id, organisation_id, project_id,
             earliest_start, earliest_finish, latest_start, latest_finish, slack, critical)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [r.id, orgId, projectId, r.earliest_start, r.earliest_finish,
           r.latest_start, r.latest_finish, r.slack, r.critical]);
      }
      await tx.query(
        `insert into proj_project_health (project_id, organisation_id, has_dep_cycle, cycle_members, computed_at)
         values ($1,$2,$3,$4,now())
         on conflict (project_id) do update set has_dep_cycle = excluded.has_dep_cycle,
           cycle_members = excluded.cycle_members, computed_at = now()`,
        [projectId, orgId, cycle.length > 0, cycle]);
    }
  },
};
