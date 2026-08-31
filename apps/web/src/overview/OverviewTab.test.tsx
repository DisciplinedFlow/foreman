import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OverviewTab, type OverviewSection } from "./OverviewTab.js";

afterEach(cleanup);

const sections: OverviewSection[] = [
  { section_id: "shipped", version: 3, content: "we shipped things", sources: [{ type: "work_item", ref: "w1" }],
    pinned: false, human_authored: false, updated_at: new Date().toISOString() },
  { section_id: "purpose", version: 1, content: "the point of it all", sources: [{ type: "project", ref: "p1" }],
    pinned: true, human_authored: true, updated_at: new Date().toISOString() },
];

describe("OverviewTab", () => {
  it("renders sections with content, sources, and a pinned badge", () => {
    render(<OverviewTab sections={sections} onOverride={() => {}} onRegenerate={() => {}} />);
    expect(screen.getByText("we shipped things")).toBeTruthy();
    expect(screen.getByText(/work_item w1/)).toBeTruthy();
    expect(screen.getAllByText(/pinned/i).length).toBeGreaterThanOrEqual(1);
  });

  it("edit → save fires onOverride with the new content", async () => {
    const calls: Array<[string, object]> = [];
    render(<OverviewTab sections={sections} onOverride={(s, b) => calls.push([s, b])} onRegenerate={() => {}} />);
    await userEvent.click(screen.getAllByRole("button", { name: /edit/i })[0]!);
    const box = screen.getByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, "my correction");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(calls).toEqual([["shipped", { content: "my correction" }]]);
  });

  it("pin toggle and regenerate fire their callbacks", async () => {
    const overrides: Array<[string, object]> = [];
    let regen = 0;
    render(<OverviewTab sections={sections} onOverride={(s, b) => overrides.push([s, b])} onRegenerate={() => { regen++; }} />);
    await userEvent.click(screen.getAllByRole("button", { name: /^pin$/i })[0]!);
    expect(overrides).toEqual([["shipped", { pinned: true }]]);
    await userEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(regen).toBe(1);
  });
});
