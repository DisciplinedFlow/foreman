// Cross-app surface: apps/api e2e tests drain the worker in-process, and
// apps/scheduler ticks reapStuckSyncJobs (audit #1). Runtime code inside
// this app imports modules directly, never this.
export { claimSyncJob, completeSyncJob, reapStuckSyncJobs, type SyncJob } from "./jobs.js";
export { handleSyncJob, type HandlerContext } from "./handlers/index.js";
export { GithubBackbone } from "./backbone.js";
export { startFakeGithub, type RecordedRequest } from "./fake-github.js";
export { sealPem, openPem, keyFromEnv, resolveMasterKey } from "./crypto.js";
