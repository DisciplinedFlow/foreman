import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "foreman-plugin");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

// Verified against code.claude.com/docs 31-08-2026 (SPEC §11 item 8).
const DOCUMENTED_EVENTS = new Set([
  "SessionStart", "Setup", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse",
  "PermissionRequest", "PermissionDenied", "PostToolUse", "PostToolUseFailure", "PostToolBatch",
  "Notification", "MessageDisplay", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted",
  "Stop", "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange", "CwdChanged",
  "DirectoryAdded", "FileChanged", "WorktreeCreate", "WorktreeRemove", "PreCompact", "PostCompact",
  "PreModelSwitch", "PostModelSwitch", "Elicitation", "ElicitationResult",
]);
const OUR_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop", "Notification"];

describe("foreman plugin package", () => {
  it("hooks.json subscribes to exactly the seven verified events", () => {
    const hooks = read("hooks/hooks.json").hooks;
    expect(Object.keys(hooks).sort()).toEqual([...OUR_EVENTS].sort());
    for (const name of Object.keys(hooks)) expect(DOCUMENTED_EVENTS.has(name)).toBe(true);
  });

  it("every hook is http, authorised, endpoint-substituted, and never async (http hooks don't support it)", () => {
    const hooks = read("hooks/hooks.json").hooks;
    for (const entries of Object.values<any>(hooks)) {
      for (const entry of entries) {
        for (const h of entry.hooks) {
          expect(h.type).toBe("http");
          expect(h.url.startsWith("${user_config.endpoint}")).toBe(true);
          expect(h.headers.Authorization).toBe("Bearer ${user_config.token}");
          expect(h.async).toBeUndefined();
          expect(typeof h.timeout).toBe("number");
        }
      }
    }
  });

  it("plugin.json userConfig entries carry type/title/description; token is sensitive", () => {
    const plugin = read(".claude-plugin/plugin.json");
    expect(plugin.name).toBe("foreman");
    for (const cfg of Object.values<any>(plugin.userConfig)) {
      expect(typeof cfg.type).toBe("string");
      expect(typeof cfg.title).toBe("string");
      expect(typeof cfg.description).toBe("string");
    }
    expect(plugin.userConfig.token.sensitive).toBe(true);
    expect(plugin.hooks).toBe("./hooks/hooks.json");
    expect(plugin.mcpServers).toBe("./.mcp.json");
  });

  it(".mcp.json wires the foreman MCP server with bearer auth", () => {
    const mcp = read(".mcp.json");
    expect(mcp.mcpServers.foreman.url).toBe("${user_config.endpoint}/mcp");
    expect(mcp.mcpServers.foreman.headers.Authorization).toBe("Bearer ${user_config.token}");
  });

  it("the skill teaches the work loop", () => {
    const skill = readFileSync(join(root, "skills/foreman/SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: foreman")).toBe(true);
    for (const tool of ["foreman__agent_announce", "foreman__work_claim", "foreman__work_report",
      "foreman__work_checkpoint", "foreman__work_complete"]) {
      expect(skill).toContain(tool);
    }
  });
});
