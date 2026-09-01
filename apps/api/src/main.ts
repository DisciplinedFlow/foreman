import pg from "pg";
import { createApp } from "./http.js";
import { createEventHub } from "./stream.js";
import { resolveSessionSecret } from "./session-secret.js";

const appPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_APP
    ?? "postgres://foreman_app:foreman_app@localhost:5433/foreman",
});
const servicePool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    ?? "postgres://foreman_service:foreman_service@localhost:5433/foreman",
});

const hub = await createEventHub(servicePool);
const app = createApp({
  appPool,
  servicePool,
  secret: resolveSessionSecret(),
  // audit C3: dev-login was on by default whenever NODE_ENV wasn't "production" —
  // an unset/misconfigured NODE_ENV silently left password-less login reachable.
  // Now it's opt-in: nothing mounts /auth/dev-login unless explicitly asked for.
  devAuth: process.env.FOREMAN_DEV_AUTH === "1",
  hub,
});

const port = Number(process.env.FOREMAN_API_PORT ?? 3003);
app.listen(port, () => console.log(`foreman-api on :${port}`));
