import { describe, it, expect } from "vitest";
import { InMemoryKv } from "./kv.js";
import { GithubClient, RateLimitedError, GithubGraphqlError } from "./client.js";

function stub(responses: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>) {
  const seen: any[] = [];
  const f = (async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return { f, seen };
}
const tokens = { token: async () => "ghs_x" } as any;

describe("GithubClient", () => {
  it("rest() sends token auth + api-version header and parses JSON", async () => {
    const { f, seen } = stub([{ status: 200, body: { id: 42 } }]);
    const c = new GithubClient({ tokens, kv: new InMemoryKv(), fetchImpl: f, apiBase: "https://gh.test" });
    const res = await c.rest(1, 7, "GET", "/repos/o/r/issues/1");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 42 });
    expect(seen[0].url).toBe("https://gh.test/repos/o/r/issues/1");
    expect(seen[0].init.headers["authorization"]).toBe("token ghs_x");
    expect(seen[0].init.headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("blocks below the 20% floor without calling fetch", async () => {
    const kv = new InMemoryKv();
    const { f, seen } = stub([
      { status: 200, headers: { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "10", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } },
    ]);
    const c = new GithubClient({ tokens, kv, fetchImpl: f, apiBase: "https://gh.test" });
    await c.rest(1, 7, "GET", "/repos/o/r/issues/1");
    await expect(c.rest(1, 7, "GET", "/repos/o/r/issues/2")).rejects.toBeInstanceOf(RateLimitedError);
    expect(seen.length).toBe(1);
  });

  it("403 with retry-after marks the installation degraded and throws", async () => {
    const kv = new InMemoryKv();
    const { f } = stub([{ status: 403, headers: { "retry-after": "30" } }]);
    const c = new GithubClient({ tokens, kv, fetchImpl: f, apiBase: "https://gh.test" });
    await expect(c.rest(1, 7, "GET", "/repos/o/r/issues/1")).rejects.toBeInstanceOf(RateLimitedError);
    expect(await kv.get("ghdeg:7")).not.toBeNull();
    await expect(c.rest(1, 7, "GET", "/repos/o/r/issues/1")).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("graphql() posts to /graphql, returns data, throws GithubGraphqlError on errors", async () => {
    const { f, seen } = stub([
      { status: 200, body: { data: { viewer: { login: "x" } } } },
      { status: 200, body: { errors: [{ message: "boom" }] } },
    ]);
    const c = new GithubClient({ tokens, kv: new InMemoryKv(), fetchImpl: f, apiBase: "https://gh.test" });
    const data = await c.graphql<{ viewer: { login: string } }>(1, 7, "query { viewer { login } }", {});
    expect(data.viewer.login).toBe("x");
    expect(seen[0].url).toBe("https://gh.test/graphql");
    expect(JSON.parse(seen[0].init.body).query).toContain("viewer");
    await expect(c.graphql(1, 7, "query {}", {})).rejects.toBeInstanceOf(GithubGraphqlError);
  });
});
