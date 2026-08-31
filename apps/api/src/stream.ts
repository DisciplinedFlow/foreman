import type express from "express";
import type pg from "pg";
import { withUser } from "./rls.js";
import type { ApiDeps, AuthedRequest } from "./http.js";

export interface EventHub {
  subscribe(fn: () => void): () => void;
  close(): Promise<void>;
}

// One LISTEN connection per process (0004 trigger), 2s poll fallback per §7.
export async function createEventHub(servicePool: pg.Pool): Promise<EventHub> {
  const subs = new Set<() => void>();
  const client = await servicePool.connect();
  client.on("notification", () => { for (const fn of subs) fn(); });
  client.on("error", (err) => console.error("event hub listen error", err));
  await client.query("listen foreman_events");
  const interval = setInterval(() => { for (const fn of subs) fn(); }, 2000);

  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async close() { clearInterval(interval); subs.clear(); client.release(); },
  };
}

// Deviation 3: invalidation deltas, not row deltas — the client refetches the scope.
function scopesFor(type: string): string[] {
  if (type.startsWith("agent.")) return ["agents"];
  if (type === "work.rescheduled" || type === "github.project_item_changed") return ["items", "schedule"];
  return ["items", "schedule", "agents"];
}

export function mountStream(api: express.Router, deps: ApiDeps): void {
  api.get("/projects/:id/stream", async (req, res) => {
    const { userId } = req as unknown as AuthedRequest;
    const projectId = req.params.id;

    const visible = await withUser(deps.appPool, userId, async (tx) =>
      (await tx.query("select 1 from projects where id = $1", [projectId])).rowCount !== 0);
    if (!visible) return res.status(404).json({ error: "not found" });
    if (deps.hub === undefined) return res.status(503).json({ error: "stream unavailable" });

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const requested = req.headers["last-event-id"] ?? req.query.after;
    let cursor: string;
    if (typeof requested === "string" && /^\d+$/.test(requested)) {
      cursor = requested;
    } else {
      const max = await deps.servicePool.query("select coalesce(max(id), 0) as id from events");
      cursor = String(max.rows[0].id);
    }

    let busy = false;
    const pump = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        // Org membership was authorised above; servicePool keeps the LISTEN path
        // off the RLS pool and the query is project-scoped.
        const rows = await deps.servicePool.query(
          "select id, type from events where project_id = $1 and id > $2 order by id", [projectId, cursor]);
        if (rows.rowCount === 0) return;
        const scopes = new Set<string>();
        for (const r of rows.rows as Array<{ id: string; type: string }>) {
          for (const s of scopesFor(r.type)) scopes.add(s);
        }
        cursor = String(rows.rows[rows.rows.length - 1].id);
        res.write(`id: ${cursor}\ndata: ${JSON.stringify({ scopes: [...scopes], last_event_id: cursor })}\n\n`);
      } catch (err) {
        console.error("sse pump failed", err);
      } finally {
        busy = false;
      }
    };

    const unsubscribe = deps.hub.subscribe(() => { void pump(); });
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { unsubscribe(); clearInterval(heartbeat); });
    void pump(); // catch anything between cursor snapshot and subscription
  });
}
