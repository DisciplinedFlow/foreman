import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export async function migrate(client: pg.Client | pg.PoolClient, dir = MIGRATIONS_DIR): Promise<string[]> {
  await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const files = (await fs.readdir(dir)).filter(f => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const f of files) {
    const seen = await client.query("select 1 from schema_migrations where name = $1", [f]);
    if (seen.rowCount) continue;
    const sql = await fs.readFile(path.join(dir, f), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [f]);
      await client.query("commit");
    } catch (e) { await client.query("rollback"); throw new Error(`migration ${f} failed: ${(e as Error).message}`); }
    applied.push(f);
  }
  return applied;
}
