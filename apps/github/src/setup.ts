import crypto from "node:crypto";
import type express from "express";
import type pg from "pg";
import { sealPem } from "./crypto.js";

// WL-6 manifest flow (§5.6), living in apps/github because this service owns all
// GitHub credentials. Deviation 5: PEM goes into github_apps like the seed script;
// KMS envelope encryption is a hardening-phase task.

const hmac = (v: string, secret: string) =>
  crypto.createHmac("sha256", `state:${secret}`).update(v).digest("hex");

export function signState(orgId: string, secret: string): string {
  return `${orgId}.${hmac(orgId, secret)}`;
}

export function verifyState(state: string | undefined, secret: string): string | null {
  if (state === undefined) return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const orgId = state.slice(0, dot);
  const got = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(hmac(orgId, secret));
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  return orgId;
}

export interface SetupOpts {
  pool: pg.Pool;
  secret: string;
  publicUrl: string;
  githubBase?: string;   // default https://github.com
  apiBase?: string;      // default https://api.github.com
  fetchImpl?: typeof fetch;
  masterKey?: string;    // when set, App private keys are sealed at rest (hardening)
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// Express 4 does not forward a rejected promise from an async handler to
// error middleware on its own — an unwrapped throw here becomes an
// unhandledRejection that crashes the process instead of returning a 500.
// Mirrors apps/api/src/routes.ts's wrap().
const wrap = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function mountSetup(app: express.Express, opts: SetupOpts): void {
  const githubBase = opts.githubBase ?? "https://github.com";
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const f = opts.fetchImpl ?? fetch;

  app.get("/setup/github/start", wrap(async (req, res) => {
    const orgSlug = String(req.query.org_slug ?? "");
    const ghOrg = String(req.query.gh_org ?? "");
    if (orgSlug === "" || ghOrg === "") return res.status(400).send("org_slug and gh_org required");
    const org = await opts.pool.query("select id from organisations where slug = $1", [orgSlug]);
    if (org.rowCount === 0) return res.status(404).send("unknown organisation");
    const state = signState(org.rows[0].id, opts.secret);

    // §5.6 step 1: form POSTs the manifest to GitHub; GitHub redirects back with a code.
    const manifest = {
      name: `foreman-${orgSlug}`,
      url: opts.publicUrl,
      hook_attributes: { url: `${opts.publicUrl}/webhook`, active: true },
      redirect_url: `${opts.publicUrl}/setup/github/callback`,
      public: false,
      default_permissions: {
        issues: "write", pull_requests: "read", organization_projects: "admin",
        checks: "read", deployments: "read",
      },
      default_events: [
        "issues", "pull_request", "pull_request_review", "projects_v2_item",
        "check_run", "deployment_status",
      ],
    };
    const action = `${githubBase}/organizations/${encodeURIComponent(ghOrg)}/settings/apps/new?state=${encodeURIComponent(state)}`;
    res.status(200).send(`<!doctype html>
<title>Connect GitHub — Foreman</title>
<h1>Create the Foreman GitHub App in ${esc(ghOrg)}</h1>
<p>This creates a GitHub App owned by your organisation. You'll be sent back here afterwards.</p>
<form action="${esc(action)}" method="post">
  <input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
  <button type="submit">Create GitHub App</button>
</form>`);
  }));

  app.get("/setup/github/callback", wrap(async (req, res) => {
    const orgId = verifyState(typeof req.query.state === "string" ? req.query.state : undefined, opts.secret);
    if (orgId === null) return res.status(401).send("bad state");
    const code = String(req.query.code ?? "");
    if (code === "") return res.status(400).send("missing code");

    // §5.6 step 3 (verified item 4: client_id/client_secret/pem/webhook_secret all present).
    const conv = await f(`${apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST", headers: { accept: "application/vnd.github+json" },
    });
    if (conv.status !== 201) return res.status(502).send(`conversion failed: ${conv.status}`);
    const body = (await conv.json()) as {
      id: number; slug: string; pem: string; webhook_secret: string;
      client_id?: string; client_secret?: string;
    };
    const pemStored = opts.masterKey !== undefined ? sealPem(body.pem, opts.masterKey) : body.pem;
    await opts.pool.query(
      `insert into github_apps (app_id, organisation_id, slug, private_key_pem, webhook_secret, client_id, client_secret)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (app_id) do update set private_key_pem = excluded.private_key_pem,
         webhook_secret = excluded.webhook_secret, slug = excluded.slug,
         client_id = excluded.client_id, client_secret = excluded.client_secret`,
      [body.id, orgId, body.slug, pemStored, body.webhook_secret, body.client_id ?? null, body.client_secret ?? null]);

    const state = typeof req.query.state === "string" ? req.query.state : "";
    res.redirect(302, `${githubBase}/apps/${body.slug}/installations/new?state=${encodeURIComponent(state)}`);
  }));

  app.get("/setup/github/install-callback", wrap(async (req, res) => {
    const orgId = verifyState(typeof req.query.state === "string" ? req.query.state : undefined, opts.secret);
    if (orgId === null) return res.status(401).send("bad state");
    const installationId = Number(req.query.installation_id);
    if (!Number.isInteger(installationId)) return res.status(400).send("missing installation_id");

    const appRow = await opts.pool.query(
      "select app_id from github_apps where organisation_id = $1 order by created_at desc limit 1", [orgId]);
    if (appRow.rowCount === 0) return res.status(409).send("no app registered for this organisation");

    await opts.pool.query(
      `insert into github_installations (installation_id, app_id, organisation_id)
       values ($1,$2,$3)
       on conflict (installation_id) do update set app_id = excluded.app_id,
         organisation_id = excluded.organisation_id`,
      [installationId, appRow.rows[0].app_id, orgId]);
    res.status(200).send("<!doctype html><title>Foreman</title><h1>GitHub App installed — you can close this tab.</h1>");
  }));
}
