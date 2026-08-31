import express from "express";
import type pg from "pg";
import { authenticate } from "./auth.js";
import { parseHook, mapHook } from "./mapper.js";

// §4.1 hard rule: observe-only. Auth failures are the only non-200; a mapper
// error must never block a customer's agent — log it and ack.
export function createIngestApp(pool: pg.Pool): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => { res.status(200).json({ ok: true }); });

  app.post("/ingest/hook", async (req, res) => {
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
  });

  return app;
}
