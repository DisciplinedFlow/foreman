import { EventEmitter } from "node:events";
import type express from "express";
import pg from "pg";
import { createClient } from "redis";
import { InMemoryKv, RedisKv, EchoCache, GithubClient, InstallationTokenSource, type Kv } from "@foreman/github-client";
import { createReceiver } from "./receiver.js";
import { claimSyncJob, completeSyncJob } from "./jobs.js";
import { handleSyncJob, type HandlerContext } from "./handlers/index.js";
import { GithubBackbone } from "./backbone.js";
import { mountSetup } from "./setup.js";
import { openPem, resolveMasterKey } from "./crypto.js";
import { resolveSessionSecret } from "./session-secret.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

// Redis-backed Kv when configured (echo suppression must survive restarts in prod);
// in-memory otherwise. Only this file constructs RedisKv.
async function makeKv(): Promise<Kv> {
  const url = process.env.REDIS_URL;
  if (url === undefined) return new InMemoryKv();
  const client = createClient({ url });
  await client.connect();
  return new RedisKv(client as any);
}

const kv = await makeKv();
// Resolved once at boot (env|file|command, KMS-ready) and threaded everywhere
// keyFromEnv()'s result used to be passed — an invalid key from any source
// throws here, before the server starts accepting traffic.
const masterKey = await resolveMasterKey();
const tokens = new InstallationTokenSource({
  kv,
  getApp: async (appId) => {
    const r = await pool.query("select private_key_pem from github_apps where app_id = $1", [appId]);
    if (r.rowCount === 0) throw new Error(`unknown github app ${appId}`);
    return { privateKeyPem: openPem(r.rows[0].private_key_pem, masterKey) };
  },
});
const echo = new EchoCache(kv);
const gh = new GithubClient({ tokens, kv });
const ctx: HandlerContext = {
  echo,
  gh,
  backbone: new GithubBackbone({ pool, gh, echo, emitter: new EventEmitter() }),
};

const port = Number(process.env.FOREMAN_GITHUB_PORT ?? 3002);
const receiver = createReceiver({ pool });
mountSetup(receiver, {
  pool,
  secret: resolveSessionSecret(),
  publicUrl: process.env.FOREMAN_PUBLIC_URL ?? `http://localhost:${port}`,
  ...(masterKey !== undefined ? { masterKey } : {}),
});

// Catch-all backstop (mirrors apps/control/src/http.ts): mounted after every
// route above, so a handler that throws or calls next(err) never leaks
// Express's default HTML 500.
receiver.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("github service request failed", err);
  res.status(500).json({ error: "internal" });
});

receiver.listen(port, () => {
  console.log(`foreman-github webhook receiver on :${port}`);
});

// Worker: claim → one transaction per job → complete. 500ms idle poll.
export async function drainOnce(): Promise<boolean> {
  const job = await claimSyncJob(pool);
  if (!job) return false;
  const client = await pool.connect();
  let ok = false;
  let error: string | undefined;
  try {
    await client.query("begin");
    await handleSyncJob(client, job, ctx);
    await client.query("commit");
    ok = true;
  } catch (err) {
    await client.query("rollback");
    error = err instanceof Error ? err.message : String(err);
    console.error(`sync job ${job.id} failed`, err);
  } finally {
    client.release();
  }
  await completeSyncJob(pool, job.id, ok, error);
  return true;
}

async function workerLoop(): Promise<never> {
  for (;;) {
    const worked = await drainOnce().catch((err) => { console.error("worker error", err); return false; });
    if (!worked) await new Promise((r) => setTimeout(r, 500));
  }
}

void workerLoop();
