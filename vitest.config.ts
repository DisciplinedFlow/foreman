import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Each workspace package runs as its own vitest project so per-package config
// applies — apps/web needs jsdom, everything else runs in node. Paths are
// anchored to this file so `pnpm --filter <pkg> test` (cwd inside the package,
// which walks up to this config) still resolves them.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    projects: [
      "apps/api", "apps/control", "apps/gen", "apps/github", "apps/ingest", "apps/mcp", "apps/projector", "apps/scheduler", "apps/web",
      "packages/backbone", "packages/db", "packages/events", "packages/github-client",
      "integrations/claude-code-plugin", "integrations/agent-sdk",
    ].map((p) => join(root, p)),
  },
});
