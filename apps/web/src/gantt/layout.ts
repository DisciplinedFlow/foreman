// Pure Gantt geometry — no DOM, no React. Components only render what this computes.

export interface GanttItem {
  id: string;
  title: string;
  status: string;
  kind: string;
  parentId: string | null;
  startAt: string | null;   // YYYY-MM-DD
  targetAt: string | null;
  critical: boolean;
  slack: number | null;
}

export interface GanttRow extends GanttItem {
  y: number;
  x: number;
  w: number;
  depth: number;
  hasChildren: boolean;
}

export interface Arrow {
  from: string;
  to: string;
  points: Array<[number, number]>;
}

export interface Scale {
  x(date: string): number;
  days: number;
  start: string;
  pxPerDay: number;
}

const DAY_MS = 86_400_000;

export function buildScale(items: GanttItem[], pxPerDay = 24): Scale {
  const dates = items.flatMap((i) => [i.startAt, i.targetAt]).filter((d): d is string => d !== null);
  const start = dates.length > 0 ? dates.reduce((a, b) => (a < b ? a : b)) : "1970-01-01";
  const end = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : start;
  const startMs = Date.parse(start);
  return {
    x: (date) => Math.round(((Date.parse(date) - startMs) / DAY_MS) * pxPerDay),
    days: Math.round((Date.parse(end) - startMs) / DAY_MS) + 1,
    start,
    pxPerDay,
  };
}

export function buildRows(
  items: GanttItem[], scale: Scale, collapsedIds: Set<string>, rowHeight = 28,
): GanttRow[] {
  const byParent = new Map<string | null, GanttItem[]>();
  const ids = new Set(items.map((i) => i.id));
  for (const i of items) {
    // A parent outside the item set (cross-project epic) renders the child at root.
    const key = i.parentId !== null && ids.has(i.parentId) ? i.parentId : null;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(i);
  }

  const rows: GanttRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const i of byParent.get(parent) ?? []) {
      const x = i.startAt !== null ? scale.x(i.startAt) : 0;
      const w = i.startAt !== null && i.targetAt !== null
        ? Math.max(scale.pxPerDay, scale.x(i.targetAt) - scale.x(i.startAt))
        : scale.pxPerDay; // undated: ghost bar one day wide
      rows.push({
        ...i, depth, x, w, y: rows.length * rowHeight,
        hasChildren: (byParent.get(i.id) ?? []).length > 0,
      });
      if (!collapsedIds.has(i.id)) walk(i.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

// §7: orthogonal routing — exit the blocker's right edge, stub out, vertical run,
// enter the blocked bar's left edge.
export function routeArrow(from: GanttRow, to: GanttRow, rowHeight = 28): Arrow {
  const mid = rowHeight / 2;
  const startX = from.x + from.w;
  const startY = from.y + mid;
  const endX = to.x;
  const endY = to.y + mid;
  const stub = 8;
  const points: Array<[number, number]> =
    startX + stub <= endX - stub
      ? [[startX, startY], [startX + stub, startY], [startX + stub, endY], [endX, endY]]
      : [
          [startX, startY], [startX + stub, startY],
          [startX + stub, startY + (endY > startY ? mid : -mid)],
          [endX - stub, startY + (endY > startY ? mid : -mid)],
          [endX - stub, endY], [endX, endY],
        ];
  return { from: from.id, to: to.id, points };
}

// GNT-9: only the visible slice (plus buffer) reaches the DOM.
export function windowRows(
  rows: GanttRow[], scrollTop: number, viewportH: number, rowHeight = 28, buffer = 10,
): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
  const last = Math.min(rows.length - 1, Math.floor((scrollTop + viewportH) / rowHeight) + buffer);
  return { first, last };
}

export function mergeSchedule(
  items: GanttItem[],
  schedule: Array<{ work_item_id: string; critical: boolean; slack: number }>,
): GanttItem[] {
  const byId = new Map(schedule.map((s) => [s.work_item_id, s]));
  return items.map((i) => {
    const s = byId.get(i.id);
    return s === undefined ? { ...i, critical: false, slack: null } : { ...i, critical: s.critical, slack: s.slack };
  });
}
