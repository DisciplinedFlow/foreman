import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentActions } from "./AgentActions.js";

afterEach(cleanup);

const agent = (over: object = {}) => ({
  id: "a1", display_name: "worker-1", status: "working", work_item_id: "w1", ...over,
}) as any;

describe("AgentActions", () => {
  it("pause click calls onAction('pause', {})", async () => {
    const calls: Array<[string, object]> = [];
    render(<AgentActions agent={agent()} onAction={(k, e) => calls.push([k, e])} />);
    await userEvent.click(screen.getByRole("button", { name: /pause/i }));
    expect(calls).toEqual([["pause", {}]]);
  });

  it("a stalled/idle agent offers Resume instead of Pause", async () => {
    const calls: Array<[string, object]> = [];
    render(<AgentActions agent={agent({ status: "stalled" })} onAction={(k, e) => calls.push([k, e])} />);
    await userEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(calls).toEqual([["resume", {}]]);
  });

  it("message flow sends the typed text", async () => {
    const calls: Array<[string, object]> = [];
    render(<AgentActions agent={agent()} onAction={(k, e) => calls.push([k, e])} />);
    await userEvent.click(screen.getByRole("button", { name: /message/i }));
    await userEvent.type(screen.getByLabelText(/message/i), "wrap up please");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(calls).toEqual([["message", { message: "wrap up please" }]]);
  });

  it("cancel item only shows when the agent holds an item and sends its id", async () => {
    const calls: Array<[string, object]> = [];
    const { unmount } = render(<AgentActions agent={agent({ work_item_id: null })} onAction={() => {}} />);
    expect(screen.queryByRole("button", { name: /cancel item/i })).toBeNull();
    unmount();
    render(<AgentActions agent={agent()} onAction={(k, e) => calls.push([k, e])} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel item/i }));
    expect(calls).toEqual([["cancel_item", { work_item_id: "w1" }]]);
  });
});
