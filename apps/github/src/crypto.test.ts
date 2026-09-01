import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sealPem, openPem, keyFromEnv, resolveMasterKey } from "./crypto.js";

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

describe("resolveMasterKey (pluggable source, KMS-ready)", () => {
  const tmpFiles: string[] = [];

  afterEach(async () => {
    while (tmpFiles.length > 0) {
      const dir = tmpFiles.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no source is configured", async () => {
    expect(await resolveMasterKey({})).toBeUndefined();
  });

  it("FOREMAN_MASTER_KEY wins over FOREMAN_MASTER_KEY_FILE and FOREMAN_MASTER_KEY_CMD", async () => {
    const env = {
      FOREMAN_MASTER_KEY: KEY,
      FOREMAN_MASTER_KEY_FILE: "C:\\does\\not\\exist",
      FOREMAN_MASTER_KEY_CMD: "exit 1",
    };
    expect(await resolveMasterKey(env)).toBe(KEY);
  });

  it("reads, trims, and validates the key from FOREMAN_MASTER_KEY_FILE", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "foreman-master-key-"));
    tmpFiles.push(dir);
    const file = path.join(dir, "master.key");
    await writeFile(file, `${KEY}\n`, "utf8");
    expect(await resolveMasterKey({ FOREMAN_MASTER_KEY_FILE: file })).toBe(KEY);
  });

  it("FOREMAN_MASTER_KEY_FILE with bad hex throws, naming the source", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "foreman-master-key-"));
    tmpFiles.push(dir);
    const file = path.join(dir, "master.key");
    await writeFile(file, "not-hex", "utf8");
    await expect(resolveMasterKey({ FOREMAN_MASTER_KEY_FILE: file })).rejects.toThrow(/FOREMAN_MASTER_KEY_FILE/);
  });

  it("FOREMAN_MASTER_KEY_FILE pointing at a nonexistent path throws, naming the source", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "foreman-master-key-"));
    tmpFiles.push(dir);
    const file = path.join(dir, "does-not-exist.key");
    await expect(resolveMasterKey({ FOREMAN_MASTER_KEY_FILE: file })).rejects.toThrow(/FOREMAN_MASTER_KEY_FILE/);
  });

  it("runs FOREMAN_MASTER_KEY_CMD and validates trimmed stdout", async () => {
    const cmd = `node -e "console.log('${KEY}')"`;
    expect(await resolveMasterKey({ FOREMAN_MASTER_KEY_CMD: cmd })).toBe(KEY);
  });

  it("FOREMAN_MASTER_KEY_CMD with bad hex output throws, naming the source", async () => {
    const cmd = `node -e "console.log('not-hex')"`;
    await expect(resolveMasterKey({ FOREMAN_MASTER_KEY_CMD: cmd })).rejects.toThrow(/FOREMAN_MASTER_KEY_CMD/);
  });

  it("FOREMAN_MASTER_KEY_CMD that exits non-zero throws, naming the source", async () => {
    const cmd = process.platform === "win32" ? "exit /b 1" : "exit 1";
    await expect(resolveMasterKey({ FOREMAN_MASTER_KEY_CMD: cmd })).rejects.toThrow(/FOREMAN_MASTER_KEY_CMD/);
  });

  it("seals with the resolved key and opens with it too", async () => {
    const key = await resolveMasterKey({ FOREMAN_MASTER_KEY: KEY });
    const sealed = sealPem(PEM, key!);
    expect(openPem(sealed, key)).toBe(PEM);
  });
});
