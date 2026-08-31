import { describe, expect, it } from "vitest";
import pg from "pg";
import { createTestDatabase, seedOrgWithUser } from "./testing.js";

describe("RLS", () => {
  it("guard: every organisation_id table has RLS enabled and a policy", async () => {
    const db = await createTestDatabase();
    try {
      const r = await db.adminPool.query(`
        select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind in ('r','p')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organisation_id' and not a.attisdropped)
          and (not c.relrowsecurity
               or not exists (select 1 from pg_policy p where p.polrelid = c.oid))`);
      expect(r.rows).toEqual([]); // any row here is an unprotected tenant table
    } finally { await db.teardown(); }
  });

  it("blocks cross-tenant reads and writes for foreman_app", async () => {
    const db = await createTestDatabase();
    try {
      const a = await seedOrgWithUser(db.servicePool, "org-a");
      const b = await seedOrgWithUser(db.servicePool, "org-b");
      await db.servicePool.query(
        "insert into projects (organisation_id, name) values ($1,'secret-b')", [b.orgId]);

      const appClient = new pg.Client({ connectionString: db.appUrl });
      await appClient.connect();
      try {
        await appClient.query("select set_config('app.user_id', $1, false)", [a.userId]);
        const read = await appClient.query("select * from projects");
        expect(read.rows.every(r => r.organisation_id === a.orgId)).toBe(true);
        expect(read.rows.find(r => r.name === "secret-b")).toBeUndefined();
        await expect(
          appClient.query("insert into projects (organisation_id, name) values ($1,'evil')", [b.orgId])
        ).rejects.toThrow(); // with check violation
      } finally { await appClient.end(); }
    } finally { await db.teardown(); }
  });

  it("SEC-1: a forged pg_temp organisation_members table cannot defeat is_member", async () => {
    const db = await createTestDatabase();
    try {
      const a = await seedOrgWithUser(db.servicePool, "org-a-temp");
      const b = await seedOrgWithUser(db.servicePool, "org-b-temp");
      await db.servicePool.query(
        "insert into projects (organisation_id, name) values ($1,'secret-b-temp')", [b.orgId]);

      const appClient = new pg.Client({ connectionString: db.appUrl });
      await appClient.connect();
      try {
        await appClient.query("select set_config('app.user_id', $1, false)", [a.userId]);
        // Attempt to shadow the real organisation_members table via search_path's implicit
        // pg_temp-first lookup, forging membership in org B for org A's user.
        await appClient.query("create temp table organisation_members (organisation_id uuid, user_id uuid)");
        await appClient.query(
          "insert into organisation_members (organisation_id, user_id) values ($1,$2)", [b.orgId, a.userId]);

        const read = await appClient.query("select * from projects");
        expect(read.rows.every(r => r.organisation_id === a.orgId)).toBe(true);
        expect(read.rows.find(r => r.name === "secret-b-temp")).toBeUndefined();
      } finally { await appClient.end(); }
    } finally { await db.teardown(); }
  });
});
