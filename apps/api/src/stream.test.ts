import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase, seedOrgWithUser, type TestDb } from "@foreman/db/testing";
import pg from "pg";
import { createApp } from "./http.js";
import { createEventHub, type EventHub } from "./stream.js";

let db: TestDb;
let appPool: pg.Pool;
let hub: EventHub;
let a: Awaited<ReturnType<typeof seedOrgWithUser>>;
let b: Awaited<ReturnType<typeof seedOrgWithUser>>;
let url: string;
let close: () => Promise<unknown>;
let cookieA: string;

beforeAll(async () => {
  db = await createTestDatabase();
  a = await seedOrgWithUser(db.servicePool, "sse-a");
  b = await seedOrgWithUser(db.servicePool, "sse-b");
  appPool = new pg.Pool({ connectionString: db.appUrl, max: 5 });
  hub = await createEventHub(db.servicePool as pg.Pool);
  const app = createApp({ appPool, servicePool: db.servicePool as pg.Pool, secret: "test-secret", devAuth: true, hub });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close = () => new Promise((r) => server.close(r));
  const res = await fetch(`${url}/auth/dev-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "sse-a@test.local" }),
  });
  cookieA = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(async () => { await close(); await hub.close(); await appPool.end(); await db.teardown(); });

interface Frame { id: string; data: { scopes: string[]; last_event_id: string } }

// Reads SSE frames off a fetch body until predicate or timeout.
async function readFrames(res: Response, count: number, timeoutMs = 4000): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const frames: Frame[] = [];
  const deadline = Date.now() + timeoutMs;
  let buf = "";
  while (frames.length < count && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now())),
    ]);
    if (chunk.done) break;
    buf += new TextDecoder().decode(chunk.value);
    let sep;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, sep); buf = buf.slice(sep + 2);
      const idLine = raw.split("\n").find((l) => l.startsWith("id: "));
      const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
      if (idLine && dataLine) frames.push({ id: idLine.slice(4), data: JSON.parse(dataLine.slice(6)) });
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

const insertEvent = async (type: string) => (await db.servicePool.query(
  `insert into events (organisation_id, project_id, type, payload, occurred_at)
   values ($1,$2,$3,'{}',now()) returning id`, [a.orgId, a.projectId, type])).rows[0].id;

describe("SSE stream", () => {
  it("another org's project stream → 404", async () => {
    const res = await fetch(`${url}/api/projects/${b.projectId}/stream`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });

  it("emits an invalidation frame for a new event and resumes from Last-Event-ID", async () => {
    const res = await fetch(`${url}/api/projects/${a.projectId}/stream`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const id1 = await insertEvent("work.rescheduled");
    const frames = await readFrames(res, 1);
    expect(frames.length).toBe(1);
    expect(frames[0]!.data.scopes).toContain("schedule");
    expect(frames[0]!.data.last_event_id).toBe(String(id1));

    // resume: only events after the cursor arrive
    const id2 = await insertEvent("agent.heartbeat");
    const res2 = await fetch(`${url}/api/projects/${a.projectId}/stream`, {
      headers: { cookie: cookieA, "last-event-id": String(id1) } });
    const frames2 = await readFrames(res2, 1);
    expect(frames2.length).toBe(1);
    expect(frames2[0]!.data.last_event_id).toBe(String(id2));
    expect(frames2[0]!.data.scopes).toContain("agents");
  });
});
