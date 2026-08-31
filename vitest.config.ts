import { defineConfig } from "vitest/config";

// Each workspace package runs as its own vitest project so per-package config
// applies — apps/web needs jsdom, everything else runs in node.
export default defineConfig({
  test: {
    projects: [
      "apps/api", "apps/github", "apps/mcp", "apps/projector", "apps/scheduler", "apps/web",
      "packages/backbone", "packages/db", "packages/events", "packages/github-client",
    ],
  },
});
