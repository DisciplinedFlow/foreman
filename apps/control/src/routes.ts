import type express from "express";
import { z } from "zod";
import { meterUsage } from "@foreman/db";
import type { ControlDeps } from "./http.js";

const TIERS = ["free", "team", "business", "oem"] as const;
const ISOLATIONS = ["pooled", "siloed"] as const;

const tenantBody = z.object({
  slug: z.string().min(1),
  tier: z.enum(TIERS),
  isolation: z.enum(ISOLATIONS).optional(),
  owner_email: z.string().email(),
}).strict();

const tenantPatch = z.object({
  tier: z.enum(TIERS).optional(),
  isolation: z.enum(ISOLATIONS).optional(),
}).strict().refine((s) => s.tier !== undefined || s.isolation !== undefined,
  { message: "at least one of tier/isolation required" });

const meteringBody = z.object({
  period_start: z.string(),
  period_end: z.string(),
}).strict();

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string } | null)?.code === "23505";
const uuidParam = z.string().uuid();

// WL-8/WL-9: this router only ever runs behind the foreman_control role, and
// only apps/control connects that way — the app plane can't reach it (see
// migration 0008 and packages/db/src/control-plane.test.ts).
export function mountRoutes(app: express.Express, deps: ControlDeps): void {
  const wrap = (fn: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.post("/tenants", wrap(async (req, res) => {
    const parsed = tenantBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const { slug, tier, isolation, owner_email } = parsed.data;

    const client = await deps.pool.connect();
    try {
      await client.query("begin");
      const org = await client.query(
        `insert into organisations (slug, tier, isolation)
         values ($1, $2, coalesce($3, 'pooled')) returning id`,
        [slug, tier, isolation ?? null]);
      const organisationId = org.rows[0].id;

      const user = await client.query(
        `insert into users (email) values ($1)
         on conflict (email) do update set email = excluded.email
         returning id`,
        [owner_email]);
      const userId = user.rows[0].id;

      await client.query(
        "insert into organisation_members (organisation_id, user_id, role) values ($1,$2,'owner')",
        [organisationId, userId]);

      await client.query("commit");
      return res.status(201).json({ organisation_id: organisationId, user_id: userId });
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if (isUniqueViolation(err)) return res.status(409).json({ error: "slug already exists" });
      throw err;
    } finally {
      client.release();
    }
  }));

  app.patch("/tenants/:id", wrap(async (req, res) => {
    // A malformed id would otherwise reach Postgres as `... = 'not-a-uuid'`
    // and raise 22P02 (invalid_text_representation) — validate up front so
    // an unrecognisable id gets the same 404 JSON shape as an unknown one.
    if (!uuidParam.safeParse(req.params.id).success) return res.status(404).json({ error: "not found" });
    const parsed = tenantPatch.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const fields = Object.keys(parsed.data);
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
    const updated = await deps.pool.query(
      `update organisations set ${sets} where id = $1 returning *`,
      [req.params.id, ...fields.map((f) => (parsed.data as Record<string, unknown>)[f])]);
    if (updated.rowCount === 0) return res.status(404).json({ error: "not found" });
    return res.json(updated.rows[0]);
  }));

  app.post("/metering/run", wrap(async (req, res) => {
    const parsed = meteringBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid" });
    const records = await meterUsage(deps.pool, {
      start: new Date(parsed.data.period_start),
      end: new Date(parsed.data.period_end),
    });
    return res.json({ records });
  }));

  app.get("/tenants/:id/usage", wrap(async (req, res) => {
    if (!uuidParam.safeParse(req.params.id).success) return res.status(404).json({ error: "not found" });
    const from = typeof req.query.from === "string" ? req.query.from : null;
    const to = typeof req.query.to === "string" ? req.query.to : null;
    const rows = await deps.pool.query(
      `select id, organisation_id, period_start, period_end, metric, value, created_at
       from usage_records
       where organisation_id = $1
         and ($2::date is null or period_start >= $2::date)
         and ($3::date is null or period_start <= $3::date)
       order by metric`,
      [req.params.id, from, to]);
    return res.json({ usage: rows.rows });
  }));
}
