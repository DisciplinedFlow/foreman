import crypto from "node:crypto";
import express from "express";
import type pg from "pg";
import { mountRoutes } from "./routes.js";

export interface ControlDeps {
  pool: pg.Pool; // foreman_control — the only role that may provision or destroy tenants (WL-8)
  token: string; // FOREMAN_CONTROL_TOKEN, checked with a timing-safe compare
}

// Bearer strings differ in length in the common case (wrong token, no token),
// so hash both sides to a fixed-width digest before the timing-safe compare —
// mirrors apps/github/src/verify.ts and apps/api/src/csrf.ts.
function safeTokenEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireBearer(token: string): express.RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!provided || !safeTokenEqual(provided, token)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
}

export function createControlApp(deps: ControlDeps): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => { res.status(200).json({ ok: true }); });

  app.use(requireBearer(deps.token));
  mountRoutes(app, deps);

  // Catch-all: every other path returns JSON on error, but this is the
  // backstop so a future path can never leak Express's default HTML 500.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("control-plane request failed", err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}
