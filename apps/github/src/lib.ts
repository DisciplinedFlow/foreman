// Test-facing surface for cross-app integration tests (apps/api e2e drains the
// worker in-process). Runtime services import modules directly, never this.
export { claimSyncJob, completeSyncJob, type SyncJob } from "./jobs.js";
export { handleSyncJob, type HandlerContext } from "./handlers/index.js";
export { GithubBackbone } from "./backbone.js";
export { startFakeGithub, type RecordedRequest } from "./fake-github.js";
export { sealPem, openPem, keyFromEnv } from "./crypto.js";
