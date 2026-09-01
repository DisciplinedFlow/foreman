import { useMemo } from "react";
import { layoutGraph } from "./force.js";

export interface CommNode { id: string; display_name: string; platform: string; status: string; parent_agent_id: string | null }
export interface CommEdge { from: string | null; to: string; kind: "spawn" | "message"; count: number }

const STATUS_FILL: Record<string, string> = {
  working: "var(--ok)", idle: "var(--t3)", blocked: "var(--warn)",
  stalled: "var(--bad)", offline: "var(--t3)", error: "var(--bad)",
};

// AVW-2: the fleet's communication graph — spawn edges solid, messages dashed
// and marching, width ∝ traffic. The table is what people use; this is the show.
export function CommGraph({ nodes, edges, width = 800, height = 500 }: {
  nodes: CommNode[]; edges: CommEdge[]; width?: number; height?: number;
}) {
  const pos = useMemo(() => layoutGraph(nodes, edges.filter((e): e is CommEdge & { from: string } => e.from !== null),
    { width, height }), [nodes, edges, width, height]);

  return (
    <div className="glass" style={{ position: "relative", overflow: "hidden",
      backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)", backgroundSize: "26px 26px" }}>
      <div style={{ position: "absolute", left: "28%", top: "50%", width: 340, height: 340,
        transform: "translate(-50%,-50%)", background: "radial-gradient(circle, var(--accSoft), transparent 65%)", pointerEvents: "none" }} />
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="communication graph" style={{ display: "block" }}>
        {edges.map((e) => {
          if (e.from === null) return null;
          const a = pos.get(e.from), b = pos.get(e.to);
          if (a === undefined || b === undefined) return null;
          const msg = e.kind === "message";
          return (
            <line key={`${e.from}-${e.to}-${e.kind}`} data-edge={`${e.from}->${e.to}`}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              strokeWidth={Math.min(6, 1 + Math.log2(1 + e.count))}
              strokeDasharray={msg ? "6 6" : undefined}
              style={msg
                ? { stroke: "var(--acc)", opacity: 0.75, animation: `dash ${Math.max(0.8, 2 - Math.log2(1 + e.count) * 0.3)}s linear infinite` }
                : { stroke: "var(--line2)" }} />
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id);
          if (p === undefined) return null;
          const orchestrator = n.parent_agent_id === null;
          return (
            <g key={n.id} data-node={n.id} transform={`translate(${p.x}, ${p.y})`}
              style={orchestrator ? { filter: "drop-shadow(0 0 12px var(--acc))" } : undefined}>
              <circle r={14} style={{ fill: STATUS_FILL[n.status] ?? "var(--t3)", stroke: "var(--elev)", strokeWidth: 2 }}>
                <title>{`${n.display_name} (${n.platform}, ${n.status})`}</title>
              </circle>
              <text y={28} textAnchor="middle" fontSize={11} style={{ fill: "var(--t2)", fontFamily: "var(--font)" }}>
                {n.display_name.length > 16 ? `${n.display_name.slice(0, 16)}…` : n.display_name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="row gap-4" style={{ position: "absolute", right: 14, bottom: 12, fontSize: 11.5, color: "var(--t3)",
        background: "var(--frost)", backdropFilter: "blur(18px) saturate(1.4)", WebkitBackdropFilter: "blur(18px) saturate(1.4)",
        border: "1px solid var(--line)", borderRadius: "var(--r-sm)", padding: "8px 12px" }}>
        <span className="row gap-2"><span style={{ width: 18, borderTop: "2px solid var(--line2)" }} />Spawn</span>
        <span className="row gap-2"><span style={{ width: 18, borderTop: "2px dashed var(--acc)" }} />Messages · weight = volume</span>
      </div>
    </div>
  );
}
