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
    <div style={{ maxWidth: 780 }}>
      <button onClick={onRegenerate} disabled={busy}>{busy ? "Regenerating…" : "Regenerate"}</button>
      {sections.length === 0 && <p>No overview yet — regenerate to build one from the event log.</p>}
      {sections.map((s) => (
        <section key={s.section_id} style={{ margin: "16px 0", borderTop: "1px solid #d0d7de", paddingTop: 8 }}>
          <h2 style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            {TITLES[s.section_id] ?? s.section_id}
            <small style={{ fontWeight: 400 }}>v{s.version}</small>
            {s.pinned && <small style={{ color: "#d29922" }}>📌 pinned</small>}
            {s.human_authored && <small style={{ color: "#57606a" }}>human-authored</small>}
          </h2>
          {editing === s.section_id ? (
            <form onSubmit={(e) => {
              e.preventDefault();
              onOverride(s.section_id, { content: draft });
              setEditing(null);
            }}>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                rows={6} style={{ width: "100%" }} />
              <button type="submit">Save</button>{" "}
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
            </form>
          ) : (
            <>
              {s.content.split("\n").map((line, i) => <p key={i} style={{ margin: "4px 0" }}>{line}</p>)}
              <div style={{ fontSize: 12, margin: "6px 0" }}>
                {s.sources.map((src, i) => (
                  <code key={i} style={{ marginRight: 6, background: "rgba(175,184,193,0.2)", borderRadius: 4, padding: "1px 4px" }}>
                    {src.type} {src.ref}
                  </code>
                ))}
              </div>
              <button onClick={() => { setEditing(s.section_id); setDraft(s.content); }}>Edit</button>{" "}
              <button onClick={() => onOverride(s.section_id, { pinned: !s.pinned })}>
                {s.pinned ? "Unpin" : "Pin"}
              </button>{" "}
              <button onClick={() => toggleHistory(s.section_id)}>History</button>
              {historyOpen.has(s.section_id) && (() => {
                const revs = revisions[s.section_id] ?? [];
                if (revs.length < 2) return <p style={{ fontSize: 12 }}>No earlier version to diff.</p>;
                // OVW-2: readable diff of the latest revision vs its predecessor
                return (
                  <pre style={{ fontSize: 12, background: "rgba(175,184,193,0.1)", padding: 8, overflowX: "auto" }}>
                    <div style={{ opacity: 0.7 }}>v{revs[1]!.version} → v{revs[0]!.version}</div>
                    {lineDiff(revs[1]!.content, revs[0]!.content).map((l, i) =>
                      l.op === "add" ? <ins key={i} style={{ display: "block", background: "rgba(45,164,78,0.2)", textDecoration: "none" }}>+ {l.text}</ins>
                      : l.op === "del" ? <del key={i} style={{ display: "block", background: "rgba(209,36,47,0.15)" }}>- {l.text}</del>
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
