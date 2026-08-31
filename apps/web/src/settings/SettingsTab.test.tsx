import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsTab, type TokenRow } from "./SettingsTab.js";

afterEach(cleanup);

const project = {
  id: "p1", name: "proj", gh_repos: ["acme/app"], gh_installation_id: 1111, gh_project_node_id: null,
  wip_limit: 10, stall_threshold_sec: 900, brief_schedule: null, brief_timezone: "UTC",
  brief_webhook_url: null, brief_email: null,
} as any;
const installations = [{ installation_id: 1111, account_login: "acme" }] as any[];
const tokens: TokenRow[] = [
  { id: "t1", created_at: new Date().toISOString(), last_used_at: null, revoked_at: null, agent_name: null },
];

describe("SettingsTab", () => {
  it("save PATCHes the parsed shape (repos comma-split, numbers numeric)", async () => {
    const saves: object[] = [];
    render(<SettingsTab project={project} installations={installations} tokens={tokens}
      onSave={(b) => saves.push(b)} onMintToken={async () => ({ token_id: "x", token: "fmn_agt_x" })}
      onRevokeToken={() => {}} exportUrl="/api/projects/p1/export" />);
    const repos = screen.getByLabelText(/repositories/i);
    await userEvent.clear(repos);
    await userEvent.type(repos, "acme/app, acme/web");
    const wip = screen.getByLabelText(/wip limit/i);
    await userEvent.clear(wip);
    await userEvent.type(wip, "25");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(saves[0]).toMatchObject({ gh_repos: ["acme/app", "acme/web"], wip_limit: 25 });
  });

  it("mint reveals the token once; revoke calls back", async () => {
    const revoked: string[] = [];
    render(<SettingsTab project={project} installations={installations} tokens={tokens}
      onSave={() => {}} onMintToken={async () => ({ token_id: "t2", token: "fmn_agt_SECRET" })}
      onRevokeToken={(id) => revoked.push(id)} exportUrl="#" />);
    await userEvent.click(screen.getByRole("button", { name: /mint/i }));
    expect(await screen.findByText("fmn_agt_SECRET")).toBeTruthy();
    expect(screen.getByText(/shown once/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /revoke/i }));
    expect(revoked).toEqual(["t1"]);
  });

  it("renders the export link", () => {
    render(<SettingsTab project={project} installations={installations} tokens={tokens}
      onSave={() => {}} onMintToken={async () => ({ token_id: "x", token: "y" })}
      onRevokeToken={() => {}} exportUrl="/api/projects/p1/export" />);
    const link = screen.getByRole("link", { name: /export/i });
    expect(link.getAttribute("href")).toBe("/api/projects/p1/export");
  });
});
