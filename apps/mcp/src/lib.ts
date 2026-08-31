// Test-facing surface for cross-app integration tests. Runtime services import
// modules directly, never this.
export { createApp } from "./http.js";
export { createAgentToken, authenticate, type AuthCtx } from "./auth.js";
