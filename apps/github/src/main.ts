import pg from "pg";
import { createReceiver } from "./receiver.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

const port = Number(process.env.FOREMAN_GITHUB_PORT ?? 3002);
createReceiver({ pool }).listen(port, () => {
  console.log(`foreman-github webhook receiver on :${port}`);
});
