import type express from "express";
import { z } from "zod";
import { appendEvent } from "@foreman/db";
import { SECTIONS, regenerateOverview, llmFromEnv } from "foreman-gen/lib";
import { withUser } from "./rls.js";
import type { ApiDeps, AuthedRequest } from "./http.js";

const directiveBody = z.object({
  kind: z.enum(["pause", "resume", "cancel_item", "message", "request_checkpoint"]),
  message: z.string().min(1).optional(),
  work_item_id: z.string().uuid().optional(),
}).strict();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schedulePatch = z.object({
  start_at: dateStr.optional(),
  target_at: dateStr.optional(),
}).strict().refine((s) => s.start_at !== undefined || s.target_at !== undefined,
  { message: "at least one of start_at/target_at required" });

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
      // date columns go out as text: pg would parse them to local-midnight Dates,
      // which JSON-serialize to the previous day in UTC.
      const items = await tx.query(
        `select id, title, status, kind, priority, parent_id, gh_issue_number, gh_repo,
                start_at::text, target_at::text, claimed_by, updated_at
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

  // GNT-8, deviation 4: the api never writes GitHub — it enqueues a sync job the
  // github worker executes through GithubBackbone (single GitHub writer).
  api.patch("/items/:id/schedule", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const parsed = schedulePatch.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid" });

    // Visibility check under RLS: 404 before anything is enqueued.
    const item = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select w.id, w.organisation_id, p.gh_installation_id
         from work_items w join projects p on p.id = w.project_id where w.id = $1`,
        [req.params.id])).rows[0] ?? null);
    if (item === null) return res.status(404).json({ error: "not found" });

    await deps.servicePool.query(
      `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)
       values ($1,$2,$3,'foreman.schedule_write',$4)`,
      [item.organisation_id, item.gh_installation_id ?? 0,
       `schedwrite:${item.id}:${Date.now()}`,
       JSON.stringify({ work_item_id: item.id, ...parsed.data })]);
    res.status(202).json({ queued: true });
  }));

  // AVW-5: directives are offers drained by the agent's heartbeat, never process control.
  api.post("/agents/:id/directives", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const parsed = directiveBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const d = parsed.data;
    if ((d.kind === "message" || d.kind === "request_checkpoint") && d.message === undefined) {
      return res.status(400).json({ error: "message required for this kind" });
    }
    if (d.kind === "cancel_item" && d.work_item_id === undefined) {
      return res.status(400).json({ error: "work_item_id required for cancel_item" });
    }
    const agent = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select organisation_id, project_id from agents where id = $1", [req.params.id])).rows[0] ?? null);
    if (agent === null) return res.status(404).json({ error: "not found" });

    const client = await deps.servicePool.connect();
    try {
      await client.query("begin");
      const ins = await client.query(
        `insert into directives (organisation_id, project_id, agent_id, kind, payload, created_by)
         values ($1,$2,$3,$4,$5,$6) returning id`,
        [agent.organisation_id, agent.project_id, req.params.id, d.kind,
         JSON.stringify({ ...(d.message !== undefined ? { message: d.message } : {}),
           ...(d.work_item_id !== undefined ? { work_item_id: d.work_item_id } : {}) }), userId]);
      await appendEvent(client, {
        organisation_id: agent.organisation_id, project_id: agent.project_id,
        type: "human.directed",
        payload: { actor_user_id: userId, target: req.params.id, directive: d.kind },
      });
      await client.query("commit");
      return res.status(201).json({ directive_id: ins.rows[0].id });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  api.patch("/items/:id/priority", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const priority = Number(req.body?.priority);
    if (!Number.isInteger(priority) || priority < 0) return res.status(400).json({ error: "priority must be a non-negative integer" });
    const item = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select organisation_id, project_id, priority from work_items where id = $1", [req.params.id])).rows[0] ?? null);
    if (item === null) return res.status(404).json({ error: "not found" });
    const client = await deps.servicePool.connect();
    try {
      await client.query("begin");
      await client.query("update work_items set priority = $2, updated_at=now() where id = $1", [req.params.id, priority]);
      await appendEvent(client, {
        organisation_id: item.organisation_id, project_id: item.project_id, work_item_id: req.params.id,
        type: "work.reprioritised", payload: { from: item.priority, to: priority },
      });
      await client.query("commit");
      return res.json({ ok: true });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  api.get("/projects/:id/checkpoints", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const checkpoints = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select c.id, c.work_item_id, w.title as work_item_title, c.question, c.options, c.context, c.created_at
         from checkpoints c join work_items w on w.id = c.work_item_id
         where c.project_id = $1 and c.status = 'open' order by c.created_at`, [req.params.id])).rows);
    res.json({ checkpoints });
  }));

  // BRF-5: answering here resolves the agent's checkpoint task on its next poll.
  api.post("/checkpoints/:id/answer", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
    if (answer === "") return res.status(400).json({ error: "answer required" });

    const visible = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        "select organisation_id, project_id from checkpoints where id = $1", [req.params.id])).rows[0] ?? null);
    if (visible === null) return res.status(404).json({ error: "not found" });

    const client = await deps.servicePool.connect();
    try {
      await client.query("begin");
      const upd = await client.query(
        `update checkpoints set status='answered', answer=$2, answered_by=$3, answered_at=now()
         where id = $1 and status = 'open'`, [req.params.id, answer, userId]);
      if (upd.rowCount === 0) { await client.query("rollback"); return res.status(409).json({ error: "already answered" }); }
      await appendEvent(client, {
        organisation_id: visible.organisation_id, project_id: visible.project_id,
        type: "human.decided",
        payload: { actor_user_id: userId, checkpoint_id: req.params.id, answer },
      });
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return res.json({ ok: true });
  }));

  api.get("/projects/:id/briefs", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const limit = Math.min(50, Number(req.query.limit ?? 10) || 10);
    const briefs = await withUser(deps.appPool, userId, async (tx) => {
      const rows = await tx.query(
        `select id, window_start, window_end, content, generated_at
         from briefs where project_id = $1 order by window_end desc limit $2`, [req.params.id, limit]);
      // BRF-6: delivery status from the brief.delivered audit trail
      const delivered = await tx.query(
        `select payload->>'brief_id' as brief_id, array_agg(distinct payload->>'channel') as channels
         from events where project_id = $1 and type = 'brief.delivered' group by 1`, [req.params.id]);
      const byBrief = new Map(delivered.rows.map((d: any) => [d.brief_id, d.channels]));
      return rows.rows.map((b: any) => ({ ...b, delivered: byBrief.get(b.id) ?? [] }));
    });
    res.json({ briefs });
  }));

  api.get("/projects/:id/overview", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const rows = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select section_id, version, content, sources, pinned, human_authored, updated_at
         from overview_sections where project_id = $1`, [req.params.id])).rows);
    const order = new Map(SECTIONS.map((s, i) => [s as string, i]));
    rows.sort((x: any, y: any) => (order.get(x.section_id) ?? 99) - (order.get(y.section_id) ?? 99));
    res.json({ sections: rows });
  }));

  // OVW-5: human override — edited content survives regeneration (pin it to be sure).
  api.put("/projects/:id/overview/:sectionId", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const sectionId = req.params.sectionId ?? "";
    if (!(SECTIONS as readonly string[]).includes(sectionId)) return res.status(400).json({ error: "unknown section" });
    const content = typeof req.body?.content === "string" ? req.body.content : undefined;
    const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : undefined;
    if (content === undefined && pinned === undefined) return res.status(400).json({ error: "content or pinned required" });

    const section = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select s.organisation_id, s.version, s.sources from overview_sections s
         where s.project_id = $1 and s.section_id = $2`, [req.params.id, sectionId])).rows[0] ?? null);
    if (section === null) return res.status(404).json({ error: "section not published yet" });

    const client = await deps.servicePool.connect();
    try {
      await client.query("begin");
      const version = content !== undefined ? Number(section.version) + 1 : Number(section.version);
      await client.query(
        `update overview_sections set
           content = coalesce($3, content),
           pinned = coalesce($4, pinned),
           human_authored = case when $3 is not null then true else human_authored end,
           version = $5, updated_at = now()
         where project_id = $1 and section_id = $2`,
        [req.params.id, sectionId, content ?? null, pinned ?? null, version]);
      if (content !== undefined) {
        await client.query(
          `insert into overview_revisions (organisation_id, project_id, section_id, version, content, sources, caused_by)
           values ($1,$2,$3,$4,$5,$6,'human')`,
          [section.organisation_id, req.params.id, sectionId, version, content, JSON.stringify(section.sources)]);
      }
      await appendEvent(client, {
        organisation_id: section.organisation_id, project_id: req.params.id,
        type: "human.overrode",
        payload: { actor_user_id: userId, subject: `overview:${sectionId}` },
      });
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return res.json({ ok: true });
  }));

  api.get("/projects/:id/overview/:sectionId/revisions", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const revisions = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select version, content, caused_by, created_at from overview_revisions
         where project_id = $1 and section_id = $2 order by version desc limit 20`,
        [req.params.id, req.params.sectionId])).rows);
    res.json({ revisions });
  }));

  api.post("/projects/:id/overview/regenerate", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const visible = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select 1 from projects where id = $1", [req.params.id])).rowCount !== 0);
    if (!visible) return res.status(404).json({ error: "not found" });
    const result = await regenerateOverview(deps.servicePool, req.params.id ?? "", {
      llm: llmFromEnv(), causedBy: "manual",
    });
    res.json(result);
  }));

  api.get("/projects/:id/comm-graph", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const graph = await withUser(deps.appPool, userId, async (tx) => {
      const nodes = await tx.query(
        `select id, display_name, platform, status, parent_agent_id
         from agents where project_id = $1 order by display_name`, [req.params.id]);
      const edges = await tx.query(
        `select coalesce(payload->>'parent_agent_id', payload->>'from_agent_id') as from_id,
                coalesce(payload->>'child_agent_id', payload->>'to_agent_id') as to_id,
                case when type = 'comm.message_sent' then 'message' else 'spawn' end as kind,
                count(*)::int as count
         from events
         where project_id = $1 and type in ('comm.subagent_spawned', 'comm.message_sent')
         group by 1, 2, 3 having coalesce(payload->>'child_agent_id', payload->>'to_agent_id') is not null
         order by 1, 2, 3`, [req.params.id]);
      return {
        nodes: nodes.rows,
        edges: edges.rows.map((e: any) => ({
          from: e.from_id ?? null, to: e.to_id, kind: e.kind, count: e.count,
        })),
      };
    });
    res.json(graph);
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
