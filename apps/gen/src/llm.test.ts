import { describe, it, expect, afterEach } from "vitest";
import { AnthropicLlm, ExtractiveLlm, llmFromEnv } from "./llm.js";

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

function stub(status: number, body: object) {
  const seen: any[] = [];
  const f = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}

const ok = {
  id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5",
  content: [{ type: "text", text: "generated section" }],
  stop_reason: "end_turn", stop_details: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

describe("AnthropicLlm", () => {
  it("calls the messages API with the pinned model, system and prompt, and returns the text", async () => {
    const { f, seen } = stub(200, ok);
    const llm = new AnthropicLlm({ apiKey: "sk-test", fetchImpl: f });
    const out = await llm.generate({ system: "rules", prompt: "write it" });
    expect(out).toBe("generated section");
    expect(seen[0].url).toContain("/v1/messages");
    expect(seen[0].body.model).toBe("claude-opus-5");
    expect(seen[0].body.system).toBe("rules");
    expect(seen[0].body.messages).toEqual([{ role: "user", content: "write it" }]);
    expect(seen[0].body.fallbacks).toBe("default");
    expect(llm.model).toBe("claude-opus-5");
  });

  it("a refusal stop reason surfaces as a typed error, never as content", async () => {
    const { f } = stub(200, { ...ok, content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "no" } });
    const llm = new AnthropicLlm({ apiKey: "sk-test", fetchImpl: f });
    await expect(llm.generate({ system: "s", prompt: "p" })).rejects.toThrow(/refus/i);
  });
});

describe("llmFromEnv", () => {
  it("returns ExtractiveLlm without a key and AnthropicLlm with one", () => {
    expect(llmFromEnv()).toBeInstanceOf(ExtractiveLlm);
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(llmFromEnv()).toBeInstanceOf(AnthropicLlm);
  });
});
