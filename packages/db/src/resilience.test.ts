import { describe, it, expect } from "vitest";
import pg from "pg";
import { attachPoolErrorHandler, installProcessGuards } from "./resilience.js";

describe("resilience (pg pool + process guards)", () => {
  it("attachPoolErrorHandler stops an unhandled pool 'error' from crashing the process", () => {
    // No DB connection needed — a bare EventEmitter throws synchronously on
    // emit("error", ...) when nothing is listening. Before the fix, this is
    // exactly what took every service down on a DB restart.
    const pool = new pg.Pool({ connectionString: "postgres://unused:unused@localhost:1/unused" });
    attachPoolErrorHandler(pool, "test");
    expect(() => pool.emit("error", new Error("boom"))).not.toThrow();
    void pool.end().catch(() => {});
  });

  it("installProcessGuards registers exactly one unhandledRejection listener even if called twice", () => {
    const before = process.listenerCount("unhandledRejection");
    installProcessGuards("test");
    installProcessGuards("test");
    const after = process.listenerCount("unhandledRejection");
    expect(after - before).toBe(1);

    // Clean up so this doesn't leak a listener into other test files.
    const listeners = process.listeners("unhandledRejection");
    const installed = listeners[listeners.length - 1];
    if (installed) process.removeListener("unhandledRejection", installed as (...args: unknown[]) => void);
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
