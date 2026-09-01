import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createTestDatabase } from "./testing.js";

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
