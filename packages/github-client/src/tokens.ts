import { appJwt } from "./jwt.js";
import type { Kv } from "./kv.js";

export class InstallationTokenSource {
  constructor(private opts: {
    kv: Kv; fetchImpl?: typeof fetch; apiBase?: string;
    getApp(appId: number): Promise<{ privateKeyPem: string }>;
  }) {}

  async token(appId: number, installationId: number): Promise<string> {
    const key = `ghtok:${installationId}`;
    const cached = await this.opts.kv.get(key);
    if (cached) return cached;
    const { privateKeyPem } = await this.opts.getApp(appId);
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.opts.apiBase ?? "https://api.github.com"}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${appJwt(appId, privateKeyPem)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (res.status !== 201) throw new Error(`token mint failed for installation ${installationId}: ${res.status}`);
    const body = (await res.json()) as { token: string };
    await this.opts.kv.set(key, body.token, 55 * 60);
    return body.token;
  }
}
