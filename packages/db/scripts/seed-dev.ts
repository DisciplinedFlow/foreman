// Dev seed: idempotently creates org `dev` / user dev@localhost / project
// `dev-project`, mints an agent token, prints everything the quickstart needs.
// Usage: pnpm db:seed
import crypto from "node:crypto";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/foreman";
const pool = new pg.Pool({ connectionString: url });

const org = await pool.query(
  `insert into organisations (slug) values ('dev')
   on conflict (slug) do update set slug = excluded.slug returning id`);
const orgId = org.rows[0].id;

const user = await pool.query(
  `insert into users (email, display_name) values ('dev@localhost', 'Dev User')
   on conflict (email) do update set email = excluded.email returning id`);
const userId = user.rows[0].id;

await pool.query(
  `insert into organisation_members (organisation_id, user_id, role) values ($1,$2,'owner')
   on conflict do nothing`, [orgId, userId]);

const existing = await pool.query(
  "select id from projects where organisation_id = $1 and name = 'dev-project'", [orgId]);
const projectId = existing.rowCount
  ? existing.rows[0].id
  : (await pool.query(
      "insert into projects (organisation_id, name) values ($1, 'dev-project') returning id", [orgId])).rows[0].id;

// mint a fresh agent token each run (same shape as apps/mcp/src/auth.ts)
const token = "fmn_agt_" + crypto.randomBytes(24).toString("base64url");
await pool.query(
  "insert into agent_tokens (organisation_id, project_id, token_hash) values ($1,$2,$3)",
  [orgId, projectId, crypto.createHash("sha256").update(token).digest("hex")]);

console.log("seeded:");
console.log(`  org         dev            ${orgId}`);
console.log(`  user        dev@localhost  ${userId}   (log into the web UI with this email)`);
console.log(`  project     dev-project    ${projectId}`);
console.log(`  agent token ${token}`);
console.log("    → use as the Claude Code plugin's `token`, or as Authorization: Bearer for /mcp and /ingest/hook");
await pool.end();
