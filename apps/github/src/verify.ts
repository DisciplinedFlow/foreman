import crypto from "node:crypto";

// GHA-2 step 2: SHA-256 header only (SHA-1 ignored), constant-time compare.
export function verifySignature(secret: string, rawBody: Buffer, sigHeader: string | undefined): boolean {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex"));
  const got = Buffer.from(sigHeader);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
