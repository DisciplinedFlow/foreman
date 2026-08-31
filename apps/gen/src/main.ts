// foreman-gen service entry. In Phase 4 only brief assembly ships, and the cron
// that calls generateBrief lives in foreman-scheduler; overview and lifecycle
// generation arrive in a later phase.
console.log("foreman-gen: no standalone loop in this phase (brief cron runs in foreman-scheduler)");
