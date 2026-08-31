// Minimal deterministic force layout — no d3. Seeded initial positions from a
// hash of each node id, fixed iteration count, so the same input always yields
// the same picture (and tests can rely on it).

export interface GraphNode { id: string }
export interface GraphEdge { from: string; to: string }

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 0xffffffff;
};

export function layoutGraph(
  nodes: GraphNode[], edges: GraphEdge[],
  { width, height, iterations = 150 }: { width: number; height: number; iterations?: number },
): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const cx = width / 2, cy = height / 2;
  const radius = Math.min(width, height) * 0.35;
  for (const n of nodes) {
    const angle = hash(n.id) * Math.PI * 2;
    const r = radius * (0.5 + 0.5 * hash(`${n.id}:r`));
    pos.set(n.id, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }

  const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.5;
  const ids = nodes.map((n) => n.id);
  const valid = edges.filter((e) => pos.has(e.from) && pos.has(e.to));

  for (let iter = 0; iter < iterations; iter++) {
    const cool = 1 - iter / iterations;
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));

    // repulsion k²/d between every pair
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]!)!, b = pos.get(ids[j]!)!;
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (k * k) / d / d;
        disp.get(ids[i]!)!.x += dx * f; disp.get(ids[i]!)!.y += dy * f;
        disp.get(ids[j]!)!.x -= dx * f; disp.get(ids[j]!)!.y -= dy * f;
      }
    }
    // spring toward k along edges
    for (const e of valid) {
      const a = pos.get(e.from)!, b = pos.get(e.to)!;
      const dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - k) / d * 0.1;
      disp.get(e.from)!.x -= dx * f; disp.get(e.from)!.y -= dy * f;
      disp.get(e.to)!.x += dx * f; disp.get(e.to)!.y += dy * f;
    }
    // centre gravity + apply with cooling, clamped to bounds
    for (const id of ids) {
      const p = pos.get(id)!, d = disp.get(id)!;
      d.x += (cx - p.x) * 0.01; d.y += (cy - p.y) * 0.01;
      p.x = Math.min(width, Math.max(0, p.x + d.x * cool));
      p.y = Math.min(height, Math.max(0, p.y + d.y * cool));
    }
  }
  return pos;
}
