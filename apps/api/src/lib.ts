// Test-facing surface for cross-app integration tests. Runtime services import
// modules directly, never this.
export { createApp, type ApiDeps } from "./http.js";
export { createEventHub, type EventHub } from "./stream.js";
