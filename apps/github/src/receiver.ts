import express from "express";
import type pg from "pg";
import { verifySignature } from "./verify.js";

// GHA-2: raw body → verify → dedupe → tenant route → enqueue → 200. Never process inline.
export function createReceiver(opts: { pool: pg.Pool }): express.Express {
  const { pool } = opts;
  const app = express();

  app.post("/webhook", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    try {
      const rawBody = req.body as Buffer;

      // One secret per App (never tenant-from-secret): the target id header names the App.
      const targetId = Number(req.header("x-github-hook-installation-target-id"));
      if (!Number.isInteger(targetId)) return res.status(401).json({ error: "unknown app" });
      const appRow = await pool.query("select webhook_secret from github_apps where app_id = $1", [targetId]);
      if (appRow.rowCount === 0) return res.status(401).json({ error: "unknown app" });

      if (!verifySignature(appRow.rows[0].webhook_secret, rawBody, req.header("x-hub-signature-256"))) {
        return res.status(401).json({ error: "bad signature" });
      }

      const deliveryId = req.header("x-github-delivery");
      if (!deliveryId) return res.status(400).json({ error: "missing delivery id" });
      const dedupe = await pool.query(
        "insert into github_deliveries (delivery_id) values ($1) on conflict do nothing", [deliveryId]);
      if (dedupe.rowCount === 0) return res.status(200).json({ deduped: true });

      const payload = JSON.parse(rawBody.toString("utf8")) as { action?: string; installation?: { id?: number } };
      const installationId = payload.installation?.id;
      const inst = installationId === undefined ? { rowCount: 0, rows: [] as any[] }
        : await pool.query("select organisation_id from github_installations where installation_id = $1", [installationId]);
      if (inst.rowCount === 0) {
        console.warn(`webhook unrouted: installation ${installationId ?? "<none>"} delivery ${deliveryId}`);
        return res.status(202).json({ unrouted: true });
      }

      await pool.query(
        `insert into sync_jobs (organisation_id, installation_id, delivery_id, event_name, action, payload)
         values ($1,$2,$3,$4,$5,$6)`,
        [inst.rows[0].organisation_id, installationId, deliveryId,
         req.header("x-github-event") ?? "unknown", payload.action ?? null, rawBody.toString("utf8")]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("webhook error", err);
      return res.status(500).json({ error: "internal" });
    }
  });

  return app;
}
