import { describe, it, expect, vi } from "vitest";
import { resolveSessionSecret } from "./session-secret.js";

describe("resolveSessionSecret (audit C2)", () => {
  it("returns a configured secret >= 32 chars as-is, in any NODE_ENV", () => {
    const secret = "s".repeat(32);
    expect(resolveSessionSecret({ FOREMAN_SESSION_SECRET: secret, NODE_ENV: "production" })).toBe(secret);
    expect(resolveSessionSecret({ FOREMAN_SESSION_SECRET: secret, NODE_ENV: "development" })).toBe(secret);
  });

  it("throws at boot when unset in production", () => {
    expect(() => resolveSessionSecret({ NODE_ENV: "production" })).toThrow(/FOREMAN_SESSION_SECRET/);
  });

  it("throws at boot when shorter than 32 chars in production", () => {
    expect(() => resolveSessionSecret({ FOREMAN_SESSION_SECRET: "too-short", NODE_ENV: "production" }))
      .toThrow(/FOREMAN_SESSION_SECRET/);
  });

  it("falls back to a loud-warned dev default when unset outside production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = resolveSessionSecret({ NODE_ENV: "development" });
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
