import { useState } from "react";

export interface EndpointRow {
  id: string;
  gh_repo: string;
  method: string;
  path: string;
  state: string;
  evidence: Array<{ kind: string; ref: string }>;
  work_item_ids: string[];
  in_spec: boolean;
  has_impl: boolean;
  has_test: boolean;
  state_changed_at: string;
}

export interface LifecycleGaps { untested: number; unimplemented: number; unspecced: number }

const STATE_COLOR: Record<string, string> = {
  planned: "#8b949e", stubbed: "#d29922", implemented: "#58a6ff",
  tested: "#2da44e", deployed: "#1a7f37", deprecated: "#57606a",
};

// LFC: progress measured in capability, not commits.
export function LifecycleTab({ endpoints, gaps, onScan, scanning = false }: {
  endpoints: EndpointRow[];
  gaps: LifecycleGaps;
  onScan(): void;
  scanning?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div>
      <p>
        <button onClick={onScan} disabled={scanning}>{scanning ? "Scan queued…" : "Rescan"}</button>{" "}
        <span data-testid="gaps">
          {gaps.untested} implemented without tests · {gaps.unimplemented} spec without implementation · {gaps.unspecced} implemented without spec
        </span>
      </p>
      {endpoints.length === 0 && <p>No endpoints discovered yet — run a scan.</p>}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "2px solid #d0d7de" }}>
            <th>Method</th><th>Path</th><th>State</th><th>Spec</th><th>Test</th><th>Items</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => (
            <>
              <tr key={e.id} style={{ borderBottom: "1px solid #d8dee4", cursor: "pointer" }}
                onClick={() => setOpen(open === e.id ? null : e.id)}>
                <td><code>{e.method}</code></td>
                <td><code>{e.path}</code></td>
                <td>
                  <span style={{ color: STATE_COLOR[e.state] ?? "#57606a" }}>●</span> {e.state}
                </td>
                <td>{e.in_spec ? "✓" : "—"}</td>
                <td>{e.has_test ? "✓" : "—"}</td>
                <td>{e.work_item_ids.length > 0 ? e.work_item_ids.length : "—"}</td>
              </tr>
              {open === e.id && (
                <tr key={`${e.id}-detail`}>
                  <td colSpan={6} style={{ fontSize: 12, padding: "4px 8px" }}>
                    {e.evidence.map((ev, i) => (
                      <code key={i} style={{ marginRight: 8, background: "rgba(175,184,193,0.2)", borderRadius: 4, padding: "1px 4px" }}>
                        {ev.kind}: {ev.ref}
                      </code>
                    ))}
                    {e.evidence.length === 0 && <em>no evidence recorded</em>}
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
