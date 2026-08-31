// Duplicated from apps/mcp/src/auth.ts (Phase 4 deviation 6): two consumers
// don't justify a shared package yet. Keep in sync if the token shape changes.
import crypto from "node:crypto";
import type pg from "pg";

export interface AuthCtx {
  tokenId: string;
  organisationId: string;
  projectId: string;
  agentId: string | null;
}

const TOKEN_PREFIX = "fmn_agt_";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createAgentToken(
  pool: pg.Pool,
  { organisationId, projectId }: { organisationId: string; projectId: string },
): Promise<{ token: string; id: string }> {
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString("base64url");
  const res = await pool.query(
    `insert into agent_tokens (organisation_id, project_id, token_hash) values ($1,$2,$3) returning id`,
    [organisationId, projectId, hashToken(token)]);
  return { token, id: res.rows[0].id };
}

export async function authenticate(
  pool: pg.Pool,
  authorizationHeader: string | undefined,
): Promise<AuthCtx | null> {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const res = await pool.query(
    `update agent_tokens set last_used_at = now()
     where token_hash = $1 and revoked_at is null
     returning id, organisation_id, project_id, agent_id`,
    [hashToken(token)]);
  if (!res.rowCount) return null;

  const row = res.rows[0];
  return {
    tokenId: row.id,
    organisationId: row.organisation_id,
    projectId: row.project_id,
    agentId: row.agent_id,
  };
}
