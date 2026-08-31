import { describe, it, expect } from "vitest";
import {
  buildScale, buildRows, routeArrow, windowRows, mergeSchedule, type GanttItem,
} from "./layout.js";

const item = (id: string, over: Partial<GanttItem> = {}): GanttItem => ({
  id, title: id, status: "queued", kind: "task", parentId: null,
  startAt: null, targetAt: null, critical: false, slack: null, ...over,
});

const fixture: GanttItem[] = [
  item("E", { kind: "epic", startAt: "2026-09-01", targetAt: "2026-09-06" }),
  item("B", { parentId: "E", startAt: "2026-09-01", targetAt: "2026-09-03" }),
  item("C", { parentId: "E", startAt: "2026-09-03", targetAt: "2026-09-04" }),
  item("D", { startAt: "2026-09-04", targetAt: "2026-09-05" }),
];

describe("buildScale", () => {
  it("maps the earliest date to 0 at pxPerDay resolution", () => {
    const scale = buildScale(fixture, 24);
    expect(scale.x("2026-09-01")).toBe(0);
    expect(scale.x("2026-09-04")).toBe(72);
    expect(scale.start).toBe("2026-09-01");
  });
});

describe("buildRows", () => {
  it("orders depth-first with children under parents", () => {
    const rows = buildRows(fixture, buildScale(fixture, 24), new Set(), 28);
    expect(rows.map((r) => [r.id, r.depth])).toEqual([["E", 0], ["B", 1], ["C", 1], ["D", 0]]);
    expect(rows.map((r) => r.y)).toEqual([0, 28, 56, 84]);
    const b = rows.find((r) => r.id === "B")!;
    expect(b.x).toBe(0);
    expect(b.w).toBe(48); // 2 days
  });

  it("collapsing a parent removes its children", () => {
    const rows = buildRows(fixture, buildScale(fixture, 24), new Set(["E"]), 28);
    expect(rows.map((r) => r.id)).toEqual(["E", "D"]);
  });
});

describe("routeArrow", () => {
  it("routes orthogonally from blocker right edge to blocked left edge", () => {
    const scale = buildScale(fixture, 24);
    const rows = buildRows(fixture, scale, new Set(), 28);
    const b = rows.find((r) => r.id === "B")!;
    const d = rows.find((r) => r.id === "D")!;
    const arrow = routeArrow(b, d, 28);
    const first = arrow.points[0]!;
    const last = arrow.points[arrow.points.length - 1]!;
    expect(first).toEqual([b.x + b.w, b.y + 14]);
    expect(last).toEqual([d.x, d.y + 14]);
    for (let i = 1; i < arrow.points.length; i++) {
      const [x1, y1] = arrow.points[i - 1]!;
      const [x2, y2] = arrow.points[i]!;
      expect(x1 === x2 || y1 === y2).toBe(true); // axis-parallel segments only
    }
  });
});

describe("windowRows", () => {
  it("returns the visible index range plus buffer", () => {
    const many = Array.from({ length: 2000 }, (_, i) => item(`i${i}`));
    const rows = buildRows(many, buildScale(many, 24), new Set(), 28);
    const { first, last } = windowRows(rows, 5600, 700, 28, 10);
    expect(first).toBe(190);   // 5600/28 = 200, minus buffer
    expect(last).toBe(235);    // (5600+700)/28 = 225, plus buffer
  });
});

describe("mergeSchedule", () => {
  it("joins critical/slack onto items", () => {
    const merged = mergeSchedule(fixture, [
      { work_item_id: "B", critical: true, slack: 0 },
      { work_item_id: "C", critical: false, slack: 2 },
    ]);
    expect(merged.find((i) => i.id === "B")!.critical).toBe(true);
    expect(merged.find((i) => i.id === "C")!.slack).toBe(2);
    expect(merged.find((i) => i.id === "D")!.critical).toBe(false);
  });
});
