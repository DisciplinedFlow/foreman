import { describe, it, expect } from "vitest";
import { InMemoryKv } from "./kv.js";
import { EchoCache } from "./echo.js";

describe("EchoCache", () => {
  it("record then wasOwnWrite → true; unseen value → false; different field → false", async () => {
    const echo = new EchoCache(new InMemoryKv());
    await echo.record("ITEM_1", "FIELD_A", { date: "2026-09-15" });
    expect(await echo.wasOwnWrite("ITEM_1", "FIELD_A", { date: "2026-09-15" })).toBe(true);
    expect(await echo.wasOwnWrite("ITEM_1", "FIELD_A", { date: "2026-09-16" })).toBe(false);
    expect(await echo.wasOwnWrite("ITEM_1", "FIELD_B", { date: "2026-09-15" })).toBe(false);
  });
});
