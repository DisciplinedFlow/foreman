import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Provider } from "./providers.js";
import { claimNext, runLoop, CLAIM_STOPPED } from "./loop.js";

// runLoop constructs its own `new Client(...)` + StreamableHTTPClientTransport
// internally, so to unit-test the loop's *behaviour* (not the transport) we
// replace the SDK's Client with a fake whose callTool/request we control.
// claimNext, tested separately below, takes a client directly and needs no
// mocking.
const fakeClientState = {
  callTool: vi.fn(),
  request: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => fakeClientState),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

function toolResult(body: unknown, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(body) }] };
}

describe("claimNext (Important 1: SIGINT/idle shutdown)", () => {
  it("returns CLAIM_STOPPED and never polls tasks/get once the stopping flag flips", async () => {
    const requestCalls: unknown[] = [];
    const client = {
      callTool: vi.fn(async () =>
        toolResult({ status: "waiting", task: { taskId: "t1", status: "working", pollInterval: 1 } })),
      request: vi.fn(async (req: unknown) => {
        requestCalls.push(req);
        return { taskId: "t1", status: "working", pollInterval: 1 };
      }),
    } as unknown as Client;

    // Deterministic instead of timing-based: isStopping() flips true on its
    // 3rd call (top-of-function check, while-condition check, post-sleep
    // check) — before any tasks/get round trip has a chance to fire.
    let checks = 0;
    const isStopping = () => { checks += 1; return checks > 2; };

    const result = await claimNext(client, isStopping, () => {});

    expect(result).toBe(CLAIM_STOPPED);
    expect(requestCalls.length).toBe(0);
  });

  it("still resolves an item normally when never asked to stop", async () => {
    const client = {
      callTool: vi.fn(async () => toolResult({ status: "assigned", work_item: { id: "w1", title: "x" } })),
      request: vi.fn(),
    } as unknown as Client;

    const result = await claimNext(client, () => false, () => {});
    expect(result).toEqual({ id: "w1", title: "x" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("still throws when the wait task comes back cancelled or failed", async () => {
    const client = {
      callTool: vi.fn(async () =>
        toolResult({ status: "waiting", task: { taskId: "t1", status: "working", pollInterval: 1 } })),
      request: vi.fn(async () => ({ taskId: "t1", status: "cancelled", pollInterval: 1 })),
    } as unknown as Client;

    await expect(claimNext(client, () => false, () => {})).rejects.toThrow(/cancelled/);
  });
});

describe("runLoop (Important 2: one item's failure must not crash the process)", () => {
  const item = { id: "w1", title: "do a thing", intent: null, acceptance: ["c1"], priority: 1, kind: "task" };

  beforeEach(() => {
    vi.clearAllMocks();
    fakeClientState.connect.mockResolvedValue(undefined);
    fakeClientState.close.mockResolvedValue(undefined);
  });

  it("an empty provider completion does not crash the loop; report/complete get a non-empty fallback", async () => {
    const calls: Record<string, unknown> = {};
    fakeClientState.callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === "foreman__agent_announce") return toolResult({ agent_id: "a1" });
      if (name === "foreman__work_claim") return toolResult({ status: "assigned", work_item: item });
      if (name === "foreman__agent_heartbeat") return toolResult({ ack: true, directives: [] });
      if (name === "foreman__work_report") { calls.report = args; return toolResult({ ack: true }); }
      if (name === "foreman__work_complete") { calls.complete = args; return toolResult({ ack: true }); }
      throw new Error(`unexpected tool ${name}`);
    });

    const provider: Provider = { name: "stub", complete: async () => "" };

    await expect(runLoop({ mcpUrl: "http://x/mcp", token: "t", provider, once: true, log: () => {} }))
      .resolves.toBeUndefined();

    expect((calls.report as any).progress_note).toBe("(no output produced)");
    expect((calls.complete as any).summary).toBe("(no output produced)");
    expect((calls.complete as any).acceptance_results).toEqual([{ criterion: "c1", met: true }]);
    expect(fakeClientState.close).toHaveBeenCalledTimes(1);
  });

  it("a failure completing a work item blocks it and lets the process keep running", async () => {
    let blockArgs: any;
    fakeClientState.callTool.mockImplementation(async ({ name, arguments: args }: any) => {
      if (name === "foreman__agent_announce") return toolResult({ agent_id: "a1" });
      if (name === "foreman__work_claim") return toolResult({ status: "assigned", work_item: item });
      if (name === "foreman__agent_heartbeat") return toolResult({ ack: true, directives: [] });
      if (name === "foreman__work_report") return toolResult({ ack: true });
      if (name === "foreman__work_complete") throw new Error("summary: String must contain at least 1 character(s)");
      if (name === "foreman__work_block") { blockArgs = args; return toolResult({ ack: true }); }
      throw new Error(`unexpected tool ${name}`);
    });

    const provider: Provider = { name: "stub", complete: async () => "did the thing" };

    await expect(runLoop({ mcpUrl: "http://x/mcp", token: "t", provider, once: true, log: () => {} }))
      .resolves.toBeUndefined();

    expect(blockArgs.work_item_id).toBe("w1");
    expect(blockArgs.reason).toMatch(/agent error:.*at least 1 character/);
  });

  it("a cancelled claim task does not crash the process; the loop just tries again", async () => {
    let claimAttempts = 0;
    fakeClientState.callTool.mockImplementation(async ({ name }: any) => {
      if (name === "foreman__agent_announce") return toolResult({ agent_id: "a1" });
      if (name === "foreman__work_claim") {
        claimAttempts += 1;
        return toolResult({ status: "waiting", task: { taskId: `t${claimAttempts}`, status: "working", pollInterval: 1 } });
      }
      throw new Error(`unexpected tool ${name}`);
    });
    fakeClientState.request.mockImplementation(async () => ({ status: "cancelled", pollInterval: 1 }));

    const provider: Provider = { name: "stub", complete: vi.fn() };

    // once:true means: on a claim-time failure, log it and stop rather than
    // spin forever — this proves the throw from claimNext's cancelled branch
    // is caught, not left to crash the process.
    await expect(runLoop({ mcpUrl: "http://x/mcp", token: "t", provider, once: true, log: () => {} }))
      .resolves.toBeUndefined();
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("SIGINT while idle-polling for work makes the loop exit cleanly, without waiting for an item", async () => {
    fakeClientState.callTool.mockImplementation(async ({ name }: any) => {
      if (name === "foreman__agent_announce") return toolResult({ agent_id: "a1" });
      if (name === "foreman__work_claim") {
        return toolResult({ status: "waiting", task: { taskId: "t1", status: "working", pollInterval: 5 } });
      }
      throw new Error(`unexpected tool ${name}`);
    });
    // The wait task never completes — the only way out is the stopping flag.
    fakeClientState.request.mockImplementation(async () => ({ status: "working", pollInterval: 5 }));

    const provider: Provider = { name: "stub", complete: vi.fn() };
    const loopPromise = runLoop({ mcpUrl: "http://x/mcp", token: "t", provider, once: false, log: () => {} });

    await new Promise((r) => setTimeout(r, 25));
    process.emit("SIGINT");

    await expect(loopPromise).resolves.toBeUndefined();
    expect(provider.complete).not.toHaveBeenCalled();
    expect(fakeClientState.close).toHaveBeenCalledTimes(1);
  }, 5000);
});
