import pg from "pg";
import { attachPoolErrorHandler, installProcessGuards } from "@foreman/db";
import { runForever } from "./runner.js";
import { criticalPathProjection } from "./projections/critical-path.js";

installProcessGuards("projector");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});
attachPoolErrorHandler(pool, "projector");

console.log("foreman-projector starting");
await runForever(pool, [criticalPathProjection]);
