import type pg from "pg";
import { appendEvent } from "@foreman/db";
import type { BriefContent, BriefRow } from "./brief.js";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const section = (title: string, rows: string[]): string =>
  `<h2>${title}</h2>` + (rows.length > 0 ? `<ul>${rows.join("")}</ul>` : "<p><em>nothing here</em></p>");

// BRF-2: every section has content or an explicit "nothing here". X-6: every
// agent-authored string is escaped — a brief is rendered in a mail client.
export function renderBriefHtml(c: BriefContent): string {
  const li = (s: string) => `<li>${s}</li>`;
  return [
    `<h1>Foreman brief</h1>`,
    `<p>${esc(c.window.start)} → ${esc(c.window.end)}</p>`,
    section("Shipped", c.shipped.map((s) => li(`${esc(s.title)} <small>(#${esc(s.work_item_id)}, ${esc(s.completed_at)})</small>`))),
    section("In flight", c.in_flight.map((s) => li(`${esc(s.title)} — ${esc(s.status)}${s.agent !== null ? ` (${esc(s.agent)})` : ""}`))),
    section("Blocked — and why", c.blocked.map((s) => li(`${esc(s.title)}: ${esc(s.reason ?? "no reason recorded")}`))),
    section("Decisions needed from you", c.decisions.map((d) => li(`${esc(d.question)} <small>(#${esc(d.work_item_id)})</small>`))),
    `<h2>Cost</h2><p>$${esc(c.cost.window_usd)} this window (previous: $${esc(c.cost.previous_window_usd)})</p>`,
    `<h2>Forecast</h2><p>${c.forecast.horizon_days === null ? "no schedule yet"
      : `critical path ${c.forecast.horizon_days} days${c.forecast.previous_horizon_days !== null
        ? ` (was ${c.forecast.previous_horizon_days})` : ""}`}</p>`,
    `<h2>Risks</h2><p>${c.risks.stalled_agents} stalled agents · ${c.risks.expired_leases} expired leases · ` +
      `${c.risks.dep_cycle ? "DEPENDENCY CYCLE" : "no dependency cycles"}</p>`,
  ].join("\n");
}

export interface Mailer { send(to: string, subject: string, html: string): Promise<void> }

// Deviation 1: SMTP transport lands with hosted hardening; the seam is the design.
export class LogMailer implements Mailer {
  async send(to: string, subject: string): Promise<void> {
    console.log(`[brief mail] to=${to} subject=${subject} (no SMTP transport configured)`);
  }
}

export async function deliverBrief(
  pool: pg.Pool,
  brief: BriefRow,
  deps: { fetchImpl?: typeof fetch; mailer?: Mailer } = {},
): Promise<string[]> {
  const delivered: string[] = [];
  const proj = await pool.query("select brief_webhook_url from projects where id = $1", [brief.project_id]);
  const webhookUrl: string | null = proj.rows[0]?.brief_webhook_url ?? null;

  if (webhookUrl !== null) {
    const f = deps.fetchImpl ?? fetch;
    try {
      const res = await f(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief_id: brief.id, project_id: brief.project_id,
          window: { start: new Date(brief.window_start).toISOString(), end: new Date(brief.window_end).toISOString() },
          content: brief.content,
        }),
      });
      if (res.ok) {
        await appendEvent(pool, {
          organisation_id: brief.organisation_id, project_id: brief.project_id,
          type: "brief.delivered", payload: { brief_id: brief.id, channel: "webhook" },
        });
        delivered.push("webhook");
      } else {
        console.error(`brief webhook ${webhookUrl} answered ${res.status}`);
      }
    } catch (err) {
      console.error(`brief webhook delivery failed`, err);
    }
  }

  return delivered;
}
