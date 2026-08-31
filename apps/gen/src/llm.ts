// The generation seam (OVW deviation 3): ExtractiveLlm is the deterministic
// default — usable with no API key and immune to prompt injection by
// construction, because it only ever formats the evidence lines. AnthropicLlm
// (Task 9) upgrades prose quality when ANTHROPIC_API_KEY is configured.

export interface LlmRequest { system: string; prompt: string }

export interface Llm {
  name: string;
  model: string;
  generate(req: LlmRequest): Promise<string>;
}

import Anthropic from "@anthropic-ai/sdk";

const EVIDENCE_LINE = /^\[([a-z_]+) ([^\]]+)\] (.*)$/;

export class ExtractiveLlm implements Llm {
  name = "extractive";
  model = "none";

  async generate(req: LlmRequest): Promise<string> {
    const start = req.prompt.indexOf("<<<EVIDENCE");
    const end = req.prompt.indexOf("EVIDENCE>>>");
    if (start === -1 || end === -1 || end <= start) return "";
    const lines = req.prompt.slice(start, end).split("\n");
    const bullets: string[] = [];
    for (const line of lines) {
      const m = EVIDENCE_LINE.exec(line.trim());
      if (m !== null) bullets.push(`- ${m[3]} (${m[1]} ${m[2]})`);
    }
    return bullets.join("\n");
  }
}

export class LlmRefusalError extends Error {
  constructor(explanation: string | null) {
    super(`generation refused${explanation !== null ? `: ${explanation}` : ""}`);
    this.name = "LlmRefusalError";
  }
}

// Official SDK, claude-opus-5 (thinking is adaptive by default — omit the param),
// server-side refusal fallbacks on by default per current API guidance. Sections
// are deliberately short, hence the bounded max_tokens.
export class AnthropicLlm implements Llm {
  name = "anthropic";
  model: string;
  private client: Anthropic;

  constructor(opts: { apiKey: string; model?: string; fetchImpl?: typeof fetch }) {
    this.model = opts.model ?? "claude-opus-5";
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.fetchImpl !== undefined ? { fetch: opts.fetchImpl } : {}),
    });
  }

  async generate(req: LlmRequest): Promise<string> {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as Parameters<typeof this.client.beta.messages.create>[0]);
    const msg = response as { stop_reason?: string; stop_details?: { explanation?: string } | null; content: Array<{ type: string; text?: string }> };
    if (msg.stop_reason === "refusal") throw new LlmRefusalError(msg.stop_details?.explanation ?? null);
    const text = msg.content.find((b) => b.type === "text");
    if (text?.text === undefined) throw new Error("no text block in response");
    return text.text;
  }
}

export function llmFromEnv(): Llm {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key === undefined || key === "") return new ExtractiveLlm();
  return new AnthropicLlm({
    apiKey: key,
    ...(process.env.FOREMAN_OVERVIEW_MODEL !== undefined ? { model: process.env.FOREMAN_OVERVIEW_MODEL } : {}),
  });
}
