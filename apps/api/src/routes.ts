import type express from "express";
import { withUser } from "./rls.js";
import type { ApiDeps, AuthedRequest } from "./http.js";

// All reads run under withUser: RLS scopes rows, handlers never filter by org.
export function mountRoutes(api: express.Router, deps: ApiDeps): void {
  const wrap = (fn: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  api.get("/orgs", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const orgs = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select id, slug from organisations order by slug")).rows);
    res.json({ orgs });
  }));

  api.get("/orgs/:orgId/projects", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const projects = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select id, name, gh_repos, gh_project_node_id, wip_limit from projects
         where organisation_id = $1 order by name`, [req.params.orgId])).rows);
    res.json({ projects });
  }));

  api.get("/projects/:id", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const body = await withUser(deps.appPool, userId, async (tx) => {
      const project = await tx.query("select * from projects where id = $1", [req.params.id]);
      if (project.rowCount === 0) return null;
      const health = await tx.query(
        "select has_dep_cycle, cycle_members, computed_at from proj_project_health where project_id = $1",
        [req.params.id]);
      return { project: project.rows[0], health: health.rowCount ? health.rows[0] : null };
    });
    if (body === null) return res.status(404).json({ error: "not found" });
    res.json(body);
  }));

  api.get("/projects/:id/items", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const body = await withUser(deps.appPool, userId, async (tx) => {
      const project = await tx.query("select 1 from projects where id = $1", [req.params.id]);
      if (project.rowCount === 0) return null;
      const items = await tx.query(
        `select id, title, status, kind, priority, parent_id, gh_issue_number, gh_repo,
                start_at, target_at, claimed_by, updated_at
         from work_items where project_id = $1 order by enqueued_at`, [req.params.id]);
      const deps_ = await tx.query(
        `select d.blocked_id, d.blocker_id from work_item_deps d
         join work_items w on w.id = d.blocked_id where w.project_id = $1`, [req.params.id]);
      return { items: items.rows, deps: deps_.rows };
    });
    if (body === null) return res.status(404).json({ error: "not found" });
    res.json(body);
  }));

  api.get("/projects/:id/schedule", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const schedule = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select work_item_id, earliest_start, earliest_finish, latest_start, latest_finish, slack, critical
         from proj_schedule where project_id = $1 order by earliest_start`, [req.params.id])).rows);
    res.json({ schedule });
  }));

  api.get("/projects/:id/agents", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const agents = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select a.id, a.display_name, a.platform, a.model, a.status, a.last_seen_at,
                w.id as work_item_id, w.title as work_item_title,
                r.external_session_id, r.tokens_in, r.tokens_out, r.cost_usd, r.started_at
         from agents a
         left join work_items w on w.claimed_by = a.id and w.project_id = a.project_id
         left join lateral (
           select * from runs where agent_id = a.id order by started_at desc limit 1
         ) r on true
         where a.project_id = $1
         order by a.display_name`, [req.params.id])).rows);
    res.json({ agents });
  }));
}
