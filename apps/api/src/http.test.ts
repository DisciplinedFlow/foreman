import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { createApp } from "./http.js";

let url: string;
let close: () => Promise<unknown>;

beforeAll(async () => {
  const app = createApp({
    appPool: {} as pg.Pool, servicePool: {} as pg.Pool, secret: "s".repeat(32), devAuth: false,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));
});
afterAll(async () => { await close(); });

describe("api http backstops (audit C3, catch-all error middleware)", () => {
  it("dev-login is 404 when devAuth is off", async () => {
    const res = await fetch(`${url}/auth/dev-login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "x@test.local" }),
    });
    expect(res.status).toBe(404);
  });

  it("malformed JSON body -> JSON 500, not Express's HTML default", async () => {
    const res = await fetch(`${url}/anything`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "internal" });
  });
});
