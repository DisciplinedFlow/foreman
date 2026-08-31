import { describe, it, expect } from "vitest";
import { dragResult } from "./drag.js";

const item = { startAt: "2026-09-01", targetAt: "2026-09-05" };

describe("dragResult", () => {
  it("move: +50px at 24px/day snaps to +2 days on both dates", () => {
    expect(dragResult(item, 50, 24, "move")).toEqual({ start_at: "2026-09-03", target_at: "2026-09-07" });
  });
  it("move: negative drag shifts backwards", () => {
    expect(dragResult(item, -49, 24, "move")).toEqual({ start_at: "2026-08-30", target_at: "2026-09-03" });
  });
  it("sub-half-day drags are a no-op", () => {
    expect(dragResult(item, 8, 24, "move")).toEqual({});
  });
  it("resize-end shifts only target_at and clamps to start+1 day", () => {
    expect(dragResult(item, 24, 24, "resize-end")).toEqual({ target_at: "2026-09-06" });
    expect(dragResult(item, -2400, 24, "resize-end")).toEqual({ target_at: "2026-09-02" });
  });
  it("undated items are not draggable", () => {
    expect(dragResult({ startAt: null, targetAt: null }, 100, 24, "move")).toEqual({});
  });
});
