import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LifecycleTab, type EndpointRow } from "./LifecycleTab.js";

afterEach(cleanup);

const endpoints: EndpointRow[] = [
  { id: "e1", gh_repo: "o/r", method: "POST", path: "/users", state: "tested",
    evidence: [{ kind: "impl", ref: "src/server.ts" }, { kind: "test", ref: "tests/server.test.ts" }],
    work_item_ids: ["w1"], in_spec: true, has_impl: true, has_test: true, state_changed_at: new Date().toISOString() },
  { id: "e2", gh_repo: "o/r", method: "GET", path: "/health", state: "stubbed",
    evidence: [{ kind: "impl", ref: "src/server.ts" }],
    work_item_ids: [], in_spec: false, has_impl: true, has_test: false, state_changed_at: new Date().toISOString() },
];

describe("LifecycleTab (LFC-3/4)", () => {
  it("renders states and the gaps summary", () => {
    render(<LifecycleTab endpoints={endpoints}
      gaps={{ untested: 1, unimplemented: 0, unspecced: 1 }} onScan={() => {}} />);
    expect(screen.getByText("tested")).toBeTruthy();
    expect(screen.getByText("stubbed")).toBeTruthy();
    expect(screen.getByTestId("gaps").textContent).toContain("1 implemented without tests");
  });

  it("clicking a row shows its evidence refs", async () => {
    render(<LifecycleTab endpoints={endpoints}
      gaps={{ untested: 0, unimplemented: 0, unspecced: 0 }} onScan={() => {}} />);
    await userEvent.click(screen.getByText("/users"));
    expect(screen.getByText(/impl: src\/server\.ts/)).toBeTruthy();
  });

  it("rescan fires onScan", async () => {
    let scans = 0;
    render(<LifecycleTab endpoints={[]} gaps={{ untested: 0, unimplemented: 0, unspecced: 0 }}
      onScan={() => { scans++; }} />);
    await userEvent.click(screen.getByRole("button", { name: /rescan/i }));
    expect(scans).toBe(1);
  });
});
