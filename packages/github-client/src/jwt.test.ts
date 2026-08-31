import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { appJwt } from "./jwt.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("appJwt", () => {
  it("emits verifiable RS256 with iat -60s, exp +540s, iss = app id", () => {
    const now = new Date("2026-08-31T12:00:00Z"); // epoch 1788177600
    const jwt = appJwt(12345, pem, now);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`),
      publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toEqual({ iat: 1788177540, exp: 1788178140, iss: "12345" });
  });
});
