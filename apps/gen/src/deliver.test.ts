import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import type pg from "pg";
import { renderBriefHtml, deliverBrief } from "./deliver.js";
import { generateBrief } from "./brief.js";
import type { BriefContent } from "./brief.js";

let db: TestDb;
let orgId: string;
let projectId: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ({ orgId, projectId } = await seedOrgWithUser(db.servicePool, "deliver"));
});
afterAll(async () => { await db.teardown(); });

const emptyContent: BriefContent = {
  window: { start: "2026-08-30T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z" },
  shipped: [], in_flight: [], blocked: [], decisions: [],
  cost: { window_usd: "0.00", previous_window_usd: "0.00" },
  forecast: { horizon_days: null, previous_horizon_days: null },
  risks: { stalled_agents: 0, expired_leases: 0, dep_cycle: false },
};

describe("renderBriefHtml (BRF-2, X-6)", () => {
  it("escapes agent-authored text and renders 'nothing here' for empty sections", () => {
    const html = renderBriefHtml({
      ...emptyContent,
      shipped: [{ work_item_id: "w1", title: "<script>alert(1)</script>", completed_at: "2026-08-30T12:00:00.000Z" }],
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect((html.match(/nothing here/gi) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("deliverBrief (BRF-4)", () => {
  async function makeBrief(webhookUrl: string | null) {
    await db.servicePool.query("update projects set brief_webhook_url=$2 where id=$1", [projectId, webhookUrl]);
    return generateBrief(db.servicePool as pg.Pool, projectId);
  }

  it("POSTs to the webhook and appends brief.delivered on 2xx", async () => {
    const seen: any[] = [];
    const brief = await makeBrief("https://hooks.test/brief");
    const channels = await deliverBrief(db.servicePool as pg.Pool, brief, {
      fetchImpl: (async (u: any, init: any) => { seen.push({ url: String(u), body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); }) as typeof fetch,
    });
    expect(channels).toEqual(["webhook"]);
    expect(seen[0].url).toBe("https://hooks.test/brief");
    expect(seen[0].body.brief_id).toBe(brief.id);
    const e = await db.servicePool.query(
      "select 1 from events where type='brief.delivered' and payload->>'brief_id'=$1", [brief.id]);
    expect(e.rowCount).toBe(1);
  });

  it("a failing webhook logs and appends nothing", async () => {
    const brief = await makeBrief("https://hooks.test/broken");
    const channels = await deliverBrief(db.servicePool as pg.Pool, brief, {
      fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
    });
    expect(channels).toEqual([]);
    const e = await db.servicePool.query(
      "select 1 from events where type='brief.delivered' and payload->>'brief_id'=$1", [brief.id]);
    expect(e.rowCount).toBe(0);
  });

  it("email channel: brief_email + mailer → html sent and brief.delivered {email}", async () => {
    await db.servicePool.query(
      "update projects set brief_email='pm@test.local', brief_webhook_url=null where id=$1", [projectId]);
    const brief = await generateBrief(db.servicePool as pg.Pool, projectId);
    const sent: any[] = [];
    const channels = await deliverBrief(db.servicePool as pg.Pool, brief, {
      mailer: { send: async (to, subject, html) => { sent.push({ to, subject, html }); } },
    });
    expect(channels).toEqual(["email"]);
    expect(sent[0].to).toBe("pm@test.local");
    expect(sent[0].html).toContain("Foreman brief");
    const e = await db.servicePool.query(
      "select 1 from events where type='brief.delivered' and payload->>'brief_id'=$1 and payload->>'channel'='email'",
      [brief.id]);
    expect(e.rowCount).toBe(1);
    await db.servicePool.query("update projects set brief_email=null where id=$1", [projectId]);
  });

  it("SmtpMailer sends through nodemailer (jsonTransport)", async () => {
    const { SmtpMailer } = await import("./deliver.js");
    const mailer = new SmtpMailer({ jsonTransport: true } as any);
    await expect(mailer.send("x@test.local", "subject", "<p>hi</p>")).resolves.toBeUndefined();
  });

  it("no webhook URL → no fetch at all", async () => {
    let called = 0;
    const brief = await makeBrief(null);
    await deliverBrief(db.servicePool as pg.Pool, brief, {
      fetchImpl: (async () => { called++; return new Response("{}"); }) as typeof fetch,
    });
    expect(called).toBe(0);
  });
});
