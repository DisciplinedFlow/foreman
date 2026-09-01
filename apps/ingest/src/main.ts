import pg from "pg";
import { attachPoolErrorHandler, installProcessGuards } from "@foreman/db";
import { createIngestApp } from "./http.js";

installProcessGuards("ingest");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});
attachPoolErrorHandler(pool, "ingest");

const port = Number(process.env.FOREMAN_INGEST_PORT ?? 3004);
createIngestApp(pool).listen(port, () => {
  console.log(`foreman-ingest on :${port}`);
});
