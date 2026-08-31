import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { InMemoryKv } from "./kv.js";
import { InstallationTokenSource } from "./tokens.js";

const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function fakeFetch(calls: string[]): typeof fetch {
  return (async (url: any, init: any) => {
    calls.push(`${init.method} ${url} auth=${init.headers["authorization"]?.startsWith("Bearer ey")}`);
    return new Response(JSON.stringify({ token: "ghs_test", expires_at: "2026-08-31T13:00:00Z" }), { status: 201 });
  }) as typeof fetch;
}

describe("InstallationTokenSource", () => {
  it("mints lazily, caches 55min, never re-fetches while cached", async () => {
    const calls: string[] = [];
    const kv = new InMemoryKv();
    const src = new InstallationTokenSource({
      kv, fetchImpl: fakeFetch(calls), apiBase: "https://gh.test",
      getApp: async () => ({ privateKeyPem: pem }),
    });
    expect(await src.token(1, 777)).toBe("ghs_test");
    expect(await src.token(1, 777)).toBe("ghs_test");
    expect(calls).toEqual(["POST https://gh.test/app/installations/777/access_tokens auth=true"]);
    expect(await kv.get("ghtok:777")).toBe("ghs_test");
  });
});
