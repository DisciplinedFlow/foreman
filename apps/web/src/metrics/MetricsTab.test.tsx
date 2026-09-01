import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MetricsTab } from "./MetricsTab.js";

afterEach(cleanup);

const metrics = {
  supervised_throughput: { this_week: 5, last_week: 3, all_completions_this_week: 6,
    method: "completions with acceptance verdicts" },
  stall_detection: { median_ms: 90000, p95_ms: 240000, samples: 4 },
  active_agents_24h: 7,
  open_decisions: 2,
  briefs_7d: { generated: 7, delivered: 6 },
  cost_7d: { usd: "12.34", previous_usd: "10.00" },
  lease_expiries_7d: 1,
} as any;

describe("MetricsTab (§1.7)", () => {
  it("renders the tiles with week-over-week delta and formatted stall latency", () => {
    render(<MetricsTab metrics={metrics} />);
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText(/\+2 wk/)).toBeTruthy();          // week-over-week delta pill
    expect(screen.getByText(/6 total completions/)).toBeTruthy();
    expect(screen.getByText(/1\.5m/)).toBeTruthy();   // 90000ms median
    expect(screen.getByText("7")).toBeTruthy();        // active agents
    expect(screen.getByText(/6\s*\/\s*7/)).toBeTruthy(); // briefs delivered/generated
    expect(screen.getByText(/completions with acceptance verdicts/)).toBeTruthy();
  });

  it("handles missing stall samples", () => {
    render(<MetricsTab metrics={{ ...metrics, stall_detection: null }} />);
    expect(screen.getByText(/no stalls detected/i)).toBeTruthy();
  });
});
