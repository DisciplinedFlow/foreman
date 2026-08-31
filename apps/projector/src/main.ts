import pg from "pg";
import { runForever, type Projection } from "./runner.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

const projections: Projection[] = []; // critical-path lands with Task 10

console.log("foreman-projector starting");
await runForever(pool, projections);
