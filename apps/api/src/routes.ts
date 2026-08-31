import type express from "express";
import { z } from "zod";
import { appendEvent, enqueueWorkItem, createAgentToken, revokeAgentToken } from "@foreman/db";
import { SECTIONS, regenerateOverview, llmFromEnv } from "foreman-gen/lib";
import { withUser } from "./rls.js";
import type { ApiDeps, AuthedRequest } from "./http.js";

const directiveBody = z.object({
  kind: z.enum(["pause", "resume", "cancel_item", "message", "request_checkpoint"]),
  message: z.string().min(1).optional(),
  work_item_id: z.string().uuid().optional(),
}).strict();

const validTimezone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};

const settingsBody = z.object({
  name: z.string().min(1).optional(),
  gh_repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional(),
  gh_installation_id: z.number().int().nullable().optional(),
  gh_project_node_id: z.string().min(1).nullable().optional(),
  wip_limit: z.number().int().min(1).optional(),
  stall_threshold_sec: z.number().int().min(60).optional(),
  brief_schedule: z.enum(["daily", "weekly"]).nullable().optional(),
  brief_timezone: z.string().refine(validTimezone, "unknown IANA timezone").optional(),
  brief_webhook_url: z.string().url().nullable().optional(),
  brief_email: z.string().email().nullable().optional(),
}).strict();

