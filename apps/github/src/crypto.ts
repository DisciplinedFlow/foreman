import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

// Hardening: GitHub App private keys at rest are AES-256-GCM sealed when
// FOREMAN_MASTER_KEY is configured. Un-prefixed (plaintext) values stay readable
// forever; a KMS later replaces only the master-key *source*, not this format.
// Decrypt failures are loud — never a silent plaintext fallback.

const PREFIX = "enc:v1:";
const HEX64 = /^[0-9a-fA-F]{64}$/;
const execFile = promisify(execFileCb);

export function keyFromEnv(): string | undefined {
  const v = process.env.FOREMAN_MASTER_KEY;
  if (v === undefined || v === "") return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error("FOREMAN_MASTER_KEY must be 64 hex chars (32 bytes)");
  return v;
}

function assertHex(v: string, source: string): string {
  if (!HEX64.test(v)) throw new Error(`${source} must be 64 hex chars (32 bytes)`);
  return v;
}

// Pluggable master-key source, KMS-ready: the key material can come from an env
// var, a file (e.g. a mounted secret), or a command (e.g. a KMS/vault CLI) —
// same 64-hex validation regardless of source, so a bad key from any source
// throws loudly instead of silently falling through to unencrypted storage.
// Precedence: FOREMAN_MASTER_KEY > FOREMAN_MASTER_KEY_FILE > FOREMAN_MASTER_KEY_CMD.
export async function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const fromEnv = env.FOREMAN_MASTER_KEY;
  if (fromEnv !== undefined && fromEnv !== "") return assertHex(fromEnv, "FOREMAN_MASTER_KEY");

  const file = env.FOREMAN_MASTER_KEY_FILE;
  if (file !== undefined && file !== "") {
    let raw: string;
    try {
      raw = (await readFile(file, "utf8")).trim();
    } catch (err) {
      throw new Error(`FOREMAN_MASTER_KEY_FILE: failed to read "${file}": ${(err as Error).message}`);
    }
    return assertHex(raw, "FOREMAN_MASTER_KEY_FILE");
  }

  const cmd = env.FOREMAN_MASTER_KEY_CMD;
  if (cmd !== undefined && cmd !== "") {
    // windowsVerbatimArguments: cmd.exe's own /c parsing (not CommandLineToArgvW)
    // must see the command string's quotes exactly as written, or Node's default
    // argv-escaping mangles them and cmd.exe silently runs nothing.
    let stdout: string;
    try {
      ({ stdout } = process.platform === "win32"
        ? await execFile("cmd", ["/c", cmd], { windowsVerbatimArguments: true })
        : await execFile("/bin/sh", ["-c", cmd]));
    } catch (err) {
      throw new Error(`FOREMAN_MASTER_KEY_CMD: command failed: ${(err as Error).message}`);
    }
    return assertHex(stdout.trim(), "FOREMAN_MASTER_KEY_CMD");
  }

  return undefined;
}

export function sealPem(pem: string, masterKeyHex: string): string {
  const key = Buffer.from(masterKeyHex, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(pem, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function openPem(stored: string, masterKeyHex: string | undefined): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext row
  if (masterKeyHex === undefined) {
    throw new Error("encrypted app key present but no master key configured (FOREMAN_MASTER_KEY)");
  }
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(":");
  if (ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new Error("malformed enc:v1 payload");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(masterKeyHex, "hex"), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
