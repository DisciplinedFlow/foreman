import pg from "pg";
import { sweepExpiredLeases } from "@foreman/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const INTERVAL = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);

setInterval(() => {
  sweepExpiredLeases(pool)
    .then(n => n && console.log(`requeued ${n} expired leases`))
    .catch(err => console.error("sweep failed", err));
}, INTERVAL);

console.log("foreman-scheduler: lease sweeper running");
