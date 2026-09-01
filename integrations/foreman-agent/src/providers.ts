// Provider adapters are dependency-free: `fetch` only, no `openai`/`ollama`/`@google/*`
// packages. Provider API keys live only in this process's environment — Foreman
// services never see them (the control plane doesn't run models).

export interface Provider {
  name: string;
  complete(system: string, user: string): Promise<string>;
}

export type Env = Record<string, string | undefined>;

function requireKey(env: Env, key: string, provider: string): string {
  const value = env[key];
  if (!value) throw new Error(`${provider} provider requires ${key} to be set`);
  return value;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, provider: string): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${provider} request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function ollamaProvider(model: string, env: Env = process.env): Provider {
  const base = env.OLLAMA_URL ?? "http://localhost:11434";
  return {
    name: "ollama",
    async complete(system, user) {
      const data = await postJson(`${base}/api/chat`, {}, {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: false,
      }, "ollama");
      return data.message.content;
    },
  };
}

export function openaiProvider(model: string, env: Env = process.env): Provider {
  const key = requireKey(env, "OPENAI_API_KEY", "openai");
  const base = env.OPENAI_BASE ?? "https://api.openai.com/v1";
  return {
    name: "openai",
    async complete(system, user) {
      const data = await postJson(`${base}/chat/completions`, { Authorization: `Bearer ${key}` }, {
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }, "openai");
      return data.choices[0].message.content;
    },
  };
}

const ANTHROPIC_MAX_TOKENS = 4096;

export function anthropicProvider(model: string, env: Env = process.env): Provider {
  const key = requireKey(env, "ANTHROPIC_API_KEY", "anthropic");
  return {
    name: "anthropic",
    async complete(system, user) {
      const data = await postJson("https://api.anthropic.com/v1/messages", {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      }, {
        model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      }, "anthropic");
      return data.content[0].text;
    },
  };
}

export function googleProvider(model: string, env: Env = process.env): Provider {
  const key = requireKey(env, "GOOGLE_API_KEY", "google");
  return {
    name: "google",
    async complete(system, user) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const data = await postJson(url, {}, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
      }, "google");
      return data.candidates[0].content.parts[0].text;
    },
  };
}

const BUILDERS: Record<string, (model: string, env: Env) => Provider> = {
  ollama: ollamaProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
};

export function providerFromEnv(env: Env = process.env): Provider {
  const providerName = env.FOREMAN_AGENT_PROVIDER;
  if (!providerName) throw new Error("FOREMAN_AGENT_PROVIDER is required (ollama|openai|anthropic|google)");
  const model = env.FOREMAN_AGENT_MODEL;
  if (!model) throw new Error("FOREMAN_AGENT_MODEL is required");
  const build = BUILDERS[providerName];
  if (!build) {
    throw new Error(`unknown FOREMAN_AGENT_PROVIDER: ${providerName} (expected ollama|openai|anthropic|google)`);
  }
  return build(model, env);
}
