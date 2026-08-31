import crypto from "node:crypto";

const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

export function appJwt(appId: number, privateKeyPem: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  const unsigned = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({ iat: t - 60, exp: t + 540, iss: String(appId) })}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKeyPem).toString("base64url");
  return `${unsigned}.${sig}`;
}
