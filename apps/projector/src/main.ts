import pg from "pg";
import { runForever } from "./runner.js";
import { criticalPathProjection } from "./projections/critical-path.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

console.log("foreman-projector starting");
await runForever(pool, [criticalPathProjection]);
