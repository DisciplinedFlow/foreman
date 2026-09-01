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
});
