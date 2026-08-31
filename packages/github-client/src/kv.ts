export interface Kv {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ttlSec: number): Promise<void>;
  del(k: string): Promise<void>;
  /** Atomic increment with expiry set on first increment; returns the new count. */
  incr(k: string, ttlSec: number): Promise<number>;
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
  async incr(k: string, ttlSec: number) {
    // NB: no await between read and write — concurrent callers must not
    // interleave (the Phase 7 load harness caught exactly that bug).
    const e = this.m.get(k);
    if (e === undefined || e.exp < Date.now()) {
      this.m.set(k, { v: "1", exp: Date.now() + ttlSec * 1000 });
      return 1;
    }
    const next = Number(e.v) + 1;
    e.v = String(next); // keep the original expiry
    return next;
  }
}

// Thin pass-through over a connected `redis` client; only main.ts constructs one.
export class RedisKv implements Kv {
  constructor(private client: {
    get(k: string): Promise<string | null>;
    set(k: string, v: string, o: { EX: number }): Promise<unknown>;
    del(k: string): Promise<unknown>;
    incr(k: string): Promise<number>;
    expire(k: string, ttlSec: number, mode?: string): Promise<unknown>;
  }) {}
  get(k: string) { return this.client.get(k); }
  async set(k: string, v: string, ttlSec: number) { await this.client.set(k, v, { EX: ttlSec }); }
  async del(k: string) { await this.client.del(k); }
  async incr(k: string, ttlSec: number) {
    const n = await this.client.incr(k);
    if (n === 1) await this.client.expire(k, ttlSec, "NX");
    return n;
  }
}
