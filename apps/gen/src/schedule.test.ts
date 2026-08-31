import { describe, it, expect } from "vitest";
import { briefDue, localParts } from "./schedule.js";

const AMS = "Europe/Amsterdam";

describe("localParts", () => {
  it("converts UTC into the project timezone", () => {
    // 2026-08-31 05:30 UTC = 07:30 CEST
    const p = localParts(new Date("2026-08-31T05:30:00Z"), AMS);
    expect(p).toMatchObject({ y: 2026, m: 8, d: 31, hour: 7, dow: 1 }); // Monday
  });
});

describe("briefDue (BRF-1)", () => {
  it("daily fires at 07:05 local, not 06:55", () => {
    // CEST = UTC+2 → 07:05 local = 05:05 UTC
    expect(briefDue("daily", AMS, null, new Date("2026-08-31T05:05:00Z"))).toBe(true);
    expect(briefDue("daily", AMS, null, new Date("2026-08-31T04:55:00Z"))).toBe(false);
  });

  it("does not double-fire after a brief generated the same local day", () => {
    const generatedAt = new Date("2026-08-31T05:06:00Z");
    expect(briefDue("daily", AMS, generatedAt, new Date("2026-08-31T10:00:00Z"))).toBe(false);
    expect(briefDue("daily", AMS, generatedAt, new Date("2026-09-01T05:05:00Z"))).toBe(true);
  });

  it("weekly fires only on the local Monday", () => {
    // 2026-08-31 is a Monday; 2026-09-01 a Tuesday
    expect(briefDue("weekly", AMS, null, new Date("2026-08-31T05:10:00Z"))).toBe(true);
    expect(briefDue("weekly", AMS, null, new Date("2026-09-01T05:10:00Z"))).toBe(false);
    const generatedMonday = new Date("2026-08-31T05:11:00Z");
    expect(briefDue("weekly", AMS, generatedMonday, new Date("2026-08-31T09:00:00Z"))).toBe(false);
    expect(briefDue("weekly", AMS, generatedMonday, new Date("2026-09-07T05:10:00Z"))).toBe(true);
  });

  it("DST spring-forward morning (2026-03-29 Amsterdam) still fires exactly once", () => {
    // clocks jump 02:00→03:00; 07:06 local = 05:06 UTC (now CEST)
    const prevDay = new Date("2026-03-28T06:05:00Z"); // 07:05 CET the day before
    expect(briefDue("daily", AMS, prevDay, new Date("2026-03-29T05:06:00Z"))).toBe(true);
    const generated = new Date("2026-03-29T05:06:00Z");
    expect(briefDue("daily", AMS, generated, new Date("2026-03-29T10:00:00Z"))).toBe(false);
  });

  it("null schedule is never due", () => {
    expect(briefDue(null, AMS, null, new Date("2026-08-31T05:05:00Z"))).toBe(false);
  });
});
