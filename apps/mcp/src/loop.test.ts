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

  it("reporting progress on a blocked item logs work.unblocked", async () => {
    const db = await createTestDatabase();
    const srv = await startServer(db.servicePool);
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "unblock");
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

      await call("foreman__agent_announce", { display_name: "unblock-agent", platform: "test" });

      const item = await enqueueWorkItem(db.servicePool, {
        organisationId: orgId, projectId, title: "needs unblocking" });

      const claim = await call("foreman__work_claim", {});
      expect(claim.status).toBe("assigned");

      await call("foreman__work_block", { work_item_id: item.id, reason: "waiting on input" });
      const blocked = await db.servicePool.query("select status from work_items where id=$1", [item.id]);
      expect(blocked.rows[0].status).toBe("blocked");

      await call("foreman__work_report", { work_item_id: item.id, progress_note: "resuming" });

      const status = await db.servicePool.query("select status from work_items where id=$1", [item.id]);
      expect(status.rows[0].status).toBe("in_progress");
      const unblocked = await db.servicePool.query(
        "select payload from events where type='work.unblocked' and work_item_id=$1", [item.id]);
      expect(unblocked.rowCount).toBe(1);

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

  it("checkpoint_poll is tenant-scoped: another org's agent gets not_found, item stays blocked", async () => {
    const db = await createTestDatabase();
    const srv = await startServer(db.servicePool);
    let clientA: Client | undefined;
    let clientB: Client | undefined;
    try {
      const { orgId: orgA, projectId: projectA } = await seedOrgWithUser(db.servicePool, "cp-tenant-a");
      const { orgId: orgB, projectId: projectB } = await seedOrgWithUser(db.servicePool, "cp-tenant-b");
      const { token: tokenA } = await createAgentToken(db.servicePool, { organisationId: orgA, projectId: projectA });
      const { token: tokenB } = await createAgentToken(db.servicePool, { organisationId: orgB, projectId: projectB });

      const connect = async (token: string) => {
        const client = new Client({ name: "test-agent", version: "0.0.1" });
        await client.connect(new StreamableHTTPClientTransport(new URL(srv.url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }));
        return client;
      };
      const call = async (client: Client, name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { isError: r.isError ?? false, body: JSON.parse((r.content as { type: string; text: string }[])[0]!.text) };
      };

      clientA = await connect(tokenA);
      clientB = await connect(tokenB);

      await call(clientA, "foreman__agent_announce", { display_name: "agent-a", platform: "test" });
      await call(clientB, "foreman__agent_announce", { display_name: "agent-b", platform: "test" });

      const item = await enqueueWorkItem(db.servicePool, {
        organisationId: orgA, projectId: projectA, title: "org-a-only-work" });

      const claim = await call(clientA, "foreman__work_claim", {});
      expect(claim.isError).toBe(false);
      expect(claim.body.status).toBe("assigned");

      const checkpoint = await call(clientA, "foreman__work_checkpoint",
        { work_item_id: item.id, question: "proceed?" });
      expect(checkpoint.isError).toBe(false);
      const checkpointId = checkpoint.body.checkpoint_id;
      expect(checkpointId).toBeTruthy();

      const blockedRow = await db.servicePool.query("select status from work_items where id=$1", [item.id]);
      expect(blockedRow.rows[0].status).toBe("blocked");

      const foreignPoll = await call(clientB, "foreman__checkpoint_poll", { checkpoint_id: checkpointId });
      expect(foreignPoll.isError).toBe(true);
      expect(foreignPoll.body.code).toBe("not_found");

      const stillBlocked = await db.servicePool.query("select status from work_items where id=$1", [item.id]);
      expect(stillBlocked.rows[0].status).toBe("blocked");
    } finally {
      if (clientA) await clientA.close();
      if (clientB) await clientB.close();
      await srv.close();
      await db.teardown();
    }
  }, 60_000);
});
