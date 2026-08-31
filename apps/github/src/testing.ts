import crypto from "node:crypto";

export function signedHeaders(secret: string, body: string, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"),
    "x-github-delivery": crypto.randomUUID(),
    "x-github-event": "issues",
    "x-github-hook-installation-target-id": "1",
    ...extra,
  };
}

export async function seedGithubApp(pool: any, orgId: string, appId = 1, installationId = 777) {
  await pool.query(`insert into github_apps (app_id, slug, private_key_pem, webhook_secret) values ($1,'foreman-test','pem','whsec') on conflict do nothing`, [appId]);
  await pool.query(`insert into github_installations (installation_id, app_id, organisation_id) values ($1,$2,$3) on conflict do nothing`, [installationId, appId, orgId]);
}
