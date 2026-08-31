import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gantt } from "./Gantt.js";
import type { GanttItem } from "./layout.js";

afterEach(cleanup);

const item = (id: string, over: Partial<GanttItem> = {}): GanttItem => ({
  id, title: id, status: "queued", kind: "task", parentId: null,
  startAt: "2026-09-01", targetAt: "2026-09-03", critical: false, slack: null, ...over,
});

describe("Gantt", () => {
  it("virtualises: a 100-item fixture renders at most ~60 bars in a 700px viewport", () => {
    const items = Array.from({ length: 100 }, (_, i) => item(`i${i}`));
    render(<Gantt items={items} deps={[]} viewportHeight={700} onReschedule={() => {}} />);
    const bars = document.querySelectorAll("[data-item-id]");
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.length).toBeLessThanOrEqual(60);
  });

  it("critical items carry the gantt-critical class", () => {
    const items = [item("crit", { critical: true }), item("norm")];
    render(<Gantt items={items} deps={[]} viewportHeight={700} onReschedule={() => {}} />);
    expect(document.querySelector('[data-item-id="crit"]')!.classList.contains("gantt-critical")).toBe(true);
    expect(document.querySelector('[data-item-id="norm"]')!.classList.contains("gantt-critical")).toBe(false);
  });

  it("collapsing a parent removes its children from the DOM", () => {
    const items = [item("E", { kind: "epic" }), item("child", { parentId: "E" })];
    render(<Gantt items={items} deps={[]} viewportHeight={700} onReschedule={() => {}} />);
    expect(document.querySelector('[data-item-id="child"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /collapse E/i }));
    expect(document.querySelector('[data-item-id="child"]')).toBeNull();
  });

  it("dragging a bar 50px fires onReschedule with a 2-day shift", () => {
    const calls: Array<[string, object]> = [];
    const items = [item("drag-me")];
    render(<Gantt items={items} deps={[]} viewportHeight={700}
      onReschedule={(id, change) => calls.push([id, change])} />);
    const bar = document.querySelector('[data-item-id="drag-me"]')!;
    // jsdom has no PointerEvent; MouseEvent carries clientX and React's
    // onPointer* handlers listen by event type, so this exercises the real path.
    const pointer = (type: string, clientX: number) =>
      fireEvent(bar, new MouseEvent(type, { clientX, bubbles: true }));
    pointer("pointerdown", 100);
    pointer("pointermove", 150);
    pointer("pointerup", 150);
    expect(calls).toEqual([["drag-me", { start_at: "2026-09-03", target_at: "2026-09-05" }]]);
  });

  it("draws an arrow between blocker and blocked", () => {
    const items = [item("A"), item("B", { startAt: "2026-09-04", targetAt: "2026-09-05" })];
    render(<Gantt items={items} deps={[{ blocked_id: "B", blocker_id: "A" }]} viewportHeight={700} onReschedule={() => {}} />);
    expect(document.querySelector('[data-arrow="A->B"]')).not.toBeNull();
  });
});
