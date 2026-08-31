import { useMemo, useState } from "react";

export interface AgentRow {
  id: string;
  display_name: string;
  platform: string;
  model: string | null;
  status: string;
  last_seen_at: string | null;
  work_item_id: string | null;
  work_item_title: string | null;
  external_session_id: string | null;
  tokens_in: number | string | null;
  tokens_out: number | string | null;
  cost_usd: number | string | null;
  started_at: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  working: "#2da44e", idle: "#8b949e", blocked: "#d29922",
  stalled: "#d1242f", offline: "#57606a", error: "#d1242f",
};

type SortKey = "display_name" | "platform" | "status" | "cost" | "last_seen";

// AVW-7: a null field is an integration-depth gap, not an error — render it as
// an em-dash carrying the reason, never as an empty cell.
function Depth({ value }: { value: string | null }) {
  if (value === null) return <span title="not reported by this integration">—</span>;
  return <>{value}</>;
}

function relative(iso: string | null): string | null {
  if (iso === null) return null;
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

import { AgentActions, type DirectiveKind } from "./AgentActions.js";

export function AgentTable({ agents, onAction }: {
  agents: AgentRow[];
  onAction?(agentId: string, kind: DirectiveKind, extra: { message?: string; work_item_id?: string }): void;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);

  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    let out = agents.filter((a) =>
      `${a.display_name} ${a.platform} ${a.status}`.toLowerCase().includes(q));
    if (sort !== null) {
      const val = (a: AgentRow): string | number => {
        switch (sort.key) {
          case "cost": return Number(a.cost_usd ?? 0);
          case "last_seen": return a.last_seen_at ?? "";
          default: return a[sort.key] ?? "";
        }
      };
      out = [...out].sort((x, y) => {
        const a = val(x), b = val(y);
        return (a < b ? -1 : a > b ? 1 : 0) * sort.dir;
      });
    }
    return out;
  }, [agents, filter, sort]);

  const header = (label: string, key: SortKey) => (
    <th>
      <button onClick={() => setSort((s) => ({ key, dir: s?.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
        style={{ all: "unset", cursor: "pointer", fontWeight: 600 }}>
        {label}{sort?.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <div>
      <label>
        Filter{" "}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="name, platform, status" />
      </label>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #d0d7de" }}>
            {header("Name", "display_name")}
            {header("Platform", "platform")}
            <th>Model</th>
            {header("Status", "status")}
            <th>Current work item</th>
            {header("Last seen", "last_seen")}
            <th>Tokens</th>
            {header("Cost", "cost")}
            <th>Session</th>
            {onAction !== undefined && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} style={{ borderBottom: "1px solid #d8dee4" }}>
              <td>{a.display_name}</td>
              <td>{a.platform}</td>
              <td><Depth value={a.model} /></td>
              <td>
                <span style={{ color: STATUS_COLOR[a.status] ?? "#57606a" }}>●</span> {a.status}
              </td>
              <td><Depth value={a.work_item_title} /></td>
              <td><Depth value={relative(a.last_seen_at)} /></td>
              <td>
                <Depth value={a.tokens_in === null && a.tokens_out === null ? null
                  : `${Number(a.tokens_in ?? 0)} / ${Number(a.tokens_out ?? 0)}`} />
              </td>
              <td><Depth value={a.cost_usd === null ? null : `$${Number(a.cost_usd).toFixed(4)}`} /></td>
              <td><Depth value={a.external_session_id} /></td>
              {onAction !== undefined && (
                <td><AgentActions agent={a} onAction={(kind, extra) => onAction(a.id, kind, extra)} /></td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
