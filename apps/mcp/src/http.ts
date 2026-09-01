import express from "express";
import type pg from "pg";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate } from "./auth.js";
import { buildMcpServer } from "./server.js";

// Express 4 does not forward a rejected promise from an async handler to
// error middleware on its own — an unwrapped throw here becomes an
// unhandledRejection that crashes the process instead of returning a 500.
// Mirrors apps/api/src/routes.ts's wrap().
const wrap = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp(pool: pg.Pool): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post("/mcp", wrap(async (req, res) => {
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
  }));

  // Catch-all: every other path returns JSON on error, but this is the
  // backstop so a future path can never leak Express's default HTML 500.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("mcp request failed", err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}
