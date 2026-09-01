import { useState } from "react";

export interface CheckpointRow {
  id: string;
  work_item_id: string;
  work_item_title: string;
  question: string;
  options: string[] | null;
  context: string | null;
  created_at: string;
}

// BRF-5/§3.4: the human side of work.checkpoint. Answering here completes the
// agent's task on its next poll. All strings are agent-authored → text nodes only.
export function DecisionCards({ checkpoints, onAnswer }: {
  checkpoints: CheckpointRow[];
  onAnswer(id: string, answer: string): void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());

  if (checkpoints.length === 0) return null;

  const answer = (id: string, value: string) => {
    setBusy((b) => new Set(b).add(id));
    onAnswer(id, value);
  };

  return (
    <section aria-label="decisions needed" className="stack gap-3" style={{ marginBottom: "var(--sp-5)" }}>
      {checkpoints.map((cp) => (
        <div key={cp.id} className="card card--pad stack gap-2" style={{ borderLeft: "3px solid var(--warning)" }}>
          <div className="row gap-2">
            <span className="badge" style={{ background: "color-mix(in srgb, var(--warning) 18%, transparent)", color: "var(--warning)" }}>Decision needed</span>
            <span className="muted" style={{ fontSize: "0.85rem" }}>{cp.work_item_title}</span>
          </div>
          <p style={{ margin: 0, fontWeight: 600 }}>{cp.question}</p>
          {cp.context !== null && <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>{cp.context}</p>}
          {cp.options !== null && cp.options.length > 0 ? (
            <div className="row wrap gap-2">
              {cp.options.map((opt) => (
                <button key={opt} className="btn-primary" disabled={busy.has(cp.id)} onClick={() => answer(cp.id, opt)}>
                  {opt}
                </button>
              ))}
            </div>
          ) : (
            <form className="row gap-2" onSubmit={(e) => {
              e.preventDefault();
              const v = (drafts[cp.id] ?? "").trim();
              if (v !== "") answer(cp.id, v);
            }}>
              <label className="row gap-2" style={{ flex: 1 }}>
                Answer
                <input style={{ flex: 1 }} value={drafts[cp.id] ?? ""} disabled={busy.has(cp.id)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [cp.id]: e.target.value }))} />
              </label>
              <button type="submit" className="btn-primary" disabled={busy.has(cp.id)}>Send</button>
            </form>
          )}
        </div>
      ))}
    </section>
  );
}
