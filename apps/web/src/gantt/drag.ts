// Pure pointer-drag math: pixel delta → whole-day snapped date changes.

export type DragMode = "move" | "resize-end";

const DAY_MS = 86_400_000;

const shift = (date: string, days: number): string =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

export function dragResult(
  item: { startAt: string | null; targetAt: string | null },
  dxPx: number,
  pxPerDay: number,
  mode: DragMode,
): { start_at?: string; target_at?: string } {
  if (item.startAt === null || item.targetAt === null) return {};
  const days = Math.round(dxPx / pxPerDay);
  if (days === 0) return {};
  if (mode === "move") {
    return { start_at: shift(item.startAt, days), target_at: shift(item.targetAt, days) };
  }
  // resize-end: never drag the end before start + 1 day
  const minTarget = shift(item.startAt, 1);
  const target = shift(item.targetAt, days);
  return { target_at: target < minTarget ? minTarget : target };
}
