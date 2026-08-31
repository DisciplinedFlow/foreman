import { describe, it, expect } from "vitest";
import { lineDiff } from "./diff.js";

describe("lineDiff (OVW-2)", () => {
  it("marks changed lines as del+add around common context", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "x" },
      { op: "same", text: "c" },
    ]);
  });

  it("identical inputs are all same", () => {
    expect(lineDiff("one\ntwo", "one\ntwo").every((l) => l.op === "same")).toBe(true);
  });

  it("pure additions and removals", () => {
    expect(lineDiff("a", "a\nb")).toEqual([{ op: "same", text: "a" }, { op: "add", text: "b" }]);
    expect(lineDiff("a\nb", "a")).toEqual([{ op: "same", text: "a" }, { op: "del", text: "b" }]);
  });
});
