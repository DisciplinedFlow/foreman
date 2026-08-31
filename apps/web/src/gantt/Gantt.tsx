import { useMemo, useState } from "react";
import {
  buildScale, buildRows, routeArrow, windowRows, type GanttItem, type GanttRow,
} from "./layout.js";

const ROW_H = 28;
const LABEL_W = 220;

const STATUS_FILL: Record<string, string> = {
  queued: "#8b949e", claimed: "#58a6ff", in_progress: "#2da44e", blocked: "#d29922",
  in_review: "#a371f7", done: "#1a7f37", cancelled: "#57606a", failed: "#d1242f", draft: "#d0d7de",
};

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

  const chartW = LABEL_W + Math.max(scale.days * scale.pxPerDay, 200) + 60;
  const totalH = rows.length * ROW_H;
  // touched by Task 10 (drag); void-referenced so the prop is wired from day one
  void onReschedule;

  const toggle = (row: GanttRow) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });

  return (
    <div
      style={{ overflow: "auto", height: viewportHeight, border: "1px solid #d0d7de" }}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      data-testid="gantt-scroll"
    >
      <div style={{ height: totalH, width: chartW, position: "relative" }}>
        <svg
          width={chartW}
          height={totalH}
          style={{ position: "absolute", top: 0, left: 0 }}
          role="img"
          aria-label="Gantt chart"
        >
          {/* arrows under the bars */}
          {arrows.map((a) => (
            <polyline
              key={`${a.from}->${a.to}`}
              data-arrow={`${a.from}->${a.to}`}
              points={a.points.map(([x, y]) => `${x + LABEL_W},${y}`).join(" ")}
              fill="none"
              stroke="#8b949e"
              strokeWidth={1.5}
              markerEnd="url(#gantt-arrowhead)"
            />
          ))}
          <defs>
            <marker id="gantt-arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#8b949e" />
            </marker>
          </defs>
          {visible.map((r) => (
            <g key={r.id} transform={`translate(0, ${r.y})`}>
              <text x={8 + r.depth * 16} y={ROW_H / 2 + 4} fontSize={12}>
                {r.title.length > 24 ? `${r.title.slice(0, 24)}…` : r.title}
              </text>
              <rect
                data-item-id={r.id}
                className={r.critical ? "gantt-critical" : ""}
                x={LABEL_W + r.x}
                y={5}
                width={r.w}
                height={ROW_H - 10}
                rx={4}
                fill={STATUS_FILL[r.status] ?? "#8b949e"}
                stroke={r.critical ? "#d1242f" : "none"}
                strokeWidth={r.critical ? 2.5 : 0}
                opacity={r.startAt === null ? 0.35 : 1}
              >
                <title>{`${r.title} (${r.status}${r.critical ? ", critical" : ""})`}</title>
              </rect>
            </g>
          ))}
        </svg>
        {/* collapse toggles are HTML on top of the SVG for accessibility */}
        {visible.filter((r) => r.hasChildren).map((r) => (
          <button
            key={r.id}
            aria-label={`${collapsed.has(r.id) ? "expand" : "collapse"} ${r.title}`}
            onClick={() => toggle(r)}
            style={{
              position: "absolute", top: r.y + 5, left: r.depth * 16 - 8,
              width: 16, height: 16, padding: 0, border: "none", background: "none", cursor: "pointer",
            }}
          >
            {collapsed.has(r.id) ? "▸" : "▾"}
          </button>
        ))}
      </div>
    </div>
  );
}
