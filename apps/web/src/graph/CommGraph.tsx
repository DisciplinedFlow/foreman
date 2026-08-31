import { useMemo } from "react";
import { layoutGraph } from "./force.js";

export interface CommNode { id: string; display_name: string; platform: string; status: string; parent_agent_id: string | null }
export interface CommEdge { from: string | null; to: string; kind: "spawn" | "message"; count: number }

const STATUS_FILL: Record<string, string> = {
  working: "#2da44e", idle: "#8b949e", blocked: "#d29922",
  stalled: "#d1242f", offline: "#57606a", error: "#d1242f",
};

// AVW-2: the fleet's communication graph — spawn edges solid, messages dashed,
// width ∝ traffic. The table is what people use; this is what they show.
export function CommGraph({ nodes, edges, width = 800, height = 500 }: {
  nodes: CommNode[]; edges: CommEdge[]; width?: number; height?: number;
}) {
  const pos = useMemo(() => layoutGraph(nodes, edges.filter((e): e is CommEdge & { from: string } => e.from !== null),
    { width, height }), [nodes, edges, width, height]);

  return (
    <svg width={width} height={height} role="img" aria-label="communication graph"
      style={{ border: "1px solid #d0d7de", borderRadius: 6 }}>
      {edges.map((e) => {
        if (e.from === null) return null;
        const a = pos.get(e.from), b = pos.get(e.to);
        if (a === undefined || b === undefined) return null;
        return (
          <line key={`${e.from}-${e.to}-${e.kind}`} data-edge={`${e.from}->${e.to}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="#8b949e" strokeWidth={Math.min(6, 1 + Math.log2(1 + e.count))}
            strokeDasharray={e.kind === "message" ? "4 3" : undefined} />
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (p === undefined) return null;
        return (
          <g key={n.id} data-node={n.id} transform={`translate(${p.x}, ${p.y})`}>
            <circle r={14} fill={STATUS_FILL[n.status] ?? "#8b949e"} stroke="#fff" strokeWidth={2}>
              <title>{`${n.display_name} (${n.platform}, ${n.status})`}</title>
            </circle>
            <text y={26} textAnchor="middle" fontSize={11}>
              {n.display_name.length > 16 ? `${n.display_name.slice(0, 16)}…` : n.display_name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
