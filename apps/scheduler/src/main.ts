import pg from "pg";
import { sweepExpiredLeases, enqueueReconcileJobs } from "@foreman/db";
import { detectStalls } from "./stall.js";
import { generateBrief } from "foreman-gen/lib";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const INTERVAL = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);

setInterval(() => {
  sweepExpiredLeases(pool)
    .then(n => n && console.log(`requeued ${n} expired leases`))
    .catch(err => console.error("sweep failed", err));
}, INTERVAL);

// Deviation 6: deps have no webhook — a periodic full sync closes the gap. 0 disables.
const RECONCILE_SEC = Number(process.env.FOREMAN_RECONCILE_INTERVAL_SEC ?? 3600);
if (RECONCILE_SEC > 0) {
  setInterval(() => {
    enqueueReconcileJobs(pool)
      .then(n => n && console.log(`enqueued ${n} reconcile jobs`))
      .catch(err => console.error("reconcile enqueue failed", err));
  }, RECONCILE_SEC * 1000);
}

// BRF-1 (deterministic v1): periodic brief per GitHub-connected project. 0 (default) disables.
const BRIEF_SEC = Number(process.env.FOREMAN_BRIEF_INTERVAL_SEC ?? 0);
if (BRIEF_SEC > 0) {
  setInterval(() => {
    (async () => {
      const projects = await pool.query("select id from projects where gh_project_node_id is not null");
      for (const p of projects.rows) await generateBrief(pool, p.id);
      if (projects.rowCount) console.log(`generated ${projects.rowCount} briefs`);
    })().catch(err => console.error("brief generation failed", err));
  }, BRIEF_SEC * 1000);
}

// AVW-3: stall sweep. 0 disables.
const STALL_SEC = Number(process.env.FOREMAN_STALL_INTERVAL_SEC ?? 60);
if (STALL_SEC > 0) {
  setInterval(() => {
    detectStalls(pool)
      .then(n => n && console.log(`flagged ${n} stalled agents`))
      .catch(err => console.error("stall sweep failed", err));
  }, STALL_SEC * 1000);
}

console.log("foreman-scheduler: lease sweeper running");
