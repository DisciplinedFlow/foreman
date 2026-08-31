import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTable, type AgentRow } from "./AgentTable.js";

afterEach(cleanup);

const agents: AgentRow[] = [
  {
    id: "a1", display_name: "worker-1", platform: "claude-code", model: "claude-fable-5",
    status: "working", last_seen_at: new Date().toISOString(),
    work_item_id: "w1", work_item_title: "fix the bug",
    external_session_id: "sess-1", tokens_in: 1000, tokens_out: 500, cost_usd: "0.1234", started_at: null,
  },
  {
    id: "a2", display_name: "worker-2", platform: "codex", model: null,
    status: "idle", last_seen_at: null,
    work_item_id: null, work_item_title: null,
    external_session_id: null, tokens_in: null, tokens_out: null, cost_usd: "0.9000", started_at: null,
  },
];

const rowNames = () => screen.getAllByRole("row").slice(1)
  .map((r) => within(r as HTMLElement).getAllByRole("cell")[0]!.textContent);

describe("AgentTable", () => {
  it("renders rows with formatted cost", () => {
    render(<AgentTable agents={agents} />);
    expect(rowNames()).toEqual(["worker-1", "worker-2"]);
    expect(screen.getByText("$0.1234")).toBeTruthy();
  });

  it("sorting by cost toggles the order", async () => {
    render(<AgentTable agents={agents} />);
    const costHeader = screen.getByRole("button", { name: /cost/i });
    await userEvent.click(costHeader);      // asc: worker-1 first
    expect(rowNames()).toEqual(["worker-1", "worker-2"]);
    await userEvent.click(costHeader);      // desc: worker-2 first
    expect(rowNames()).toEqual(["worker-2", "worker-1"]);
  });

  it("filter narrows rows by substring", async () => {
    render(<AgentTable agents={agents} />);
    await userEvent.type(screen.getByLabelText(/filter/i), "codex");
    expect(rowNames()).toEqual(["worker-2"]);
  });

  it("nulls render as an em-dash with the depth reason (AVW-7)", () => {
    render(<AgentTable agents={agents} />);
    const dash = screen.getAllByTitle("not reported by this integration");
    expect(dash.length).toBeGreaterThan(0);
    expect(dash[0]!.textContent).toBe("—");
  });
});
