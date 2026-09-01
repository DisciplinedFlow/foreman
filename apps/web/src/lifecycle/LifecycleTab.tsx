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
  planned: "var(--t3)", stubbed: "var(--warn)", implemented: "var(--acc)",
  tested: "var(--ok)", deployed: "var(--ok)", deprecated: "var(--t3)",
};
const VERB_COLOR: Record<string, string> = {
  GET: "var(--ok)", POST: "var(--acc)", PUT: "var(--warn)", PATCH: "var(--warn)", DELETE: "var(--bad)",
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
        <div className="row wrap gap-3">
          <div className="stack" style={{ gap: 2 }}>
            <h2>API lifecycle</h2>
            <span className="muted" style={{ fontSize: 12.5 }}>{endpoints.length} endpoints tracked</span>
          </div>
          <div className="row wrap gap-2" data-testid="gaps">
            <span className="badge" style={{ background: "var(--warnSoft)", color: "var(--warn)", borderRadius: "var(--r-pill)" }}>{gaps.untested} untested</span>
            <span className="badge" style={{ background: "var(--badSoft)", color: "var(--bad)", borderRadius: "var(--r-pill)" }}>{gaps.unimplemented} unimplemented</span>
            <span className="badge" style={{ borderRadius: "var(--r-pill)" }}>{gaps.unspecced} unspecced</span>
          </div>
        </div>
        <button className="btn-ghost" onClick={onScan} disabled={scanning}>{scanning ? "Scan queued…" : "Rescan"}</button>
      </div>
      {endpoints.length === 0 ? (
        <div className="empty"><span className="empty__title">No endpoints discovered</span><span>Run a scan to map the repo's lifecycle.</span></div>
      ) : (
      <div className="card table-scroll">
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
                <td><code style={{ color: VERB_COLOR[e.method] ?? "var(--t2)", fontWeight: 600 }}>{e.method}</code></td>
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
