import express from "express";
import type pg from "pg";
import { COOKIE_NAME, signSession, verifySession } from "./auth.js";
import { mountRoutes } from "./routes.js";

export interface ApiDeps {
  appPool: pg.Pool;      // foreman_app — RLS-enforced, serves every user-facing read
  servicePool: pg.Pool;  // foreman_service — pre-auth user lookup + sync_jobs enqueue only
  secret: string;
  devAuth: boolean;
}

export interface AuthedRequest extends express.Request {
  userId: string;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function createApp(deps: ApiDeps): express.Express {
  const app = express();
  app.use(express.json());

  if (deps.devAuth) {
    // Deviation 1: env-gated dev login; real IdP is a control-plane concern.
    app.post("/auth/dev-login", async (req, res) => {
      const email = typeof req.body?.email === "string" ? req.body.email : null;
      if (email === null) return res.status(400).json({ error: "email required" });
      const user = await deps.servicePool.query("select id from users where email = $1", [email]);
      if (user.rowCount === 0) return res.status(404).json({ error: "unknown user" });
      const userId: string = user.rows[0].id;
      res.setHeader("set-cookie",
        `${COOKIE_NAME}=${signSession(userId, deps.secret)}; HttpOnly; SameSite=Lax; Path=/`);
      return res.json({ user_id: userId });
    });
  }

  const requireUser: express.RequestHandler = (req, res, next) => {
    const userId = verifySession(parseCookie(req.headers.cookie, COOKIE_NAME), deps.secret);
    if (userId === null) return res.status(401).json({ error: "unauthenticated" });
    (req as AuthedRequest).userId = userId;
    return next();
  };

  const api = express.Router();
  api.use(requireUser);
  mountRoutes(api, deps);
  app.use("/api", api);

  return app;
}
