import pg from "pg";
import { sweepExpiredLeases, enqueueReconcileJobs } from "@foreman/db";
import { detectStalls } from "./stall.js";
import { watchPush } from "./push.js";
import { generateBrief, briefDue, deliverBrief, mailerFromEnv, regenerateOverview, llmFromEnv } from "foreman-gen/lib";

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

// BRF-1: tick every minute; a project's brief fires when briefDue says so in
// its own timezone, then gets delivered (BRF-4). 0 disables the tick.
const BRIEF_TICK_SEC = Number(process.env.FOREMAN_BRIEF_TICK_SEC ?? 60);
if (BRIEF_TICK_SEC > 0) {
  setInterval(() => {
    (async () => {
      const projects = await pool.query(
        `select p.id, p.brief_schedule, p.brief_timezone,
                (select max(window_end) from briefs b where b.project_id = p.id) as last_end
         from projects p where p.brief_schedule is not null`);
      for (const p of projects.rows) {
        if (!briefDue(p.brief_schedule, p.brief_timezone, p.last_end, new Date())) continue;
        const brief = await generateBrief(pool, p.id);
        const channels = await deliverBrief(pool, brief, { mailer: mailerFromEnv() });
        console.log(`brief ${brief.id} generated for ${p.id}; delivered: ${channels.join(",") || "none"}`);
      }
    })().catch(err => console.error("brief tick failed", err));
  }, BRIEF_TICK_SEC * 1000);
}

// OVW deviation 2: overview regenerates on a cron (evidence-hash gated, so quiet
// projects cost nothing). 0 (default) disables.
const OVERVIEW_SEC = Number(process.env.FOREMAN_OVERVIEW_INTERVAL_SEC ?? 0);
if (OVERVIEW_SEC > 0) {
  setInterval(() => {
    (async () => {
      const llm = llmFromEnv();
      const projects = await pool.query("select id from projects");
      for (const p of projects.rows) {
        const r = await regenerateOverview(pool, p.id, { llm, causedBy: "cron" });
        if (r.regenerated.length > 0) console.log(`overview for ${p.id}: regenerated ${r.regenerated.join(",")}`);
      }
    })().catch(err => console.error("overview cron failed", err));
  }, OVERVIEW_SEC * 1000);
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

// OVW-2 push: overview + lifecycle refresh on work.completed. "0" disables.
const PUSH_MS = process.env.FOREMAN_PUSH_DEBOUNCE_MS ?? "2000";
if (PUSH_MS !== "0") {
  watchPush(pool, { llm: llmFromEnv(), debounceMs: Number(PUSH_MS) })
    .catch(err => console.error("push watcher crashed", err));
}

console.log("foreman-scheduler: lease sweeper running");
