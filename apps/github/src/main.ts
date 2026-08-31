import pg from "pg";
import { createReceiver } from "./receiver.js";
import { claimSyncJob, completeSyncJob } from "./jobs.js";
import { handleSyncJob } from "./handlers/index.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

const port = Number(process.env.FOREMAN_GITHUB_PORT ?? 3002);
createReceiver({ pool }).listen(port, () => {
  console.log(`foreman-github webhook receiver on :${port}`);
});

// Worker: claim → one transaction per job → complete. 500ms idle poll.
export async function drainOnce(): Promise<boolean> {
  const job = await claimSyncJob(pool);
  if (!job) return false;
  const client = await pool.connect();
  let ok = false;
  try {
    await client.query("begin");
    await handleSyncJob(client, job);
    await client.query("commit");
    ok = true;
  } catch (err) {
    await client.query("rollback");
    console.error(`sync job ${job.id} failed`, err);
  } finally {
    client.release();
  }
  await completeSyncJob(pool, job.id, ok);
  return true;
}

async function workerLoop(): Promise<never> {
  for (;;) {
    const worked = await drainOnce().catch((err) => { console.error("worker error", err); return false; });
    if (!worked) await new Promise((r) => setTimeout(r, 500));
  }
}

void workerLoop();
