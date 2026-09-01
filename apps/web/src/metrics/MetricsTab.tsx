import { useEffect, useState } from "react";

export interface Metrics {
  supervised_throughput: { this_week: number; last_week: number; all_completions_this_week: number; method: string };
  stall_detection: { median_ms: number; p95_ms: number; samples: number } | null;
  active_agents_24h: number;
  open_decisions: number;
  briefs_7d: { generated: number; delivered: number };
  cost_7d: { usd: string; previous_usd: string };
  lease_expiries_7d: number;
}

export interface Activity {
  weeks: number;
  cells: number[];
  source: "merged" | "completed";
}

const EMPTY_ACTIVITY: Activity = { weeks: 12, cells: new Array(84).fill(0), source: "completed" };

// opacity = count>0 ? clamp(0.12 + 0.88*count/max, ..1) : 0.06 (faint-but-visible
// empty cells, full range for the rest, scaled to the busiest day in the window).
const cellOpacity = (count: number, max: number): number => {
  if (count <= 0) return 0.06;
  if (max <= 0) return 0.12;
  return Math.min(1, 0.12 + 0.88 * (count / max));
};

const fmtMs = (ms: number): string =>
  ms < 60_000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 60_000).toFixed(1)}m`;

// Count up to `target` over 950ms on mount (re-runs each time the tab opens, as
// the tab content remounts). Guarded on matchMedia so it's a no-op under jsdom
// (tests read the final value synchronously) and under reduced-motion.
function useCountUp(target: number): number {
  const [n, setN] = useState(target);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const start = performance.now();
    setN(0);
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 950);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return n;
}

function Tile({ label, value, sub, pill }: {
  label: string; value: string; sub?: string;
  pill?: { text: string; dir: "up" | "down" | "flat" };
}) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="row gap-2" style={{ marginTop: 8 }}>
        <div className="stat__value" style={{ marginTop: 0 }}>{value}</div>
        {pill !== undefined && (
          <span className={`pill ${pill.dir === "up" ? "pill--up" : pill.dir === "down" ? "pill--down" : ""}`}>
            {pill.dir === "up" ? "▲" : pill.dir === "down" ? "▼" : ""} {pill.text}
          </span>
        )}
      </div>
      {sub !== undefined && <div className="stat__sub">{sub}</div>}
    </div>
  );
}

// PRD §1.7 — the numbers a design partner is judged on, from day one.
export function MetricsTab({ metrics: m, activity = EMPTY_ACTIVITY }: { metrics: Metrics; activity?: Activity }) {
  const delta = m.supervised_throughput.this_week - m.supervised_throughput.last_week;
  const maxCell = Math.max(0, ...activity.cells);
  const heroNum = useCountUp(m.supervised_throughput.this_week);
  const costDelta = Number(m.cost_7d.usd) - Number(m.cost_7d.previous_usd);
  const prev = Number(m.cost_7d.previous_usd);
  const costPct = prev > 0 ? Math.round((costDelta / prev) * 100) : null;

  // Sparkline over the two real points we have (last week → this week).
  const hi = Math.max(1, m.supervised_throughput.this_week, m.supervised_throughput.last_week);
  const y = (v: number) => 44 - (v / hi) * 40;

  return (
    <div className="stack gap-4">
      <div className="section-head">
        <div className="stack" style={{ gap: 2 }}>
          <div className="row gap-2">
            <h2>Metrics</h2>
            <span className="pill" style={{ background: "var(--okSoft)", color: "var(--ok)", letterSpacing: "0.08em", fontWeight: 700 }}>
              <span className="status-dot" style={{ background: "var(--ok)", margin: 0, animation: "pulse 1.4s ease infinite" }} /> LIVE
            </span>
          </div>
          <span className="muted" style={{ fontSize: 12.5 }}>Deterministic, windowed · last 7 days (UTC weeks)</span>
        </div>
        <span className="badge" style={{ borderRadius: "var(--r-pill)", padding: "5px 13px" }}>7d</span>
      </div>

      <div className="metrics-grid">
        {/* Hero — supervised throughput */}
        <div className="hero-sheen metrics-hero" style={{ background: "var(--grad)", borderRadius: "var(--r-lg)", padding: "22px 24px", color: "#fff", position: "relative", overflow: "hidden", boxShadow: "0 12px 32px rgba(124,92,255,0.35)" }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", opacity: 0.85 }}>SUPERVISED THROUGHPUT / WK</div>
          <div className="row" style={{ alignItems: "baseline", gap: 12, marginTop: 8 }}>
            <span style={{ fontSize: 52, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{heroNum}</span>
            <span style={{ background: "rgba(255,255,255,0.22)", borderRadius: "var(--r-pill)", padding: "4px 11px", fontSize: 12.5, fontWeight: 700 }}>
              {delta >= 0 ? "▲" : "▼"} {delta >= 0 ? "+" : ""}{delta} wk
            </span>
          </div>
          <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 10 }}>
            {m.supervised_throughput.all_completions_this_week} total completions
          </div>
          <svg viewBox="0 0 200 48" preserveAspectRatio="none" style={{ position: "absolute", right: 20, bottom: 18, width: 200, height: 48, opacity: 0.9 }}>
            <polyline points={`0,${y(m.supervised_throughput.last_week)} 200,${y(m.supervised_throughput.this_week)}`}
              fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        </div>

        {m.stall_detection !== null ? (
          <Tile label="Stall detection" value={fmtMs(m.stall_detection.median_ms)}
            sub={`p95 ${fmtMs(m.stall_detection.p95_ms)} · ${m.stall_detection.samples} samples · target < 5m`} />
        ) : (
          <Tile label="Stall detection" value="—" sub="no stalls detected this week" />
        )}
        <Tile label="Active agents (24h)" value={String(m.active_agents_24h)} />
        <Tile label="Open decisions" value={String(m.open_decisions)} />
        <Tile label="Briefs delivered (7d)" value={`${m.briefs_7d.delivered} / ${m.briefs_7d.generated}`} sub="delivered / generated" />
        <Tile label="Cost (7d)" value={`$${m.cost_7d.usd}`}
          pill={costPct === null ? undefined : { text: `${costPct}%`, dir: costPct > 0 ? "down" : costPct < 0 ? "up" : "flat" }}
          sub={`prev $${m.cost_7d.previous_usd}`} />
        <Tile label="Lease expiries (7d)" value={String(m.lease_expiries_7d)} />

        {/* Activity heatmap — 12 weeks × 7 days, oldest→newest. Merged PRs for
            GitHub-connected projects, completions otherwise. Fills in as event
            history accrues; renders faint until then rather than inventing counts. */}
        <div className="stat">
          <div className="stat__label">{activity.source === "merged" ? "Merge activity (12w)" : "Completion activity (12w)"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: 3, marginTop: 14 }}>
            {activity.cells.map((count, i) => (
              <div key={i} title={`${count}`} style={{ aspectRatio: "1", borderRadius: 3, background: "var(--acc)",
                opacity: cellOpacity(count, maxCell), animation: "fadeIn 0.5s ease both", animationDelay: `${i * 10}ms` }} />
            ))}
          </div>
        </div>
      </div>

      <p className="stat__sub" style={{ margin: 0 }}>
        Throughput method: {m.supervised_throughput.method} (merged-and-reviewed for GitHub-connected projects). Windows are UTC weeks.
      </p>
    </div>
  );
}
