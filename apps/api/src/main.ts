import pg from "pg";
import { createApp } from "./http.js";

const appPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_APP
    ?? "postgres://foreman_app:foreman_app@localhost:5433/foreman",
});
const servicePool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

const app = createApp({
  appPool,
  servicePool,
  secret: process.env.FOREMAN_SESSION_SECRET ?? "dev-only-secret",
  devAuth: process.env.NODE_ENV !== "production",
});

const port = Number(process.env.FOREMAN_API_PORT ?? 3003);
app.listen(port, () => console.log(`foreman-api on :${port}`));
