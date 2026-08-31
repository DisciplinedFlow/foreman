import { describe, it, expect } from "vitest";
import { layoutGraph } from "./force.js";

const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
const edges = [{ from: "a", to: "b" }];
const opts = { width: 800, height: 500 };

const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
  Math.hypot(p.x - q.x, p.y - q.y);

describe("layoutGraph", () => {
  it("is deterministic: two runs give identical positions", () => {
    const p1 = layoutGraph(nodes, edges, opts);
    const p2 = layoutGraph(nodes, edges, opts);
    expect([...p1.entries()]).toEqual([...p2.entries()]);
  });

  it("connected nodes end closer than unconnected ones", () => {
    const p = layoutGraph(nodes, edges, opts);
    expect(dist(p.get("a")!, p.get("b")!)).toBeLessThan(dist(p.get("c")!, p.get("d")!));
  });

  it("all positions stay within bounds", () => {
    const p = layoutGraph(nodes, edges, opts);
    for (const { x, y } of p.values()) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(800);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(500);
    }
  });
});
