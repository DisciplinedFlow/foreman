// §3.5 agent tokens — moved here in Phase 8 (third consumer: api token
// management joins mcp + ingest). Byte-identical behaviour to the Phase 1
// original: fmn_agt_ prefix, sha256 at rest, last_used_at touch, revoked check.
import crypto from "node:crypto";
import type pg from "pg";

export interface AgentAuthCtx {
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

export async function authenticateAgentToken(
  pool: pg.Pool,
  authorizationHeader: string | undefined,
): Promise<AgentAuthCtx | null> {
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

export async function revokeAgentToken(pool: pg.Pool, tokenId: string): Promise<void> {
  await pool.query(
    "update agent_tokens set revoked_at = coalesce(revoked_at, now()) where id = $1", [tokenId]);
}
