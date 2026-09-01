import { useState } from "react";

export interface ProjectSettings {
  id: string;
  name: string;
  gh_repos: string[];
  gh_installation_id: number | string | null;
  gh_project_node_id: string | null;
  wip_limit: number;
  stall_threshold_sec: number;
  brief_schedule: "daily" | "weekly" | null;
  brief_timezone: string;
  brief_webhook_url: string | null;
  brief_email: string | null;
}

export interface InstallationRow { installation_id: number | string; account_login: string | null }
export interface TokenRow {
  id: string; created_at: string; last_used_at: string | null; revoked_at: string | null; agent_name: string | null;
}

// Phase 8: everything the quickstart used to do with manual SQL.
export function SettingsTab({ project, installations, tokens, orgSlug, onSave, onMintToken, onRevokeToken, exportUrl }: {
  project: ProjectSettings;
  installations: InstallationRow[];
  tokens: TokenRow[];
  orgSlug: string;
  onSave(body: Record<string, unknown>): void;
  onMintToken(): Promise<{ token_id: string; token: string }>;
  onRevokeToken(id: string): void;
  exportUrl: string;
}) {
  const [ghOrg, setGhOrg] = useState("");
  // The GitHub sync service (manifest flow) runs on its own origin; point the
  // Connect button at whatever origin GitHub can reach it on (the tunnel URL in
  // real use). Defaults to the local dev port.
  const githubOrigin = (import.meta.env.VITE_FOREMAN_GITHUB_URL as string | undefined) ?? "http://localhost:3002";
  const githubConnected = project.gh_installation_id !== null && project.gh_repos.length > 0;
  const startConnect = () => {
    const url = `${githubOrigin}/setup/github/start?org_slug=${encodeURIComponent(orgSlug)}&gh_org=${encodeURIComponent(ghOrg.trim())}`;
    window.open(url, "_blank", "noopener");
  };
  const [form, setForm] = useState({
    repos: project.gh_repos.join(", "),
    installation: project.gh_installation_id === null ? "" : String(project.gh_installation_id),
    board: project.gh_project_node_id ?? "",
    wip: String(project.wip_limit),
    stall: String(project.stall_threshold_sec),
    schedule: project.brief_schedule ?? "",
    timezone: project.brief_timezone,
    webhook: project.brief_webhook_url ?? "",
    email: project.brief_email ?? "",
  });
  const [minted, setMinted] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      gh_repos: form.repos.split(",").map((s) => s.trim()).filter((s) => s !== ""),
      gh_installation_id: form.installation === "" ? null : Number(form.installation),
      gh_project_node_id: form.board === "" ? null : form.board,
      wip_limit: Number(form.wip),
      stall_threshold_sec: Number(form.stall),
      brief_schedule: form.schedule === "" ? null : form.schedule,
      brief_timezone: form.timezone,
      brief_webhook_url: form.webhook === "" ? null : form.webhook,
      brief_email: form.email === "" ? null : form.email,
    });
  };

  const field = "stack gap-2";
  const inputStyle = { width: "100%", maxWidth: 440 } as const;

  return (
    <div className="stack gap-4" style={{ maxWidth: 720 }}>
      <section className="card card--pad stack gap-3">
        <div className="section-head">
          <h3>Integrations</h3>
          <span className="badge" style={githubConnected ? { background: "color-mix(in srgb, var(--success) 16%, transparent)", color: "var(--success)" } : undefined}>
            {githubConnected ? "GitHub connected" : "Not connected"}
          </span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Create a GitHub App in your organisation and install it on your repositories. The bot appears
          as <code>foreman-{orgSlug || "org"}[bot]</code>. Requires the GitHub sync service reachable from
          GitHub (a public tunnel URL in real use).
        </p>
        <div className="row wrap gap-2" style={{ alignItems: "flex-end" }}>
          <label className={field} style={{ flex: "1 1 220px" }}>Your GitHub organisation
            <input name="gh_org" autoComplete="off" spellCheck={false} value={ghOrg}
              onChange={(e) => setGhOrg(e.target.value)} placeholder="acme-inc" /></label>
          <button type="button" className="btn-primary" disabled={ghOrg.trim() === "" || orgSlug === ""} onClick={startConnect}>
            {githubConnected ? "Reconnect GitHub" : "Connect GitHub"}
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
          Slack, GitLab, and other backends are not yet available.
        </p>
      </section>

      <form onSubmit={save} className="stack gap-4">
        <section className="card card--pad stack gap-3">
          <div className="section-head"><h3>GitHub repositories</h3></div>
          <label className={field}>Repositories (owner/name, comma-separated)
            <input name="gh_repos" autoComplete="off" spellCheck={false} style={inputStyle} value={form.repos} onChange={set("repos")} /></label>
          <label className={field}>Installation
            <select style={inputStyle} value={form.installation} onChange={set("installation")}>
              <option value="">— none —</option>
              {installations.map((i) => (
                <option key={String(i.installation_id)} value={String(i.installation_id)}>
                  {i.account_login ?? "installation"} (#{String(i.installation_id)})
                </option>
              ))}
            </select></label>
          <label className={field}>Projects v2 board node id
            <input name="board" autoComplete="off" spellCheck={false} style={inputStyle} value={form.board} onChange={set("board")} placeholder="PVT_…" /></label>
        </section>

        <section className="card card--pad stack gap-3">
          <div className="section-head"><h3>Queue</h3></div>
          <label className={field}>WIP limit
            <input style={inputStyle} type="number" min={1} value={form.wip} onChange={set("wip")} /></label>
          <label className={field}>Stall threshold (seconds)
            <input style={inputStyle} type="number" min={60} value={form.stall} onChange={set("stall")} /></label>
        </section>

        <section className="card card--pad stack gap-3">
          <div className="section-head"><h3>Brief</h3></div>
          <label className={field}>Schedule
            <select style={inputStyle} value={form.schedule} onChange={set("schedule")}>
              <option value="">off</option><option value="daily">daily</option><option value="weekly">weekly</option>
            </select></label>
          <label className={field}>Timezone (IANA)
            <input name="timezone" autoComplete="off" spellCheck={false} style={inputStyle} value={form.timezone} onChange={set("timezone")} /></label>
          <label className={field}>Webhook URL
            <input name="webhook" type="url" autoComplete="off" spellCheck={false} style={inputStyle} value={form.webhook} onChange={set("webhook")} /></label>
          <label className={field}>Email
            <input name="brief_email" type="email" autoComplete="off" style={inputStyle} value={form.email} onChange={set("email")} /></label>
        </section>

        <div><button type="submit" className="btn-primary">Save settings</button></div>
      </form>

      <section className="card card--pad stack gap-3">
        <div className="section-head">
          <h3>Agent tokens</h3>
          <button onClick={() => { void onMintToken().then((t) => setMinted(t.token)); }}>Mint token</button>
        </div>
        {minted !== null && (
          <p className="alert" style={{ margin: 0, background: "var(--accent-tint)", color: "var(--text)", borderColor: "color-mix(in srgb, var(--accent) 30%, transparent)" }}>
            <code style={{ userSelect: "all" }}>{minted}</code> — shown once, copy it now.
          </p>
        )}
        {tokens.length === 0 ? <p className="muted" style={{ margin: 0 }}>No tokens yet.</p> : (
        <div style={{ overflowX: "auto" }}>
        <table>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td><code>{t.id.slice(0, 8)}…</code></td>
                <td>{t.agent_name ?? <span className="muted">unbound</span>}</td>
                <td className="muted">{t.last_used_at === null ? "never used" : `used ${t.last_used_at.slice(0, 10)}`}</td>
                <td>{t.revoked_at !== null ? <span className="badge">revoked</span>
                  : <button className="btn-danger" onClick={() => onRevokeToken(t.id)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
      </section>

      <section className="card card--pad stack gap-2">
        <div className="section-head"><h3>Data</h3></div>
        <p style={{ margin: 0 }}><a href={exportUrl} download>Export the full event log (NDJSON)</a> <span className="muted">— see docs/export.md.</span></p>
      </section>
    </div>
  );
}
