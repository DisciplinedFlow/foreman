import type { Kv } from "./kv.js";
import type { InstallationTokenSource } from "./tokens.js";

export class RateLimitedError extends Error {
  constructor(public retryAtEpochSec: number) {
    super(`github rate limited until ${retryAtEpochSec}`);
    this.name = "RateLimitedError";
  }
}

export class GithubGraphqlError extends Error {
  constructor(public messages: string[]) {
    super(`github graphql error: ${messages.join("; ")}`);
    this.name = "GithubGraphqlError";
  }
}

interface TokenSourceLike { token(appId: number, installationId: number): Promise<string> }

// GHA-7: header-driven budget (deviation 7) — block below 20% of the observed limit
// until reset; a 403 + retry-after marks the installation degraded for that long.
export class GithubClient {
  constructor(private opts: {
    tokens: InstallationTokenSource | TokenSourceLike;
    kv: Kv;
    fetchImpl?: typeof fetch;
    apiBase?: string;
  }) {}

  private get apiBase() { return this.opts.apiBase ?? "https://api.github.com"; }

  private async preflight(installationId: number): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const deg = await this.opts.kv.get(`ghdeg:${installationId}`);
    if (deg !== null) throw new RateLimitedError(Number(deg));
    const raw = await this.opts.kv.get(`ghrate:${installationId}`);
    if (raw !== null) {
      const { remaining, limit, reset } = JSON.parse(raw) as { remaining: number; limit: number; reset: number };
      if (remaining < 0.2 * limit && reset > nowSec) throw new RateLimitedError(reset);
    }
  }

  private async postflight(installationId: number, res: Response): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (res.status === 403) {
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter !== null) {
        const retryAt = nowSec + Number(retryAfter);
        await this.opts.kv.set(`ghdeg:${installationId}`, String(retryAt), Math.max(1, Number(retryAfter)));
        throw new RateLimitedError(retryAt);
      }
    }
    const limit = res.headers.get("x-ratelimit-limit");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (limit !== null && remaining !== null && reset !== null) {
      const ttl = Math.max(1, Number(reset) - nowSec);
      await this.opts.kv.set(`ghrate:${installationId}`,
        JSON.stringify({ remaining: Number(remaining), limit: Number(limit), reset: Number(reset) }), ttl);
    }
  }

  private async request(appId: number, installationId: number, method: string, path: string, body?: unknown): Promise<Response> {
    await this.preflight(installationId);
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `token ${await this.opts.tokens.token(appId, installationId)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    await this.postflight(installationId, res);
    return res;
  }

  async rest(appId: number, installationId: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await this.request(appId, installationId, method, path, body);
    let json: any = null;
    try { json = await res.json(); } catch { /* 204s and empty bodies */ }
    return { status: res.status, json };
  }

  async graphql<T>(appId: number, installationId: number, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request(appId, installationId, "POST", "/graphql", { query, variables });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new GithubGraphqlError(body.errors.map((e) => e.message));
    return body.data as T;
  }
}
