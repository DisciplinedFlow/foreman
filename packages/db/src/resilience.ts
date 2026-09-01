// Reliability fix: node-pg's Pool already replaces a dead idle client and
// reconnects on the next connect()/query() — the ONLY reason a service used
// to crash on a DB blip (e.g. "terminating connection due to administrator
// command" on a Postgres restart) was the unhandled 'error' event an
// EventEmitter throws synchronously when nothing is listening. Attaching a
// listener here is the whole fix; no manual reconnect loop needed.
import type pg from "pg";

export function attachPoolErrorHandler(pool: pg.Pool, label: string): void {
  pool.on("error", (err) => {
    console.error(`[${label}] pg pool error (recovering)`, err);
  });
}

let processGuardsInstalled = false;

// Guarded so calling this more than once per process (e.g. multiple pools in
// apps/api) doesn't stack duplicate unhandledRejection listeners. Deliberately
// does not touch uncaughtException — that stays on Node's default (crash),
// since swallowing it would hide genuinely fatal bugs.
export function installProcessGuards(label: string): void {
  if (processGuardsInstalled) return;
  processGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    console.error(`[${label}] unhandledRejection`, reason);
  });
}
