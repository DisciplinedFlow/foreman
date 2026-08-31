import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "./testing.js";
import { createAgentToken, authenticateAgentToken, revokeAgentToken } from "./tokens.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "tokens"));
});
afterAll(async () => { await db.teardown(); });

describe("agent tokens (shared, §3.5)", () => {
  it("mint → authenticate → revoke → reject", async () => {
    const { token, id } = await createAgentToken(db.servicePool, { organisationId: orgId, projectId });
    expect(token.startsWith("fmn_agt_")).toBe(true);

    const ctx = await authenticateAgentToken(db.servicePool, `Bearer ${token}`);
    expect(ctx).toMatchObject({ organisationId: orgId, projectId, agentId: null, tokenId: id });

    const touched = await db.servicePool.query("select last_used_at from agent_tokens where id=$1", [id]);
    expect(touched.rows[0].last_used_at).not.toBeNull();

    await revokeAgentToken(db.servicePool, id);
    expect(await authenticateAgentToken(db.servicePool, `Bearer ${token}`)).toBeNull();
    await revokeAgentToken(db.servicePool, id); // idempotent
  });

  it("garbage and missing headers fail closed", async () => {
    expect(await authenticateAgentToken(db.servicePool, undefined)).toBeNull();
    expect(await authenticateAgentToken(db.servicePool, "Bearer nope")).toBeNull();
    expect(await authenticateAgentToken(db.servicePool, "Basic abc")).toBeNull();
  });
});
