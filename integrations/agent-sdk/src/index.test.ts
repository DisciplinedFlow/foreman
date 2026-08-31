import { describe, it, expect } from "vitest";
import { withForeman } from "./index.js";

const cfg = (fetchImpl?: typeof fetch) => ({
  endpoint: "https://foreman.test",
  token: "fmn_agt_x",
  tenantId: "t1",
  workItemId: "w1",
  ...(fetchImpl !== undefined ? { fetchImpl } : {}),
});

describe("withForeman (§4.4, gate 9)", () => {
  it("injects the foreman http MCP server with bearer auth, preserving existing servers", () => {
    const out = withForeman({ mcpServers: { mine: { type: "stdio", command: "x" } } }, cfg());
    expect((out.mcpServers as any).foreman).toEqual({
      type: "http", url: "https://foreman.test/mcp",
      headers: { Authorization: "Bearer fmn_agt_x" },
    });
    expect((out.mcpServers as any).mine).toEqual({ type: "stdio", command: "x" });
  });

  it("appends hooks for the four events without clobbering existing matchers", () => {
    const existing = { PreToolUse: [{ hooks: [async () => ({})] }] };
    const out = withForeman({ hooks: existing }, cfg());
    const hooks = out.hooks as Record<string, any[]>;
    expect(hooks.PreToolUse!.length).toBe(2);
    for (const ev of ["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"]) {
      expect(hooks[ev]!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("env is spread-preserving (the SDK replaces env wholesale) and tagged", () => {
    process.env.FOREMAN_TEST_MARKER = "keep-me";
    const out = withForeman({ env: { MY_VAR: "1" } }, cfg());
    const env = out.env as Record<string, string>;
    expect(env.FOREMAN_TEST_MARKER).toBe("keep-me");
    expect(env.MY_VAR).toBe("1");
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe("tenant.id=t1,foreman.work_item_id=w1");
    delete process.env.FOREMAN_TEST_MARKER;
  });

  it("hook callbacks POST the hook input to /ingest/hook with the bearer, and never throw", async () => {
    const seen: any[] = [];
    const good = (async (u: any, init: any) => {
      seen.push({ url: String(u), headers: init.headers, body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const out = withForeman({}, cfg(good)) as Record<string, any>;
    const matcher = out.hooks.PreToolUse[0];
    const input = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash" };
    expect(await matcher.hooks[0](input)).toEqual({});
    expect(seen[0].url).toBe("https://foreman.test/ingest/hook");
    expect(seen[0].headers.Authorization).toBe("Bearer fmn_agt_x");
    expect(seen[0].body).toEqual(input);

    const bad = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const out2 = withForeman({}, cfg(bad)) as Record<string, any>;
    await expect(out2.hooks.SessionStart[0].hooks[0]({ session_id: "s2" })).resolves.toEqual({});
  });

  it("leaves unrelated options untouched", () => {
    const out = withForeman({ strictMcpConfig: true, settingSources: [], model: "claude-fable-5" }, cfg());
    expect(out.strictMcpConfig).toBe(true);
    expect(out.settingSources).toEqual([]);
    expect(out.model).toBe("claude-fable-5");
  });
});
