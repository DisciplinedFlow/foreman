import crypto from "node:crypto";
import type { Kv } from "./kv.js";

const hash = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v) ?? "null").digest("hex");

// GHA-4: outbound writes record here BEFORE the HTTP call; the reflected webhook
// matches wasOwnWrite and must not re-trigger an outbound write.
export class EchoCache {
  constructor(private kv: Kv, private ttlSec = 60) {}
  private key(entity: string, field: string, value: unknown) { return `ghecho:${entity}:${field}:${hash(value)}`; }
  record(entity: string, field: string, value: unknown) { return this.kv.set(this.key(entity, field, value), "1", this.ttlSec); }
  async wasOwnWrite(entity: string, field: string, value: unknown) { return (await this.kv.get(this.key(entity, field, value))) !== null; }
}
