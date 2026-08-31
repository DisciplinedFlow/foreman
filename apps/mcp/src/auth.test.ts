import { describe, expect, it } from "vitest";
import { createTestDatabase, seedOrgWithUser } from "@foreman/db/testing";
import { authenticate, createAgentToken } from "./auth.js";

describe("mcp auth", () => {
  it("authenticates a freshly minted token to its org/project, garbage tokens fail, revoked tokens fail", async () => {
    const db = await createTestDatabase();
    try {
      const { orgId, projectId } = await seedOrgWithUser(db.servicePool, "auth");
      const { token, id } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId });

      const ctx = await authenticate(db.servicePool, `Bearer ${token}`);
      expect(ctx).not.toBeNull();
      expect(ctx!.tokenId).toBe(id);
      expect(ctx!.organisationId).toBe(orgId);
      expect(ctx!.projectId).toBe(projectId);
      expect(ctx!.agentId).toBeNull();

      const before = await db.servicePool.query("select last_used_at from agent_tokens where id=$1", [id]);
      expect(before.rows[0].last_used_at).not.toBeNull();

      expect(await authenticate(db.servicePool, undefined)).toBeNull();
      expect(await authenticate(db.servicePool, "Bearer fmn_agt_totally-garbage")).toBeNull();
      expect(await authenticate(db.servicePool, `Basic ${token}`)).toBeNull();

      await db.servicePool.query("update agent_tokens set revoked_at = now() where id=$1", [id]);
      expect(await authenticate(db.servicePool, `Bearer ${token}`)).toBeNull();
    } finally { await db.teardown(); }
  });
});
