export interface Metrics {
  supervised_throughput: { this_week: number; last_week: number; all_completions_this_week: number; method: string };
  stall_detection: { median_ms: number; p95_ms: number; samples: number } | null;
  active_agents_24h: number;
  open_decisions: number;
  briefs_7d: { generated: number; delivered: number };
  cost_7d: { usd: string; previous_usd: string };
  lease_expiries_7d: number;
}

const fmtMs = (ms: number): string =>
  ms < 60_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60_000).toFixed(1)}m`;

function Tile({ label, value, sub, subClass, pill }: { label: string; value: string; sub?: string; subClass?: string; pill?: { text: string; dir: "up" | "down" | "flat" } }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="row gap-2" style={{ marginTop: 6 }}>
        <div className="stat__value" style={{ marginTop: 0 }}>{value}</div>
        {pill !== undefined && (
          <span className={`pill ${pill.dir === "up" ? "pill--up" : pill.dir === "down" ? "pill--down" : ""}`}>
            {pill.dir === "up" ? "▲" : pill.dir === "down" ? "▼" : ""} {pill.text}
          </span>
        )}
      </div>
      {sub !== undefined && <div className={`stat__sub ${subClass ?? ""}`}>{sub}</div>}
    </div>
  );
}

// PRD §1.7 — the numbers a design partner is judged on, from day one.
export function MetricsTab({ metrics: m }: { metrics: Metrics }) {
  const delta = m.supervised_throughput.this_week - m.supervised_throughput.last_week;
  return (
    <div className="stack gap-4">
      <div className="stat-grid">
        <Tile label="Supervised throughput (wk)" value={String(m.supervised_throughput.this_week)}
          pill={{ text: `${delta >= 0 ? "+" : ""}${delta} wk`, dir: delta > 0 ? "up" : delta < 0 ? "down" : "flat" }}
          sub={`${m.supervised_throughput.all_completions_this_week} total completions`} />
        {m.stall_detection !== null ? (
          <Tile label="Stall detection (median)" value={fmtMs(m.stall_detection.median_ms)}
            sub={`p95 ${fmtMs(m.stall_detection.p95_ms)} · ${m.stall_detection.samples} samples (target < 5m)`} />
        ) : (
          <Tile label="Stall detection" value="—" sub="no stalls detected this week" />
        )}
        <Tile label="Active agents (24h)" value={String(m.active_agents_24h)} />
        <Tile label="Open decisions" value={String(m.open_decisions)} />
        <Tile label="Briefs delivered (7d)" value={`${m.briefs_7d.delivered} / ${m.briefs_7d.generated}`} />
        <Tile label="Cost (7d)" value={`$${m.cost_7d.usd}`} sub={`prev $${m.cost_7d.previous_usd}`} />
        <Tile label="Lease expiries (7d)" value={String(m.lease_expiries_7d)} />
      </div>
      <p className="stat__sub" style={{ margin: 0 }}>
        Throughput method: {m.supervised_throughput.method} (merged-and-reviewed refinement pending PR-review ingestion).
      </p>
    </div>
  );
}
