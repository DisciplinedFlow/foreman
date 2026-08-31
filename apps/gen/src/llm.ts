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
