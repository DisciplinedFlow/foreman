import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { createApp } from "./http.js";

let url: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  const app = createApp({} as pg.Pool);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));
});
afterAll(async () => { await close(); });

describe("mcp http backstop (catch-all error middleware)", () => {
  it("malformed JSON body -> JSON 500, not Express's HTML default", async () => {
    const res = await fetch(`${url}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("a thrown/rejected error inside the async handler -> JSON 500, never crashes the process", async () => {
    // Stand-in for a real DB error inside authenticate(): a pool whose query always rejects.
    const throwingPool = { query: () => Promise.reject(new Error("boom")) } as unknown as pg.Pool;
    const app = createApp(throwingPool);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const throwUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await fetch(throwUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer whatever" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(await res.json()).toEqual({ error: "internal" });
      // give any stray unhandledRejection a tick to surface before asserting none did
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await new Promise((r) => server.close(r));
    }
  });
});
