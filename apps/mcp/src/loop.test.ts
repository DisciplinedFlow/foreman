import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestDatabase, seedOrgWithUser } from "@foreman/db/testing";
import { enqueueWorkItem } from "@foreman/db";
import type pg from "pg";
import { createAgentToken } from "./auth.js";
import { createApp } from "./http.js";

async function startServer(pool: pg.Pool) {
  const app = createApp(pool);
  const server = app.listen(0);
  await new Promise(r => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise(r => server.close(r)) };
}

describe("MCP full agent loop", () => {
  it("announce → claim(empty) → claim(assigned) → report → complete", async () => {
    const db = await createTestDatabase();
    const srv = await startServer(db.servicePool);
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "loop");
      const { token } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId });

      const client = new Client({ name: "test-agent", version: "0.0.1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(srv.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }));

      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError ?? false).toBe(false);
        return JSON.parse((r.content as { type: string; text: string }[])[0]!.text);
      };

      const hello = await call("foreman__agent_announce",
        { display_name: "loop-agent", platform: "test", capabilities: ["ts"] });
      expect(hello.agent_id).toBeTruthy();

      const empty = await call("foreman__work_claim", {});
      expect(empty.status).toBe("empty");

      const item = await enqueueWorkItem(db.servicePool, {
        organisationId: orgId, projectId, title: "build the thing",
        acceptance: ["it builds"] });

      const claim = await call("foreman__work_claim", {});
      expect(claim.status).toBe("assigned");
      expect(claim.work_item.id).toBe(item.id);

      await call("foreman__work_report", { work_item_id: item.id, progress_note: "halfway", percent: 50 });
      await call("foreman__work_complete", {
        work_item_id: item.id, summary: "built it",
        acceptance_results: [{ criterion: "it builds", met: true }] });

      const status = await db.servicePool.query("select status from work_items where id=$1", [item.id]);
      expect(status.rows[0].status).toBe("done");
      const types = await db.servicePool.query(
        "select type from events where work_item_id=$1 order by id", [item.id]);
      expect(types.rows.map(r => r.type)).toEqual(
        expect.arrayContaining(["work.created","work.enqueued","work.claimed","work.progressed","work.completed"]));
      await client.close();
    } finally { await srv.close(); await db.teardown(); }
  }, 60_000);

  it("rejects a missing/bad bearer token", async () => {
    const db = await createTestDatabase();
    const srv = await startServer(db.servicePool);
    try {
      const client = new Client({ name: "anon", version: "0.0.1" });
      await expect(client.connect(new StreamableHTTPClientTransport(new URL(srv.url))))
        .rejects.toThrow();
    } finally { await srv.close(); await db.teardown(); }
  });
});
