// @foreman/agent-sdk — SPEC §4.4, built against the option names verified
// 31-08-2026 (§11 item 9): mcpServers http entry {type,url,headers}; programmatic
// hooks Partial<Record<HookEvent, HookCallbackMatcher[]>>; env REPLACES
// process.env when set, so we spread-preserve. Deliberately no dependency on
// @anthropic-ai/claude-agent-sdk: pass the result straight into your query().
//
//   import { query } from "@anthropic-ai/claude-agent-sdk";
//   import { withForeman } from "@foreman/agent-sdk";
//   for await (const msg of query({ prompt, options: withForeman(options, cfg) })) { … }

export interface ForemanConfig {
  endpoint: string;      // base URL of the Foreman deployment
  token: string;         // fmn_agt_ project-scoped agent token
  tenantId?: string;
  workItemId?: string;
  fetchImpl?: typeof fetch;
}

type HookCallback = (input: unknown) => Promise<Record<string, never>>;
interface HookMatcher { hooks: HookCallback[] }

const HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"] as const;

export function withForeman<T extends Record<string, unknown>>(options: T, cfg: ForemanConfig): T {
  const f = cfg.fetchImpl ?? fetch;

  // Fire the hook payload at ingest; never block or fail the agent (§4.1 hard rule).
  const report: HookCallback = async (input) => {
    try {
      await f(`${cfg.endpoint}/ingest/hook`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(input),
      });
    } catch { /* telemetry must never break the fleet */ }
    return {};
  };

  const existingHooks = (options.hooks ?? {}) as Record<string, HookMatcher[]>;
  const hooks: Record<string, HookMatcher[]> = { ...existingHooks };
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [...(hooks[ev] ?? []), { hooks: [report] }];
  }

  const tags = [
    ...(cfg.tenantId !== undefined ? [`tenant.id=${cfg.tenantId}`] : []),
    ...(cfg.workItemId !== undefined ? [`foreman.work_item_id=${cfg.workItemId}`] : []),
  ];

  return {
    ...options,
    mcpServers: {
      ...((options.mcpServers ?? {}) as Record<string, unknown>),
      foreman: {
        type: "http",
        url: `${cfg.endpoint}/mcp`,
        headers: { Authorization: `Bearer ${cfg.token}` },
      },
    },
    hooks,
    // Gate 9: the SDK replaces env wholesale — preserve process.env and caller vars.
    env: {
      ...process.env,
      ...((options.env ?? {}) as Record<string, string>),
      ...(tags.length > 0 ? { OTEL_RESOURCE_ATTRIBUTES: tags.join(",") } : {}),
    },
  };
}
