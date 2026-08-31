export interface Kv {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ttlSec: number): Promise<void>;
  del(k: string): Promise<void>;
}

export class InMemoryKv implements Kv {
  private m = new Map<string, { v: string; exp: number }>();
  async get(k: string) {
    const e = this.m.get(k);
    if (!e || e.exp < Date.now()) { this.m.delete(k); return null; }
    return e.v;
  }
  async set(k: string, v: string, ttlSec: number) { this.m.set(k, { v, exp: Date.now() + ttlSec * 1000 }); }
  async del(k: string) { this.m.delete(k); }
}

// Thin pass-through over a connected `redis` client; only main.ts constructs one.
export class RedisKv implements Kv {
  constructor(private client: { get(k: string): Promise<string | null>; set(k: string, v: string, o: { EX: number }): Promise<unknown>; del(k: string): Promise<unknown> }) {}
  get(k: string) { return this.client.get(k); }
  async set(k: string, v: string, ttlSec: number) { await this.client.set(k, v, { EX: ttlSec }); }
  async del(k: string) { await this.client.del(k); }
}
