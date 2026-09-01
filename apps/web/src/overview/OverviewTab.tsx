import { useState } from "react";
import { lineDiff } from "../diff.js";

export interface OverviewRevision { version: number; content: string; caused_by: string | null; created_at: string }

export interface OverviewSection {
  section_id: string;
  version: number;
  content: string;
  sources: Array<{ type: string; ref: string }>;
  pinned: boolean;
  human_authored: boolean;
  updated_at: string;
}

const TITLES: Record<string, string> = {
  purpose: "Purpose", architecture: "Architecture", data_model: "Data model",
  interfaces: "Interfaces", shipped: "Recently shipped", in_flight: "In flight",
  conventions: "Conventions", risks: "Risks",
};

// OVW-5/6: the living overview — generated sections with provenance chips,
// pinnable and human-editable. All content renders as text nodes (X-6).
export function OverviewTab({ sections, onOverride, onRegenerate, busy = false, revisions = {}, onLoadHistory }: {
  sections: OverviewSection[];
  onOverride(sectionId: string, body: { content?: string; pinned?: boolean }): void;
  onRegenerate(): void;
  busy?: boolean;
  revisions?: Record<string, OverviewRevision[]>;
  onLoadHistory?(sectionId: string): void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());

  const toggleHistory = (sectionId: string) => {
    setHistoryOpen((h) => {
      const next = new Set(h);
      if (next.has(sectionId)) next.delete(sectionId);
      else { next.add(sectionId); onLoadHistory?.(sectionId); }
      return next;
    });
  };

  return (
    <div className="stack gap-4" style={{ maxWidth: 820 }}>
      <div className="section-head">
        <h2>Living overview</h2>
        <button className="btn-primary" onClick={onRegenerate} disabled={busy}>{busy ? "Regenerating…" : "Regenerate"}</button>
      </div>
      {sections.length === 0 && (
        <div className="empty"><span className="empty__title">No overview yet</span><span>Regenerate to build one from the event log.</span></div>
      )}
      {sections.map((s) => (
        <section key={s.section_id} className="card card--pad stack gap-3">
          <div className="row wrap gap-2" style={{ alignItems: "baseline" }}>
            <h3 style={{ marginRight: 4 }}>{TITLES[s.section_id] ?? s.section_id}</h3>
            <span className="badge">v{s.version}</span>
            {s.pinned && <span className="badge" style={{ background: "color-mix(in srgb, var(--warning) 18%, transparent)", color: "var(--warning)" }}>Pinned</span>}
            {s.human_authored && <span className="badge">Human-authored</span>}
          </div>
          {editing === s.section_id ? (
            <form className="stack gap-2" onSubmit={(e) => {
              e.preventDefault();
              onOverride(s.section_id, { content: draft });
              setEditing(null);
            }}>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                rows={6} style={{ width: "100%" }} />
              <div className="row gap-2">
                <button type="submit" className="btn-primary">Save</button>
                <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </form>
          ) : (
            <>
              <div className="stack" style={{ gap: 2 }}>
                {s.content.split("\n").map((line, i) => <p key={i} style={{ margin: 0 }}>{line}</p>)}
              </div>
              {s.sources.length > 0 && (
                <div className="row wrap gap-2">
                  {s.sources.map((src, i) => (
                    <span key={i} className="chip">{src.type} {src.ref}</span>
                  ))}
                </div>
              )}
              <div className="row gap-2">
                <button onClick={() => { setEditing(s.section_id); setDraft(s.content); }}>Edit</button>
                <button onClick={() => onOverride(s.section_id, { pinned: !s.pinned })}>
                  {s.pinned ? "Unpin" : "Pin"}
                </button>
                <button onClick={() => toggleHistory(s.section_id)}>History</button>
              </div>
              {historyOpen.has(s.section_id) && (() => {
                const revs = revisions[s.section_id] ?? [];
                if (revs.length < 2) return <p className="muted" style={{ fontSize: "0.85rem" }}>No earlier version to diff.</p>;
                // OVW-2: readable diff of the latest revision vs its predecessor
                return (
                  <pre className="card" style={{ fontSize: "0.8rem", background: "var(--surface-2)", padding: "var(--sp-3)", overflowX: "auto", margin: 0 }}>
                    <div className="muted">v{revs[1]!.version} → v{revs[0]!.version}</div>
                    {lineDiff(revs[1]!.content, revs[0]!.content).map((l, i) =>
                      l.op === "add" ? <ins key={i} style={{ display: "block", background: "color-mix(in srgb, var(--success) 20%, transparent)", textDecoration: "none" }}>+ {l.text}</ins>
                      : l.op === "del" ? <del key={i} style={{ display: "block", background: "var(--danger-tint)" }}>- {l.text}</del>
                      : <span key={i} style={{ display: "block" }}>  {l.text}</span>)}
                  </pre>
                );
              })()}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
