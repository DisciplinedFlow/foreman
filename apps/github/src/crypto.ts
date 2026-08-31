import crypto from "node:crypto";

// Hardening: GitHub App private keys at rest are AES-256-GCM sealed when
// FOREMAN_MASTER_KEY is configured. Un-prefixed (plaintext) values stay readable
// forever; a KMS later replaces only the master-key *source*, not this format.
// Decrypt failures are loud — never a silent plaintext fallback.

const PREFIX = "enc:v1:";

export function keyFromEnv(): string | undefined {
  const v = process.env.FOREMAN_MASTER_KEY;
  if (v === undefined || v === "") return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error("FOREMAN_MASTER_KEY must be 64 hex chars (32 bytes)");
  return v;
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
