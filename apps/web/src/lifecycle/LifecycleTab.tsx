import { Fragment, useState } from "react";

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
    <div className="stack gap-4">
      <div className="section-head">
        <div className="row wrap gap-2" data-testid="gaps">
          <span className="badge">{gaps.untested} untested</span>
          <span className="badge">{gaps.unimplemented} unimplemented</span>
          <span className="badge">{gaps.unspecced} unspecced</span>
        </div>
        <button onClick={onScan} disabled={scanning}>{scanning ? "Scan queued…" : "Rescan"}</button>
      </div>
      {endpoints.length === 0 ? (
        <div className="empty"><span className="empty__title">No endpoints discovered</span><span>Run a scan to map the repo's lifecycle.</span></div>
      ) : (
      <div className="card" style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Method</th><th>Path</th><th>State</th><th>Spec</th><th>Test</th><th>Items</th>
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => (
            <Fragment key={e.id}>
              <tr style={{ cursor: "pointer" }} onClick={() => setOpen(open === e.id ? null : e.id)}>
                <td><code>{e.method}</code></td>
                <td><code>{e.path}</code></td>
                <td>
                  <span aria-hidden className="status-dot" style={{ background: STATE_COLOR[e.state] ?? "var(--text-3)" }} /> {e.state}
                </td>
                <td>{e.in_spec ? "✓" : "—"}</td>
                <td>{e.has_test ? "✓" : "—"}</td>
                <td>{e.work_item_ids.length > 0 ? e.work_item_ids.length : "—"}</td>
              </tr>
              {open === e.id && (
                <tr>
                  <td colSpan={6}>
                    <div className="row wrap gap-2">
                      {e.evidence.map((ev, i) => (
                        <span key={i} className="chip">{ev.kind}: {ev.ref}</span>
                      ))}
                      {e.evidence.length === 0 && <em className="muted">no evidence recorded</em>}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
      )}
    </div>
  );
}