const newItemBody = z.object({
  title: z.string().min(1),
  intent: z.string().optional(),
  kind: z.enum(["epic", "story", "task", "bug", "chore"]).optional(),
  priority: z.number().int().min(0).optional(),
  acceptance: z.array(z.string()).optional(),
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

  // §2.2 from the UI: local projects enqueue directly; GitHub-connected ones go
  // through the github worker (single GitHub writer), 202 + SSE confirms.
  api.post("/projects/:id/items", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const parsed = newItemBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const proj = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        "select organisation_id, gh_repos, gh_installation_id from projects where id = $1", [req.params.id])).rows[0] ?? null);
    if (proj === null) return res.status(404).json({ error: "not found" });

    const connected = (proj.gh_repos ?? []).length > 0 && proj.gh_installation_id !== null;
    if (connected) {
      await deps.servicePool.query(
        `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)
         values ($1,$2,$3,'foreman.create_item',$4)`,
        [proj.organisation_id, proj.gh_installation_id,
         `createitem:${req.params.id}:${Date.now()}`,
         JSON.stringify({ project_id: req.params.id, ...parsed.data })]);
      return res.status(202).json({ queued: true });
    }
    const item = await enqueueWorkItem(deps.servicePool, {
      organisationId: proj.organisation_id, projectId: req.params.id ?? "",
      title: parsed.data.title,
      ...(parsed.data.intent !== undefined ? { intent: parsed.data.intent } : {}),
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
      ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
      acceptance: parsed.data.acceptance ?? [],
    });
    return res.status(201).json({ work_item_id: item.id });
  }));

  api.get("/projects/:id/tokens", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const tokens = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select t.id, t.created_at, t.last_used_at, t.revoked_at, a.display_name as agent_name
         from agent_tokens t left join agents a on a.id = t.agent_id
         where t.project_id = $1 order by t.created_at desc`, [req.params.id])).rows);
    res.json({ tokens });
  }));

  // The raw token appears exactly once, in this response.
  api.post("/projects/:id/tokens", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const proj = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select organisation_id from projects where id = $1", [req.params.id])).rows[0] ?? null);
    if (proj === null) return res.status(404).json({ error: "not found" });
    const minted = await createAgentToken(deps.servicePool, {
      organisationId: proj.organisation_id, projectId: req.params.id ?? "" });
    return res.status(201).json({ token_id: minted.id, token: minted.token });
  }));

  api.delete("/tokens/:id", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const visible = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select 1 from agent_tokens where id = $1", [req.params.id])).rowCount !== 0);
    if (!visible) return res.status(404).json({ error: "not found" });
    await revokeAgentToken(deps.servicePool, req.params.id ?? "");
    return res.json({ ok: true });
  }));

  api.get("/orgs/:orgId/installations", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const installations = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select installation_id, app_id, account_login, created_at from github_installations
         where organisation_id = $1 order by created_at desc`, [req.params.orgId])).rows);
    res.json({ installations });
  }));

  // Closes the quickstart's "manual-SQL gap": repos/board linking + thresholds +
  // brief config, validated before anything silently misbehaves.
  api.patch("/projects/:id/settings", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const parsed = settingsBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const fields = Object.keys(parsed.data);
    if (fields.length === 0) return res.status(400).json({ error: "no fields" });

    const proj = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select organisation_id from projects where id = $1", [req.params.id])).rows[0] ?? null);
    if (proj === null) return res.status(404).json({ error: "not found" });

    if (parsed.data.gh_installation_id !== undefined && parsed.data.gh_installation_id !== null) {
      const inst = await deps.servicePool.query(
        "select 1 from github_installations where installation_id = $1 and organisation_id = $2",
        [parsed.data.gh_installation_id, proj.organisation_id]);
      if (inst.rowCount === 0) return res.status(400).json({ error: "installation does not belong to this organisation" });
    }

    const client = await deps.servicePool.connect();
    try {
      await client.query("begin");
      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
      const updated = await client.query(
        `update projects set ${sets} where id = $1 returning *`,
        [req.params.id, ...fields.map((f) => (parsed.data as Record<string, unknown>)[f])]);
      await appendEvent(client, {
        organisation_id: proj.organisation_id, project_id: req.params.id,
        type: "project.updated", payload: { fields },
      });
      await client.query("commit");
      return res.json({ project: updated.rows[0] });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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

  api.get("/projects/:id/lifecycle", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const endpoints = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        `select id, gh_repo, method, path, state, evidence, work_item_ids, in_spec, has_impl, has_test, state_changed_at
         from endpoints where project_id = $1 order by path, method`, [req.params.id])).rows);
    // LFC-4: three set differences over the flags
    const gaps = {
      untested: endpoints.filter((e: any) => e.has_impl && !e.has_test && e.state !== "deprecated").length,
      unimplemented: endpoints.filter((e: any) => e.in_spec && !e.has_impl && e.state !== "deprecated").length,
      unspecced: endpoints.filter((e: any) => e.has_impl && !e.in_spec && e.state !== "deprecated").length,
    };
    res.json({ endpoints, gaps });
  }));

  api.post("/projects/:id/lifecycle/scan", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const proj = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query(
        "select organisation_id, gh_installation_id from projects where id = $1", [req.params.id])).rows[0] ?? null);
    if (proj === null) return res.status(404).json({ error: "not found" });
    await deps.servicePool.query(
      `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, payload)
       values ($1,$2,$3,'foreman.lifecycle_scan',$4)`,
      [proj.organisation_id, proj.gh_installation_id ?? 0,
       `lifecycle:${req.params.id}:${Date.now()}`, JSON.stringify({ project_id: req.params.id })]);
    return res.status(202).json({ queued: true });
  }));

  // PRD §1.7 — deterministic reads over the event log; `now` is caller-suppliable
  // so the numbers are reproducible (BRF-7 spirit).
  // Memo lesson 4: your events, your Postgres. The whole project log, id-ordered.
  api.get("/projects/:id/export", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const visible = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select 1 from projects where id = $1", [req.params.id])).rowCount !== 0);
    if (!visible) return res.status(404).json({ error: "not found" });
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "content-disposition": `attachment; filename=foreman-events-${req.params.id}.ndjson`,
    });
    await withUser(deps.appPool, userId, async (tx) => {
      let cursor = "0";
      for (;;) {
        const batch = await tx.query(
          "select * from events where project_id = $1 and id > $2 order by id limit 500",
          [req.params.id, cursor]);
        if (batch.rowCount === 0) break;
        for (const row of batch.rows) res.write(JSON.stringify(row) + "\n");
        cursor = String(batch.rows[batch.rows.length - 1].id);
      }
    });
    res.end();
  }));

  api.get("/projects/:id/metrics", wrap(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const nowParam = typeof req.query.now === "string" ? Date.parse(req.query.now) : NaN;
    const now = Number.isNaN(nowParam) ? new Date() : new Date(nowParam);
    const week = (n: number) => new Date(now.getTime() - n * 7 * 86400_000);
    const dayAgo = new Date(now.getTime() - 86400_000);

    const body = await withUser(deps.appPool, userId, async (tx) => {
      const proj = await tx.query("select 1 from projects where id = $1", [req.params.id]);
      if (proj.rowCount === 0) return null;
      const p = req.params.id;

      const completions = await tx.query(
        `select
           count(*) filter (where occurred_at >= $2 and occurred_at < $3
             and jsonb_array_length(payload->'acceptance_results') > 0)::int as this_week,
           count(*) filter (where occurred_at >= $4 and occurred_at < $2
             and jsonb_array_length(payload->'acceptance_results') > 0)::int as last_week,
           count(*) filter (where occurred_at >= $2 and occurred_at < $3)::int as all_this_week
         from events where project_id = $1 and type = 'work.completed'`,
        [p, week(1), now, week(2)]);

      const stalls = await tx.query(
        `select extract(epoch from (recorded_at - (payload->>'last_transition_at')::timestamptz)) * 1000 as ms
         from events where project_id = $1 and type = 'agent.stalled'
           and occurred_at >= $2 and occurred_at < $3 order by ms`, [p, week(1), now]);
      const stallMs = stalls.rows.map((r: any) => Math.round(Number(r.ms)));

      const active = await tx.query(
        `select count(distinct agent_id)::int as n from events
         where project_id = $1 and agent_id is not null and recorded_at >= $2 and recorded_at < $3`,
        [p, dayAgo, now]);

      const decisions = await tx.query(
        "select count(*)::int as n from checkpoints where project_id = $1 and status = 'open'", [p]);

      const briefs = await tx.query(
        `select
           count(*) filter (where type = 'brief.generated')::int as generated,
           count(distinct payload->>'brief_id') filter (where type = 'brief.delivered')::int as delivered
         from events where project_id = $1 and occurred_at >= $2 and occurred_at < $3`, [p, week(1), now]);

      const cost = await tx.query(
        `select
           coalesce(sum(cost_usd) filter (where started_at >= $2 and started_at < $3), 0) as usd,
           coalesce(sum(cost_usd) filter (where started_at >= $4 and started_at < $2), 0) as previous
         from runs r join agents a on a.id = r.agent_id where a.project_id = $1`,
        [p, week(1), now, week(2)]);

      const leases = await tx.query(
        `select count(*)::int as n from events where project_id = $1 and type = 'work.lease_expired'
           and occurred_at >= $2 and occurred_at < $3`, [p, week(1), now]);

      const pick = (xs: number[], q: number) =>
        xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;
      return {
        supervised_throughput: {
          this_week: completions.rows[0].this_week,
          last_week: completions.rows[0].last_week,
          all_completions_this_week: completions.rows[0].all_this_week,
          method: "completions with acceptance verdicts",
        },
        stall_detection: stallMs.length === 0 ? null : {
          median_ms: pick(stallMs, 0.5), p95_ms: pick(stallMs, 0.95), samples: stallMs.length,
        },
        active_agents_24h: active.rows[0].n,
        open_decisions: decisions.rows[0].n,
        briefs_7d: { generated: briefs.rows[0].generated, delivered: briefs.rows[0].delivered },
        cost_7d: { usd: Number(cost.rows[0].usd).toFixed(2), previous_usd: Number(cost.rows[0].previous).toFixed(2) },
        lease_expiries_7d: leases.rows[0].n,
      };
    });
    if (body === null) return res.status(404).json({ error: "not found" });
    return res.json(body);
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
