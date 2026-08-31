import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { sealPem, openPem, keyFromEnv } from "./crypto.js";

const KEY = crypto.randomBytes(32).toString("hex");
const PEM = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";

describe("envelope encryption (hardening)", () => {
  it("seal/open round-trips with the enc:v1: prefix", () => {
    const sealed = sealPem(PEM, KEY);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain("BEGIN PRIVATE KEY");
    expect(openPem(sealed, KEY)).toBe(PEM);
  });

  it("tampering with the ciphertext throws loudly", () => {
    const sealed = sealPem(PEM, KEY);
    const parts = sealed.split(":");
    parts[4] = Buffer.from("tampered-data-here").toString("base64");
    expect(() => openPem(parts.join(":"), KEY)).toThrow();
  });

  it("opening enc: material without a key is a loud error, never plaintext fallback", () => {
    const sealed = sealPem(PEM, KEY);
    expect(() => openPem(sealed, undefined)).toThrow(/master key/i);
    expect(() => openPem(sealed, "0".repeat(64))).toThrow();
  });

  it("plaintext passes through untouched (backward compatibility)", () => {
    expect(openPem(PEM, KEY)).toBe(PEM);
    expect(openPem(PEM, undefined)).toBe(PEM);
  });

  it("keyFromEnv validates length", () => {
    delete process.env.FOREMAN_MASTER_KEY;
    expect(keyFromEnv()).toBeUndefined();
    process.env.FOREMAN_MASTER_KEY = "short";
    expect(() => keyFromEnv()).toThrow(/64 hex/i);
    process.env.FOREMAN_MASTER_KEY = KEY;
    expect(keyFromEnv()).toBe(KEY);
    delete process.env.FOREMAN_MASTER_KEY;
  });
});
