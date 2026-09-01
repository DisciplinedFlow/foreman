import { providerFromEnv, type Provider } from "./providers.js";
import { runLoop } from "./loop.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

function pickProvider(): Provider {
  try {
    return providerFromEnv();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const mcpUrl = requireEnv("FOREMAN_MCP_URL");
  const token = requireEnv("FOREMAN_AGENT_TOKEN");
  const provider = pickProvider();
  const model = process.env.FOREMAN_AGENT_MODEL;

  console.log(
    `foreman-agent: provider=${provider.name} model=${model ?? "(unset)"} mcp=${mcpUrl}${once ? " (--once)" : ""}`,
  );

  await runLoop({ mcpUrl, token, provider, model, once });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
