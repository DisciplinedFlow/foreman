import crypto from "node:crypto";

export const COOKIE_NAME = "fmn_session";

const hmac = (v: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(v).digest("hex");

export function signSession(userId: string, secret: string): string {
  return `${userId}.${hmac(userId, secret)}`;
}

export function verifySession(cookie: string | undefined, secret: string): string | null {
  if (cookie === undefined) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = cookie.slice(0, dot);
  const got = Buffer.from(cookie.slice(dot + 1));
  const expected = Buffer.from(hmac(userId, secret));
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  return userId;
}
