import { useEffect, useRef, useState } from "react";

export interface BoardItem {
  id: string;
  title: string;
  kind: string;
  status: string;
  priority: number;
}

// The six board stages. Each is owned by a specialised agent role (§4). Work
// items map in by status; "Reviewed" and "Deployed" fill in from PR-review and
// deployment signals (no per-item field yet — they render empty until then).
const COLUMNS: Array<{ key: string; name: string; statuses: string[]; owner: string }> = [
  { key: "backlog",    name: "Backlog",     statuses: ["draft", "queued"],               owner: "backlog-analyst" },
  { key: "onhold",     name: "On hold",     statuses: ["blocked"],                        owner: "triage-agent" },
  { key: "inprogress", name: "In progress", statuses: ["claimed", "in_progress", "in_review"], owner: "delivery-lead" },
  { key: "done",       name: "Done",        statuses: ["done"],                           owner: "qa-agent" },
  { key: "reviewed",   name: "Reviewed",    statuses: [],                                 owner: "review-agent" },
  { key: "deployed",   name: "Deployed",    statuses: [],                                 owner: "release-agent" },
];

const META_COLOR = (p: number) => (p <= 50 ? "var(--acc)" : p >= 150 ? "var(--t3)" : "var(--t2)");
const priorityLabel = (p: number) => (p <= 50 ? "P1" : p <= 100 ? "P2" : "P3");

function group(items: BoardItem[]): Record<string, BoardItem[]> {
  const cols: Record<string, BoardItem[]> = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
  const byStatus: Record<string, string> = {};
  for (const c of COLUMNS) for (const s of c.statuses) byStatus[s] = c.key;
  for (const it of items) {
    const col = byStatus[it.status] ?? "backlog";
    cols[col]!.push(it);
  }
  return cols;
}

// Column -> the human-settable status a drop into it persists as (registry:
// work.status_changed accepts queued|blocked|in_review|done|cancelled).
// "In progress" is queue-owned (claimed/in_progress are set by the worker on
// claim/lease) — dropping into it is a local-only move, no persist call.
const PERSIST_STATUS: Record<string, string | null> = {
  backlog: "queued", onhold: "blocked", inprogress: null,
  done: "done", reviewed: "in_review", deployed: "done",
};

// §4: the Board. Stage-owning agents plus full drag-and-drop. Card moves are
// optimistic and local first; PATCH .../status persists them (work.status_changed).
export function Board({ items, onMove }: { items: BoardItem[]; onMove?: (itemId: string, toStatus: string) => void }) {
  const [cols, setCols] = useState<Record<string, BoardItem[]>>(() => group(items));
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  // Re-sync when the server sends new items (SSE), unless mid-drag. Reading
  // dragging via a ref (not a dependency) matters: dragging flips to null the
  // instant a drop finishes, and if that flip re-ran this effect against the
  // still-stale `items` prop it would immediately snap the optimistic move
  // back — the one case where that's visible and permanent is the queue-owned
  // "in progress" column, which never gets a persisted status to resync from.
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  useEffect(() => { if (draggingRef.current === null) setCols(group(items)); }, [items]);

  const onDrop = (toCol: string) => {
    const draggedId = dragging;
    setCols((prev) => {
      if (dragging === null) return prev;
      const next: Record<string, BoardItem[]> = {};
      let moved: BoardItem | undefined;
      for (const [k, list] of Object.entries(prev)) {
        next[k] = list.filter((c) => { if (c.id === dragging) { moved = c; return false; } return true; });
      }
      if (moved) next[toCol] = [...(next[toCol] ?? []), moved];
      return next;
    });
    setOver(null);
    setDragging(null);
    const toStatus = PERSIST_STATUS[toCol] ?? null;
    if (draggedId !== null && toStatus !== null) onMove?.(draggedId, toStatus);
  };

  const total = items.length;

  return (
    <div>
      <div className="section-head">
        <div className="stack" style={{ gap: 2 }}>
          <h2>Board</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>Every stage is owned by a specialised agent — add work by voice or keyboard.</span>
        </div>
      </div>

      {total === 0 ? (
        <div className="empty"><span className="empty__title">No work yet</span><span>Create an item on the Gantt, or speak one with Foreman Voice.</span></div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, alignItems: "start" }}>
          {COLUMNS.map((col) => {
            const cards = cols[col.key] ?? [];
            const isOver = over === col.key;
            return (
              <div key={col.key} data-col={col.key}
                onDragOver={(e) => { e.preventDefault(); setOver(col.key); }}
                onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                onDrop={() => onDrop(col.key)}
                className="glass"
                style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, minHeight: 220,
                  borderColor: isOver ? "var(--acc)" : "var(--line)", transition: "border-color 0.2s" }}>
                <div className="row" style={{ justifyContent: "space-between", padding: "0 2px" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 650 }}>{col.name}</span>
                  <span className="badge" style={{ borderRadius: "var(--r-pill)", fontVariantNumeric: "tabular-nums" }}>{cards.length}</span>
                </div>
                <div className="row gap-2" title="This agent owns the stage — it triages, transitions, and reports"
                  style={{ background: "var(--ctl)", border: "1px solid var(--line)", borderRadius: "var(--r-pill)", padding: "5px 10px" }}>
                  <span className="status-dot" style={{ margin: 0, background: "var(--t3)" }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{col.owner}</span>
                  <span style={{ fontSize: 10, color: "var(--t3)", marginLeft: "auto" }}>idle</span>
                </div>
                {cards.map((k) => (
                  <div key={k.id} draggable data-item-id={k.id}
                    onDragStart={() => setDragging(k.id)}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                    style={{ background: "var(--elev)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)",
                      padding: "10px 11px", cursor: "grab", display: "flex", flexDirection: "column", gap: 7,
                      opacity: dragging === k.id ? 0.35 : 1, transition: "opacity 0.2s" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.35 }}>{k.title}</span>
                    <div className="row gap-2">
                      <span style={{ fontSize: 9.5, color: "var(--t3)", background: "var(--ctl)", borderRadius: 5, padding: "1px 6px" }}>{k.kind}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: META_COLOR(k.priority), marginLeft: "auto" }}>{priorityLabel(k.priority)}</span>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 12 }}>
        Drag a card between stages — the owning agent verifies exit criteria before the transition commits.
      </div>
    </div>
  );
}
