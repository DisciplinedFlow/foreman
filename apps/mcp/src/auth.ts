// Phase 8: token mint/auth moved to @foreman/db (three consumers). This module
// keeps the app's historical surface — same names, same behaviour.
import type pg from "pg";
import {
  createAgentToken as dbCreate, authenticateAgentToken as dbAuth, type AgentAuthCtx,
} from "@foreman/db";

export interface AuthCtx {
  tokenId: string;
  organisationId: string;
  projectId: string;
  agentId: string | null;
}

export function createAgentToken(
  pool: pg.Pool, opts: { organisationId: string; projectId: string },
): Promise<{ token: string; id: string }> {
  return dbCreate(pool, opts);
}

export function authenticate(
  pool: pg.Pool, authorizationHeader: string | undefined,
): Promise<AuthCtx | null> {
  return dbAuth(pool, authorizationHeader) as Promise<AgentAuthCtx | null>;
}
