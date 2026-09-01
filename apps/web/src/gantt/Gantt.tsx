import { Fragment, useMemo, useState, type CSSProperties } from "react";
import {
  buildScale, buildRows, routeArrow, windowRows, type GanttItem, type GanttRow,
} from "./layout.js";
import { dragResult, type DragMode } from "./drag.js";

const ROW_H = 42;
const LABEL_W = 280;
const HEADER_H = 36;
const BAR_H = 20;
const BAR_EPIC_H = 8;
const DAY_MS = 86_400_000;

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatWeekLabel = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

const STATUS_DOT: Record<string, string> = {
  queued: "var(--t3)", draft: "var(--t3)", claimed: "var(--acc)", in_progress: "var(--acc)",
  in_review: "var(--warn)", blocked: "var(--bad)", failed: "var(--bad)",
  done: "var(--ok)", cancelled: "var(--t3)",
};

interface BarVisual { background: string; border: string; textColor: string }

// §design: bars are styled by kind first (epics render as a thin muted rail),
// then by status. Kept as a pure function so the palette is easy to audit.
function barVisual(row: GanttRow): BarVisual {
  if (row.kind === "epic") return { background: "var(--line2)", border: "none", textColor: "var(--t2)" };
  switch (row.status) {
    case "in_progress":
    case "claimed":
      return { background: "var(--acc)", border: "none", textColor: "#fff" };
    case "in_review":
      return { background: "var(--warnSoft)", border: "1px solid var(--warn)", textColor: "var(--t1)" };
    case "blocked":
    case "failed":
      return { background: "var(--badSoft)", border: "1px solid var(--bad)", textColor: "var(--t1)" };
    case "done":
      return { background: "var(--ctl)", border: "none", textColor: "var(--t1)" };
    case "queued":
    case "draft":
    default:
      return { background: "transparent", border: "1px solid var(--line2)", textColor: "var(--t2)" };
  }
}

export interface GanttProps {
  items: GanttItem[];
  deps: Array<{ blocked_id: string; blocker_id: string }>;
  viewportHeight?: number;
  onReschedule(id: string, change: { start_at?: string; target_at?: string }): void;
}

