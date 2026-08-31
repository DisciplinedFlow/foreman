import express from "express";
import type pg from "pg";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate } from "./auth.js";
import { buildMcpServer } from "./server.js";

export function createApp(pool: pg.Pool): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/mcp", async (req, res) => {
    const ctx = await authenticate(pool, req.headers.authorization);
    if (!ctx) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null });
      return;
    }
    const server = buildMcpServer(pool, ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
