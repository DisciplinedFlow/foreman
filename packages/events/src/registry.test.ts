import { describe, expect, it } from "vitest";
import { EVENT_TYPES, validateEventPayload } from "./index.js";

describe("event registry", () => {
  it("contains the full SPEC §2.2 taxonomy", () => {
    for (const t of ["agent.announced","work.claimed","comm.subagent_spawned","tool.invoked","github.issue_synced","overview.regenerated","human.decided","work.lease_expired","brief.delivered","deploy.failed"]) {
      expect(EVENT_TYPES).toContain(t);
    }
    expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(36);
  });
  it("accepts a valid payload", () => {
    const r = validateEventPayload("work.progressed", { note: "half done", percent: 50 });
    expect(r.ok).toBe(true);
  });
  it("rejects unknown event types", () => {
    expect(validateEventPayload("work.hacked", {}).ok).toBe(false);
  });
  it("rejects extra keys (closed schemas)", () => {
    expect(validateEventPayload("agent.resumed", { surprise: 1 }).ok).toBe(false);
  });
  it("rejects wrong field types", () => {
    expect(validateEventPayload("work.reprioritised", { from: "high", to: 1 }).ok).toBe(false);
  });
  it("tool.invoked default shape is metadata-only", () => {
    expect(validateEventPayload("tool.invoked", { tool_name: "Bash", tool_use_id: "tu_1" }).ok).toBe(true);
    // input is permitted only as an explicit opt-in field, present-but-optional in the schema:
    expect(validateEventPayload("tool.invoked", { tool_name: "Bash", tool_use_id: "tu_1", input: { cmd: "ls" } }).ok).toBe(true);
  });
  it("rejects prototype-chain names as unknown event types", () => {
    for (const t of ["constructor","toString","hasOwnProperty","__proto__","valueOf"]) {
      const r = validateEventPayload(t, {});
      expect(r.ok).toBe(false);
    }
  });
});
