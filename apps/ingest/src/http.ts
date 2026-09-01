import express from "express";
import type pg from "pg";
import { authenticate } from "./auth.js";
import { parseHook, mapHook } from "./mapper.js";

// §4.1 hard rule: observe-only. Auth failures are the only non-200; a mapper
// error must never block a customer's agent — log it and ack.
// Express 4 does not forward a rejected promise from an async handler to
// error middleware on its own — an unwrapped throw here becomes an
// unhandledRejection that crashes the process instead of returning a 500.
// Mirrors apps/api/src/routes.ts's wrap().
const wrap = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createIngestApp(pool: pg.Pool): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => { res.status(200).json({ ok: true }); });

  app.post("/ingest/hook", wrap(async (req, res) => {
    const ctx = await authenticate(pool, req.headers.authorization);
    if (ctx === null) return res.status(401).json({ error: "unauthorized" });

    const hook = parseHook(req.body);
    if (hook !== null) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await mapHook(client, ctx, hook);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        console.error("hook mapping failed (acked anyway)", err);
      } finally {
        client.release();
      }
    }
    return res.status(200).json({});
  }));

  // Catch-all: every other path returns JSON on error, but this is the
  // backstop so a future path can never leak Express's default HTML 500.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("ingest request failed", err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}
