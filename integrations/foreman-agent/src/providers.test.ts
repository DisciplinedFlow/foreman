import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ollamaProvider, openaiProvider, anthropicProvider, googleProvider, providerFromEnv,
} from "./providers.js";

interface Captured { url: string; init: any }

function stubFetch(responseBody: unknown, ok = true): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok, status: ok ? 200 : 500,
      text: async () => JSON.stringify(responseBody),
      json: async () => responseBody,
    } as Response;
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("ollamaProvider", () => {
  it("POSTs to /api/chat with no auth header and parses .message.content", async () => {
    const calls = stubFetch({ message: { content: "hi there" } });
    const p = ollamaProvider("llama3.1", {});
    const out = await p.complete("sys", "hello");

    expect(out).toBe("hi there");
    expect(p.name).toBe("ollama");
    expect(calls[0]!.url).toBe("http://localhost:11434/api/chat");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      model: "llama3.1",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hello" }],
      stream: false,
    });
    const headers = calls[0]!.init.headers ?? {};
    expect(headers.authorization ?? headers.Authorization).toBeUndefined();
  });

  it("honours OLLAMA_URL override", async () => {
    const calls = stubFetch({ message: { content: "ok" } });
    const p = ollamaProvider("m", { OLLAMA_URL: "http://gpu-box:11434" });
    await p.complete("s", "u");
    expect(calls[0]!.url).toBe("http://gpu-box:11434/api/chat");
  });

  it("throws with the response body on a non-ok response", async () => {
    stubFetch({ error: "boom" }, false);
    const p = ollamaProvider("m", {});
    await expect(p.complete("s", "u")).rejects.toThrow(/ollama/i);
  });
});

describe("openaiProvider", () => {
  it("POSTs to chat/completions with bearer auth and parses choices[0].message.content", async () => {
    const calls = stubFetch({ choices: [{ message: { content: "answer" } }] });
    const p = openaiProvider("gpt-4o", { OPENAI_API_KEY: "sk-test" });
    const out = await p.complete("sys", "user");

    expect(out).toBe("answer");
    expect(p.name).toBe("openai");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      model: "gpt-4o",
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "user" }],
    });
  });

  it("honours OPENAI_BASE override", async () => {
    const calls = stubFetch({ choices: [{ message: { content: "x" } }] });
    const p = openaiProvider("m", { OPENAI_API_KEY: "k", OPENAI_BASE: "https://proxy.local/v1" });
    await p.complete("s", "u");
    expect(calls[0]!.url).toBe("https://proxy.local/v1/chat/completions");
  });

  it("throws a clear error when OPENAI_API_KEY is missing", () => {
    expect(() => openaiProvider("gpt-4o", {})).toThrow(/OPENAI_API_KEY/);
  });
});

describe("anthropicProvider", () => {
  it("POSTs to /v1/messages with x-api-key + anthropic-version and parses content[0].text", async () => {
    const calls = stubFetch({ content: [{ type: "text", text: "claude says hi" }] });
    const p = anthropicProvider("claude-fable-5", { ANTHROPIC_API_KEY: "ak-test" });
    const out = await p.complete("system prompt", "user prompt");

    expect(out).toBe("claude says hi");
    expect(p.name).toBe("anthropic");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.init.headers["x-api-key"]).toBe("ak-test");
    expect(calls[0]!.init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.model).toBe("claude-fable-5");
    expect(body.system).toBe("system prompt");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
    expect(typeof body.max_tokens).toBe("number");
  });

  it("throws a clear error when ANTHROPIC_API_KEY is missing", () => {
    expect(() => anthropicProvider("claude-fable-5", {})).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("googleProvider", () => {
  it("POSTs to generateContent with the key as a query param and parses candidates[0].content.parts[0].text", async () => {
    const calls = stubFetch({ candidates: [{ content: { parts: [{ text: "gemini reply" }] } }] });
    const p = googleProvider("gemini-2.5-pro", { GOOGLE_API_KEY: "gk-test" });
    const out = await p.complete("sys", "user");

    expect(out).toBe("gemini reply");
    expect(p.name).toBe("google");
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=gk-test");
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "user" }] }]);
  });

  it("throws a clear error when GOOGLE_API_KEY is missing", () => {
    expect(() => googleProvider("gemini-2.5-pro", {})).toThrow(/GOOGLE_API_KEY/);
  });

  it("percent-encodes a key containing URL-special characters in the query string", async () => {
    const calls = stubFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    const p = googleProvider("gemini-2.5-pro", { GOOGLE_API_KEY: "gk/test+value=1&x" });
    await p.complete("s", "u");
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
      + "?key=gk%2Ftest%2Bvalue%3D1%26x");
  });
});

describe("providerFromEnv", () => {
  it("selects ollama, which needs no key", () => {
    const p = providerFromEnv({ FOREMAN_AGENT_PROVIDER: "ollama", FOREMAN_AGENT_MODEL: "llama3.1" });
    expect(p.name).toBe("ollama");
  });

  it("selects openai and requires OPENAI_API_KEY", () => {
    expect(() => providerFromEnv({ FOREMAN_AGENT_PROVIDER: "openai", FOREMAN_AGENT_MODEL: "gpt-4o" }))
      .toThrow(/OPENAI_API_KEY/);
    const p = providerFromEnv({
      FOREMAN_AGENT_PROVIDER: "openai", FOREMAN_AGENT_MODEL: "gpt-4o", OPENAI_API_KEY: "k",
    });
    expect(p.name).toBe("openai");
  });

  it("selects anthropic and requires ANTHROPIC_API_KEY", () => {
    expect(() => providerFromEnv({ FOREMAN_AGENT_PROVIDER: "anthropic", FOREMAN_AGENT_MODEL: "claude-fable-5" }))
      .toThrow(/ANTHROPIC_API_KEY/);
  });

  it("selects google and requires GOOGLE_API_KEY", () => {
    expect(() => providerFromEnv({ FOREMAN_AGENT_PROVIDER: "google", FOREMAN_AGENT_MODEL: "gemini-2.5-pro" }))
      .toThrow(/GOOGLE_API_KEY/);
  });

  it("throws a clear error for an unrecognised provider name", () => {
    expect(() => providerFromEnv({ FOREMAN_AGENT_PROVIDER: "bogus", FOREMAN_AGENT_MODEL: "m" }))
      .toThrow(/unknown.*FOREMAN_AGENT_PROVIDER/i);
  });

  it("requires FOREMAN_AGENT_PROVIDER and FOREMAN_AGENT_MODEL to be set", () => {
    expect(() => providerFromEnv({})).toThrow(/FOREMAN_AGENT_PROVIDER/);
    expect(() => providerFromEnv({ FOREMAN_AGENT_PROVIDER: "ollama" })).toThrow(/FOREMAN_AGENT_MODEL/);
  });
});
