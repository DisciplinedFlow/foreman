import pg from "pg";
import { createIngestApp } from "./http.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

const port = Number(process.env.FOREMAN_INGEST_PORT ?? 3004);
createIngestApp(pool).listen(port, () => {
  console.log(`foreman-ingest on :${port}`);
});
