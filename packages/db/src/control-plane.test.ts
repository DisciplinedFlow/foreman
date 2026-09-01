import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createTestDatabase, seedOrgWithUser } from "./testing.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function withUser(url: string, user: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = user;
  return u.toString();
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("control plane (WL-8)", () => {
  it("foreman_app cannot insert or delete organisations; foreman_control can", async () => {
    const db = await createTestDatabase();
    try {
      const appClient = new pg.Client({ connectionString: db.appUrl });
      await appClient.connect();
      try {
        await expect(
          appClient.query("insert into organisations (slug) values ($1)", ["denied-org"])
        ).rejects.toThrow(/permission denied/);
        await expect(
          appClient.query("delete from organisations where slug = $1", ["nope"])
        ).rejects.toThrow(/permission denied/);
      } finally { await appClient.end(); }

      const controlClient = new pg.Client({ connectionString: withUser(db.url, "foreman_control") });
      await controlClient.connect();
      try {
        const ins = await controlClient.query(
          "insert into organisations (slug) values ($1) returning id", ["allowed-org"]);
        expect(ins.rowCount).toBe(1);
        const del = await controlClient.query(
          "delete from organisations where id = $1", [ins.rows[0].id]);
        expect(del.rowCount).toBe(1);
      } finally { await controlClient.end(); }
    } finally { await db.teardown(); }
  });

  it("foreman_app cannot write usage_records but can select its own org's rows (X-4, RLS select-only policy)", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, userId } = await seedOrgWithUser(db.servicePool, "usage-rls");
      await db.servicePool.query(
        `insert into usage_records (organisation_id, period_start, period_end, metric, value)
         values ($1, current_date, current_date, 'seats', 1)`, [orgId]);

      const appClient = new pg.Client({ connectionString: db.appUrl });
      await appClient.connect();
      try {
        await appClient.query("select set_config('app.user_id', $1, false)", [userId]);

        // 0002's `alter default privileges` grants foreman_app insert/update on
        // every new table, including usage_records — the write-isolation for
        // this table rests entirely on RLS having no policy for insert/update,
        // not on a table-level revoke. Pin both failure modes so migration or
        // privilege drift trips this test instead of silently reopening writes.
        await expect(
          appClient.query(
            `insert into usage_records (organisation_id, period_start, period_end, metric, value)
             values ($1, current_date, current_date, 'events_ingested', 99)`, [orgId])
        ).rejects.toThrow(/row-level security/);

        const update = await appClient.query(
          `update usage_records set value = 999 where organisation_id = $1 and metric = 'seats'`, [orgId]);
        expect(update.rowCount).toBe(0);

        const select = await appClient.query(
          "select metric, value from usage_records where organisation_id = $1", [orgId]);
        expect(select.rows).toEqual([{ metric: "seats", value: "1" }]);
      } finally { await appClient.end(); }
    } finally { await db.teardown(); }
  });

  it("no app-plane source references the control-plane credential or role", () => {
    const dirs = ["api", "github", "ingest", "mcp", "scheduler", "projector", "gen", "web"]
      .map((app) => path.join(REPO_ROOT, "apps", app, "src"));
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const file of listFilesRecursive(dir)) {
        const content = fs.readFileSync(file, "utf8");
        if (content.includes("FOREMAN_CONTROL_TOKEN") || content.includes("foreman_control")) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
