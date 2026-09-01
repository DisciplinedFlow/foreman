// Deviations 1/3: manifest-flow UI and install-from-UI linking are Phase 3 — this
// script is the only place App credentials come from env (WL-6 keeps them out of
// library/handler code entirely).
import { readFileSync } from "node:fs";
import pg from "pg";
import { sealPem, resolveMasterKey } from "../src/crypto.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === "") { console.error(`missing ${name}`); process.exit(1); }
  return v;
};

const appId = Number(env("FOREMAN_GH_APP_ID"));
const masterKey = await resolveMasterKey();
const rawPem = readFileSync(env("FOREMAN_GH_PEM_PATH"), "utf8");
const pem = masterKey !== undefined ? sealPem(rawPem, masterKey) : rawPem;
const webhookSecret = env("FOREMAN_GH_WEBHOOK_SECRET");
const installationId = Number(env("FOREMAN_GH_INSTALLATION_ID"));
const orgSlug = env("FOREMAN_ORG_SLUG");
const slug = process.env.FOREMAN_GH_APP_SLUG ?? "foreman";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

const org = await pool.query("select id from organisations where slug = $1", [orgSlug]);
if (org.rowCount === 0) { console.error(`no organisation with slug ${orgSlug}`); process.exit(1); }

await pool.query(
  `insert into github_apps (app_id, slug, private_key_pem, webhook_secret)
   values ($1,$2,$3,$4)
   on conflict (app_id) do update set private_key_pem = excluded.private_key_pem,
     webhook_secret = excluded.webhook_secret, slug = excluded.slug`,
  [appId, slug, pem, webhookSecret]);
await pool.query(
  `insert into github_installations (installation_id, app_id, organisation_id)
   values ($1,$2,$3) on conflict (installation_id) do update set app_id = excluded.app_id,
     organisation_id = excluded.organisation_id`,
  [installationId, appId, org.rows[0].id]);

console.log(`seeded app ${appId} + installation ${installationId} for org ${orgSlug}`);
await pool.end();
