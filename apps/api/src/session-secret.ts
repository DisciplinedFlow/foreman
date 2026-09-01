const MIN_LENGTH = 32;
const DEV_DEFAULT = "dev-only-insecure-session-secret-do-not-ship-this!!";

// audit C2: a silent `?? "dev-only-secret"` fallback meant a misconfigured
// production deploy would boot with a short, guessable, well-known secret and
// never notice. Now it's a loud choice: throw before accepting traffic when
// production is misconfigured; warn (never silently substitute) elsewhere.
export function resolveSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.FOREMAN_SESSION_SECRET;
  if (secret !== undefined && secret.length >= MIN_LENGTH) return secret;
  if (env.NODE_ENV === "production") {
    throw new Error(
      `FOREMAN_SESSION_SECRET must be set to a string of at least ${MIN_LENGTH} characters in production`);
  }
  console.warn(
    `FOREMAN_SESSION_SECRET is unset or shorter than ${MIN_LENGTH} characters — ` +
    "falling back to an insecure dev-only default. Set FOREMAN_SESSION_SECRET before deploying to production.");
  return DEV_DEFAULT;
}
