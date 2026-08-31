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
export function SettingsTab({ project, installations, tokens, onSave, onMintToken, onRevokeToken, exportUrl }: {
  project: ProjectSettings;
  installations: InstallationRow[];
  tokens: TokenRow[];
  onSave(body: Record<string, unknown>): void;
  onMintToken(): Promise<{ token_id: string; token: string }>;
  onRevokeToken(id: string): void;
  exportUrl: string;
}) {
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

  const row = { display: "block", margin: "8px 0" } as const;
  const input = { width: "100%", maxWidth: 420 } as const;

  return (
    <div style={{ maxWidth: 640 }}>
      <form onSubmit={save}>
        <h2>GitHub</h2>
        <label style={row}>Repositories (owner/name, comma-separated)
          <input style={input} value={form.repos} onChange={set("repos")} /></label>
        <label style={row}>Installation
          <select style={input} value={form.installation} onChange={set("installation")}>
            <option value="">— none —</option>
            {installations.map((i) => (
              <option key={String(i.installation_id)} value={String(i.installation_id)}>
                {i.account_login ?? "installation"} (#{String(i.installation_id)})
              </option>
            ))}
          </select></label>
        <label style={row}>Projects v2 board node id
          <input style={input} value={form.board} onChange={set("board")} placeholder="PVT_…" /></label>

        <h2>Queue</h2>
        <label style={row}>WIP limit
          <input style={input} type="number" min={1} value={form.wip} onChange={set("wip")} /></label>
        <label style={row}>Stall threshold (seconds)
          <input style={input} type="number" min={60} value={form.stall} onChange={set("stall")} /></label>

        <h2>Brief</h2>
        <label style={row}>Schedule
          <select style={input} value={form.schedule} onChange={set("schedule")}>
            <option value="">off</option><option value="daily">daily</option><option value="weekly">weekly</option>
          </select></label>
        <label style={row}>Timezone (IANA)
          <input style={input} value={form.timezone} onChange={set("timezone")} /></label>
        <label style={row}>Webhook URL
          <input style={input} value={form.webhook} onChange={set("webhook")} /></label>
        <label style={row}>Email
          <input style={input} value={form.email} onChange={set("email")} /></label>

        <button type="submit">Save settings</button>
      </form>

      <h2>Agent tokens</h2>
      <button onClick={() => { void onMintToken().then((t) => setMinted(t.token)); }}>Mint token</button>
      {minted !== null && (
        <p>
          <code style={{ background: "rgba(210,153,34,0.15)", padding: "2px 6px" }}>{minted}</code>{" "}
          <strong>shown once</strong> — copy it now.
        </p>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id} style={{ borderBottom: "1px solid #d8dee4" }}>
              <td><code>{t.id.slice(0, 8)}…</code></td>
              <td>{t.agent_name ?? "unbound"}</td>
              <td>{t.last_used_at === null ? "never used" : `used ${t.last_used_at.slice(0, 10)}`}</td>
              <td>{t.revoked_at !== null ? "revoked"
                : <button onClick={() => onRevokeToken(t.id)}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Data</h2>
      <p><a href={exportUrl} download>Export the full event log (NDJSON)</a> — see docs/export.md.</p>
    </div>
  );
}
