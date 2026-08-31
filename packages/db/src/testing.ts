import crypto from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.js";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL
  ?? "postgres://postgres:postgres@localhost:5433/postgres";

function withDb(url: string, db: string, user?: string, pass?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = pass ?? user; }
  return u.toString();
}

export interface TestDb {
  adminPool: pg.Pool;
  servicePool: pg.Pool;
  appUrl: string;
  url: string;
  rerunMigrations(): Promise<string[]>;
  teardown(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDb> {
  const name = `foreman_test_${crypto.randomBytes(8).toString("hex")}`;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`create database ${name}`);
  await root.end();

  const url = withDb(ADMIN_URL, name);
  const adminPool = new pg.Pool({ connectionString: url, max: 5 });
  const c = await adminPool.connect();
  try { await migrate(c); } finally { c.release(); }

  const servicePool = new pg.Pool({ connectionString: withDb(ADMIN_URL, name, "foreman_service"), max: 20 });
  const appUrl = withDb(ADMIN_URL, name, "foreman_app");

  return {
    adminPool, servicePool, appUrl, url,
    async rerunMigrations() {
      const cc = await adminPool.connect();
      try { return await migrate(cc); } finally { cc.release(); }
    },
    async teardown() {
      await servicePool.end();
      await adminPool.end();
      const r = new pg.Client({ connectionString: ADMIN_URL });
      await r.connect();
      await r.query(`drop database if exists ${name} with (force)`);
      await r.end();
    },
  };
}

export async function seedOrgWithUser(pool: pg.Pool, slug: string): Promise<{ orgId: string; userId: string; projectId: string }> {
  const org = await pool.query("insert into organisations (slug) values ($1) returning id", [slug]);
  const user = await pool.query("insert into users (email) values ($1) returning id", [`${slug}@test.local`]);
  await pool.query("insert into organisation_members (organisation_id, user_id, role) values ($1,$2,'owner')",
    [org.rows[0].id, user.rows[0].id]);
  const project = await pool.query("insert into projects (organisation_id, name) values ($1,$2) returning id",
    [org.rows[0].id, `${slug}-project`]);
  return { orgId: org.rows[0].id, userId: user.rows[0].id, projectId: project.rows[0].id };
}
