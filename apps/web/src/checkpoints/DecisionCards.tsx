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
    <section aria-label="decisions needed">
      {checkpoints.map((cp) => (
        <div key={cp.id} style={{
          border: "1px solid #d29922", borderLeft: "4px solid #d29922", borderRadius: 6,
          padding: 12, marginBottom: 8, background: "rgba(210,153,34,0.06)",
        }}>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Decision needed · {cp.work_item_title}
          </div>
          <p style={{ margin: "6px 0", fontWeight: 600 }}>{cp.question}</p>
          {cp.context !== null && <p style={{ margin: "4px 0", fontSize: 13 }}>{cp.context}</p>}
          {cp.options !== null && cp.options.length > 0 ? (
            <div>
              {cp.options.map((opt) => (
                <button key={opt} disabled={busy.has(cp.id)} onClick={() => answer(cp.id, opt)}
                  style={{ marginRight: 8 }}>
                  {opt}
                </button>
              ))}
            </div>
          ) : (
            <form onSubmit={(e) => {
              e.preventDefault();
              const v = (drafts[cp.id] ?? "").trim();
              if (v !== "") answer(cp.id, v);
            }}>
              <label>
                Answer{" "}
                <input value={drafts[cp.id] ?? ""} disabled={busy.has(cp.id)}
                  onChange={(e) => setDrafts((d) => ({ ...d, [cp.id]: e.target.value }))} />
              </label>{" "}
              <button type="submit" disabled={busy.has(cp.id)}>Send</button>
            </form>
          )}
        </div>
      ))}
    </section>
  );
}
