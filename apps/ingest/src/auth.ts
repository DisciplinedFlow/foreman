// Phase 8: the Phase 4 copy is gone — token logic lives in @foreman/db now.
// Same exported names/behaviour as before.
import type pg from "pg";
import {
  createAgentToken as dbCreate, authenticateAgentToken as dbAuth,
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
  return dbAuth(pool, authorizationHeader);
}