export function Gantt({ items, deps, viewportHeight = 600, onReschedule }: GanttProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);

  const scale = useMemo(() => buildScale(items), [items]);
  const rows = useMemo(() => buildRows(items, scale, collapsed, ROW_H), [items, scale, collapsed]);
  const { first, last } = windowRows(rows, scrollTop, viewportHeight, ROW_H);
  const visible = rows.slice(first, last + 1);

  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const visibleIds = new Set(visible.map((r) => r.id));
  const arrows = deps
    .map((d) => {
      const from = byId.get(d.blocker_id);
      const to = byId.get(d.blocked_id);
      if (from === undefined || to === undefined) return null;
      if (!visibleIds.has(from.id) && !visibleIds.has(to.id)) return null;
      return routeArrow(from, to, ROW_H);
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);

  const timelineW = Math.max(scale.days * scale.pxPerDay, 200);
  const chartW = LABEL_W + timelineW + 60;
  const totalH = rows.length * ROW_H;

  // Week columns: one per 7-day step from scale.start, used for both the
  // header labels and the vertical gridlines so they line up with the bars.
  const weeks = useMemo(() => {
    const startMs = Date.parse(scale.start);
    const out: string[] = [];
    for (let offset = 0; offset < scale.days; offset += 7) {
      out.push(new Date(startMs + offset * DAY_MS).toISOString().slice(0, 10));
    }
    return out;
  }, [scale]);

  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const todayOffsetDays = Math.round((Date.parse(todayISO) - Date.parse(scale.start)) / DAY_MS);
  const showToday = todayOffsetDays >= 0 && todayOffsetDays < scale.days;
  const todayX = scale.x(todayISO);

  // Drag state: preview locally, commit on pointerup (GNT-8; deviation 4 makes it async).
  const [drag, setDrag] = useState<{ id: string; mode: DragMode; originX: number; dx: number } | null>(null);

  const onBarPointerDown = (row: GanttRow, mode: DragMode) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (row.startAt === null || row.targetAt === null) return; // undated bars aren't draggable
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ id: row.id, mode, originX: e.clientX, dx: 0 });
  };
  const onBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    setDrag((d) => (d === null ? null : { ...d, dx: e.clientX - d.originX }));
  };
  const onBarPointerUp = (row: GanttRow) => (e: React.PointerEvent<HTMLDivElement>) => {
    setDrag((d) => {
      if (d !== null && d.id === row.id) {
        const change = dragResult(row, e.clientX - d.originX, scale.pxPerDay, d.mode);
        if (Object.keys(change).length > 0) onReschedule(row.id, change);
      }
      return null;
    });
  };
  const dragOffset = (row: GanttRow): number =>
    drag !== null && drag.id === row.id && drag.mode === "move" ? drag.dx : 0;
  const dragWiden = (row: GanttRow): number =>
    drag !== null && drag.id === row.id && drag.mode === "resize-end" ? drag.dx : 0;

  const toggle = (row: GanttRow) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });

  return (
    <div
      style={{ overflow: "auto", height: viewportHeight, border: "1px solid var(--line)", borderRadius: "var(--r-md)", background: "var(--surface)" }}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      data-testid="gantt-scroll"
    >
      <div style={{ width: chartW, position: "relative", fontFamily: "var(--font)" }}>
        {/* header: label column + week date columns */}
        <div style={{ position: "sticky", top: 0, zIndex: 3, display: "flex", background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
          <div style={{ width: LABEL_W, flex: "none", boxSizing: "border-box", padding: "10px 16px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--t3)" }}>
            Work item
          </div>
          <div style={{ position: "relative", flex: "none", width: timelineW, height: HEADER_H }}>
            {weeks.map((w) => (
              <div
                key={w}
                style={{
                  position: "absolute", left: scale.x(w), top: 0, bottom: 0,
                  borderLeft: "1px solid var(--line)", boxSizing: "border-box",
                  padding: "10px 0 10px 8px", fontSize: 11, color: "var(--t3)",
                  fontFamily: "var(--mono)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
                }}
              >
                {formatWeekLabel(w)}
              </div>
            ))}
          </div>
        </div>

        {/* rows: SVG gridlines + arrows underneath, HTML label/bar layer on top */}
        <div style={{ position: "relative", height: totalH, width: chartW }}>
          <svg
            width={chartW}
            height={totalH}
            style={{ position: "absolute", top: 0, left: 0 }}
            role="img"
            aria-label="Gantt chart"
          >
            <defs>
              <marker id="gantt-arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--line2)" }} />
              </marker>
            </defs>
            {weeks.map((w) => (
              <line
                key={`grid-${w}`}
                x1={LABEL_W + scale.x(w)} x2={LABEL_W + scale.x(w)}
                y1={0} y2={totalH}
                strokeWidth={1}
                style={{ stroke: "var(--line)" }}
              />
            ))}
            {arrows.map((a) => (
              <polyline
                key={`${a.from}->${a.to}`}
                data-arrow={`${a.from}->${a.to}`}
                points={a.points.map(([x, y]) => `${x + LABEL_W},${y}`).join(" ")}
                fill="none"
                strokeWidth={1.5}
                style={{ stroke: "var(--line2)" }}
                markerEnd="url(#gantt-arrowhead)"
              />
            ))}
          </svg>

          {visible.map((r) => {
            const visual = barVisual(r);
            const barH = r.kind === "epic" ? BAR_EPIC_H : BAR_H;
            const barTop = r.y + (ROW_H - barH) / 2;
            const barW = Math.max(scale.pxPerDay / 2, r.w + dragWiden(r));
            const showLabel = r.kind !== "epic" && barW >= scale.pxPerDay * 12;
            const criticalRing: CSSProperties = r.critical
              ? { boxShadow: "0 0 0 1px var(--acc), 0 4px 14px var(--accSoft)" }
              : {};
            return (
              <Fragment key={r.id}>
                <div
                  style={{
                    position: "absolute", top: r.y, left: 0, width: LABEL_W, height: ROW_H,
                    boxSizing: "border-box", display: "flex", alignItems: "center", gap: 8,
                    padding: `0 16px 0 ${16 + r.depth * 16}px`, minWidth: 0,
                    borderTop: "1px solid var(--line)",
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "none", background: STATUS_DOT[r.status] ?? "var(--t3)" }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--t1)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
                    {r.title}
                  </span>
                  {r.critical && (
                    <span title="Critical path" style={{ color: "var(--acc)", fontSize: 10, flex: "none" }}>◆</span>
                  )}
                  <span style={{ fontSize: 10, color: "var(--t3)", background: "var(--ctl)", borderRadius: 5, padding: "1px 6px", flex: "none", marginLeft: "auto" }}>
                    {r.kind}
                  </span>
                </div>
                <div
                  data-item-id={r.id}
                  className={r.critical ? "gantt-critical" : undefined}
                  title={`${r.title} (${r.status}${r.critical ? ", critical" : ""})`}
                  onPointerDown={onBarPointerDown(r, "move")}
                  onPointerMove={onBarPointerMove}
                  onPointerUp={onBarPointerUp(r)}
                  style={{
                    position: "absolute", top: barTop, left: LABEL_W + r.x + dragOffset(r),
                    width: barW, height: barH, borderRadius: 999, boxSizing: "border-box",
                    background: visual.background, border: visual.border,
                    opacity: r.startAt === null ? 0.4 : 1,
                    display: "flex", alignItems: "center", padding: showLabel ? "0 10px" : 0,
                    overflow: "hidden", cursor: r.startAt !== null ? "grab" : "default", touchAction: "none",
                    ...criticalRing,
                  }}
                >
                  {showLabel && (
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: visual.textColor, whiteSpace: "nowrap" }}>
                      {r.title}
                    </span>
                  )}
                </div>
                {r.startAt !== null && (
                  <div
                    data-resize-id={r.id}
                    onPointerDown={onBarPointerDown(r, "resize-end")}
                    onPointerMove={onBarPointerMove}
                    onPointerUp={onBarPointerUp(r)}
                    style={{
                      position: "absolute", top: barTop, left: LABEL_W + r.x + barW - 6,
                      width: 6, height: barH, background: "transparent",
                      cursor: "ew-resize", touchAction: "none",
                    }}
                  />
                )}
              </Fragment>
            );
          })}

          {/* collapse toggles float over the label column */}
          {visible.filter((r) => r.hasChildren).map((r) => (
            <button
              key={r.id}
              aria-label={`${collapsed.has(r.id) ? "expand" : "collapse"} ${r.title}`}
              onClick={() => toggle(r)}
              style={{
                position: "absolute", top: r.y + (ROW_H - 16) / 2, left: r.depth * 16,
                width: 16, height: 16, padding: 0, border: "none", background: "none", cursor: "pointer",
              }}
            >
              {collapsed.has(r.id) ? "▸" : "▾"}
            </button>
          ))}
        </div>

        {showToday && (
          <>
            <div
              style={{
                position: "absolute", top: 0, bottom: 0, left: LABEL_W + todayX,
                width: 1.5, background: "var(--acc)", opacity: 0.9, pointerEvents: "none", zIndex: 2,
              }}
            />
            <div
              style={{
                position: "absolute", top: HEADER_H + 4, left: LABEL_W + todayX, transform: "translateX(-50%)",
                background: "var(--acc)", color: "#fff", fontSize: 9.5, fontWeight: 700,
                borderRadius: 999, padding: "2px 8px", pointerEvents: "none", zIndex: 3,
              }}
            >
              TODAY
            </div>
          </>
        )}
      </div>
    </div>
  );
}
