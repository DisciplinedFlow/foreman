import express from "express";
import type pg from "pg";
import { signSession, verifySession, sessionCookieName } from "./auth.js";
import { CSRF_COOKIE, issueCsrf, csrfMiddleware } from "./csrf.js";
import { mountRoutes } from "./routes.js";
import { mountStream, type EventHub } from "./stream.js";

export interface ApiDeps {
  appPool: pg.Pool;      // foreman_app — RLS-enforced, serves every user-facing read
  servicePool: pg.Pool;  // foreman_service — pre-auth user lookup, sync_jobs enqueue, SSE reads
  secret: string;
  devAuth: boolean;
  hub?: EventHub;        // absent → /stream responds 503
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
      const secure = deps.devAuth ? "" : "; Secure";
      const csrf = issueCsrf();
      res.setHeader("set-cookie", [
        `${sessionCookieName(deps.devAuth)}=${signSession(userId, deps.secret)}; HttpOnly; SameSite=Lax; Path=/${secure}`,
        // double-submit half: readable by the page, echoed back as x-csrf-token
        `${CSRF_COOKIE}=${csrf}; SameSite=Lax; Path=/${secure}`,
      ]);
      return res.json({ user_id: userId, csrf_token: csrf });
    });
  }

  const requireUser: express.RequestHandler = (req, res, next) => {
    const userId = verifySession(parseCookie(req.headers.cookie, sessionCookieName(deps.devAuth)), deps.secret);
    if (userId === null) return res.status(401).json({ error: "unauthenticated" });
    (req as AuthedRequest).userId = userId;
    return next();
  };

  const api = express.Router();
  api.use(requireUser);
  api.use(csrfMiddleware());
  mountRoutes(api, deps);
  mountStream(api, deps);
  app.use("/api", api);

  return app;
}
