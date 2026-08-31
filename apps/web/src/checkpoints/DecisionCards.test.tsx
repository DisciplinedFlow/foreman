import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DecisionCards, type CheckpointRow } from "./DecisionCards.js";

afterEach(cleanup);

const cp = (over: Partial<CheckpointRow> = {}): CheckpointRow => ({
  id: "cp-1", work_item_id: "w1", work_item_title: "rate limiter", question: "which store?",
  options: ["redis", "postgres"], context: null, created_at: new Date().toISOString(), ...over,
});

describe("DecisionCards", () => {
  it("renders the question and one button per option; clicking answers with the label", async () => {
    const calls: Array<[string, string]> = [];
    render(<DecisionCards checkpoints={[cp()]} onAnswer={(id, a) => calls.push([id, a])} />);
    expect(screen.getByText("which store?")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "redis" }));
    expect(calls).toEqual([["cp-1", "redis"]]);
  });

  it("a checkpoint without options gets a free-text input + send", async () => {
    const calls: Array<[string, string]> = [];
    render(<DecisionCards checkpoints={[cp({ id: "cp-2", options: null })]} onAnswer={(id, a) => calls.push([id, a])} />);
    await userEvent.type(screen.getByLabelText(/answer/i), "use sqlite");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(calls).toEqual([["cp-2", "use sqlite"]]);
  });

  it("renders nothing when there are no open checkpoints", () => {
    const { container } = render(<DecisionCards checkpoints={[]} onAnswer={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
