import pg from "pg";
import { appendEvent, type Queryable } from "./events.js";

export class WipLimitExceededError extends Error {
  code = "wip_limit_exceeded" as const;
  constructor(public scope: "agent" | "project") { super(`wip_limit_exceeded:${scope}`); }
}

export interface WorkItemRow {
  id: string;
  organisation_id: string;
  project_id: string;
  title: string;
  intent: string | null;
  acceptance: string[];
  priority: number;
  status: string;
  kind: string;
  claimed_by: string | null;
  lease_expires_at: string | null;
  enqueued_at: string;
}

const CLAIM_SQL = `
update work_items w set status = 'claimed', claimed_by = $2,
       lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
where w.id = (
  select id from work_items
  where project_id = $1 and status = 'queued'
    and not exists (select 1 from work_item_deps d
                    join work_items b on b.id = d.blocker_id
                    where d.blocked_id = work_items.id and b.status <> 'done')
  order by priority asc, enqueued_at asc
  for update skip locked limit 1)
returning *`;

export async function claimNextWorkItem(pool: pg.Pool,
  { projectId, agentId, leaseSeconds = 900 }: { projectId: string; agentId: string; leaseSeconds?: number },
): Promise<WorkItemRow | null> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const agent = await c.query("select organisation_id, wip_limit from agents where id = $1 for update", [agentId]);
    if (!agent.rowCount) throw new Error("unknown agent");
    const proj = await c.query("select organisation_id, wip_limit from projects where id = $1 for update", [projectId]);
    if (!proj.rowCount) throw new Error("unknown project");
    if (agent.rows[0].organisation_id !== proj.rows[0].organisation_id) {
      throw new Error("agent and project belong to different organisations");
    }
    const active = await c.query(
      `select count(*) filter (where claimed_by = $1)::int as agent_n,
              count(*)::int as project_n
       from work_items where project_id = $2 and status in ('claimed','in_progress')`,
      [agentId, projectId]);
    if (active.rows[0].agent_n >= agent.rows[0].wip_limit) throw new WipLimitExceededError("agent");
    if (active.rows[0].project_n >= proj.rows[0].wip_limit) throw new WipLimitExceededError("project");
    const res = await c.query(CLAIM_SQL, [projectId, agentId, leaseSeconds]);
    if (res.rowCount) {
      const item = res.rows[0];
      await appendEvent(c, {
        organisation_id: item.organisation_id, project_id: projectId,
        agent_id: agentId, work_item_id: item.id, type: "work.claimed",
        payload: { agent_id: agentId, lease_expires_at: new Date(item.lease_expires_at).toISOString() },
      });
      await c.query("commit");
      return item;
    }
    await c.query("commit");
    return null;
  } catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}

export async function extendLease(q: Queryable, workItemId: string, agentId: string, leaseSeconds = 900): Promise<boolean> {
  const res = await q.query(
    `update work_items set lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
     where id = $1 and claimed_by = $2 and status in ('claimed','in_progress')`,
    [workItemId, agentId, leaseSeconds]);
  return (res.rowCount ?? 0) > 0;
}

export async function sweepExpiredLeases(pool: pg.Pool): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const res = await c.query(`
      update work_items w
      set status = 'queued', claimed_by = null, lease_expires_at = null, updated_at = now()
      from (select id, claimed_by, organisation_id, project_id from work_items
            where status in ('claimed','in_progress') and lease_expires_at < now()
            for update skip locked) e
      where w.id = e.id
      returning w.id, e.claimed_by as agent, e.organisation_id, e.project_id`);
    for (const r of res.rows) {
      await appendEvent(c, { organisation_id: r.organisation_id, project_id: r.project_id,
        agent_id: r.agent, work_item_id: r.id, type: "work.lease_expired", payload: { agent_id: r.agent } });
    }
    await c.query("commit");
    return res.rowCount ?? 0;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

export async function enqueueWorkItem(pool: pg.Pool, args: {
  organisationId: string; projectId: string; title: string; intent?: string;
  acceptance?: string[]; priority?: number; kind?: string;
}): Promise<WorkItemRow> {
  const { organisationId, projectId, title, intent, acceptance = [], priority = 100, kind = "task" } = args;
  const c = await pool.connect();
  try {
    await c.query("begin");
    const res = await c.query(
      `insert into work_items (organisation_id, project_id, title, intent, acceptance, priority, kind, status)
       values ($1,$2,$3,$4,$5,$6,$7,'queued') returning *`,
      [organisationId, projectId, title, intent ?? null, JSON.stringify(acceptance), priority, kind]);
    const item = res.rows[0];
    await appendEvent(c, {
      organisation_id: organisationId, project_id: projectId, work_item_id: item.id,
      type: "work.created", payload: { title, kind, priority },
    });
    await appendEvent(c, {
      organisation_id: organisationId, project_id: projectId, work_item_id: item.id,
      type: "work.enqueued", payload: { priority },
    });
    await c.query("commit");
    return item;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}

export async function completeWorkItem(pool: pg.Pool, args: {
  workItemId: string; agentId: string; summary: string;
  acceptanceResults: { criterion: string; met: boolean }[];
  prUrl?: string; commitSha?: string;
}): Promise<void> {
  const { workItemId, agentId, summary, acceptanceResults, prUrl, commitSha } = args;
  const c = await pool.connect();
  try {
    await c.query("begin");
    const res = await c.query(
      "select organisation_id, project_id, acceptance, claimed_by from work_items where id = $1 for update",
      [workItemId]);
    if (!res.rowCount) throw new Error("unknown work item");
    const item = res.rows[0];
    if (item.claimed_by !== agentId) throw new Error("work item not claimed by you");
    if (Array.isArray(item.acceptance) && item.acceptance.length > 0 && acceptanceResults.length === 0) {
      const err = new Error("acceptance_verdict_required: acceptance criteria present but no acceptance results supplied");
      (err as Error & { code?: string }).code = "acceptance_verdict_required";
      throw err;
    }
    await c.query(
      "update work_items set status = 'done', claimed_by = null, lease_expires_at = null, updated_at = now() where id = $1",
      [workItemId]);
    await appendEvent(c, {
      organisation_id: item.organisation_id, project_id: item.project_id,
      agent_id: agentId, work_item_id: workItemId, type: "work.completed",
      payload: { summary, acceptance_results: acceptanceResults, pr_url: prUrl, commit_sha: commitSha },
    });
    await c.query("commit");
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
