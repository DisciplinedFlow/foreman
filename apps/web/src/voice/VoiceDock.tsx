import { useEffect, useRef, useState } from "react";

// §12: Foreman Voice — a command palette with voice input, fixed bottom-center
// on every workspace screen. Uses the browser SpeechRecognition API when
// available (Chrome/Edge); otherwise you type the command. Submitting creates a
// work item through the same API the "+ New item" form uses. "Undo" clears the
// receipt locally — a real reversal endpoint is a backend TODO.

// Minimal shape of the Web Speech API we touch (not in TS lib DOM by default).
interface SpeechRec { start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; continuous: boolean; interimResults: boolean; }
const SpeechRecognitionCtor: (new () => SpeechRec) | undefined =
  typeof window !== "undefined"
    ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)
    : undefined;

export function VoiceDock({ onCreate }: { onCreate(title: string): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);

  // ⌥ Space toggles the dock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.code === "Space") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const startListening = () => {
    if (SpeechRecognitionCtor === undefined) return;
    const rec = new SpeechRecognitionCtor();
    rec.continuous = false; rec.interimResults = true;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results).map((r: any) => r[0].transcript).join("");
      setText(t);
    };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  };
  const stopListening = () => { recRef.current?.stop(); setListening(false); };

  const submit = async () => {
    const title = text.trim();
    if (title === "" || busy) return;
    setBusy(true);
    try {
      await onCreate(title);
      setReceipt(title);
      setText("");
    } finally { setBusy(false); }
  };

  return (
    <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: "var(--z-toast)" as unknown as number }}>
      {open ? (
        <div className="glass" style={{ width: 480, border: "1px solid var(--line2)", borderRadius: "var(--r-lg)", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="row gap-2">
            <span className="status-dot" style={{ margin: 0, background: "var(--acc)", animation: "pulse 1.4s ease infinite" }} />
            <span style={{ fontSize: 13, fontWeight: 650 }}>Foreman Voice</span>
            <span className="badge" style={{ background: "var(--accSoft)", color: "var(--acc)", borderRadius: "var(--r-pill)" }}>READ + WRITE</span>
            <button onClick={() => setOpen(false)} style={{ marginLeft: "auto", background: "transparent", border: "none", color: "var(--t3)", fontSize: 14, padding: "2px 6px" }} aria-label="Close">✕</button>
          </div>
          <div className="row gap-2" style={{ background: "var(--ctl)", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 14px" }}>
            <div className="row" style={{ gap: 3, height: 18 }} aria-hidden>
              {[0, 0.15, 0.3, 0.45, 0.6].map((d) => (
                <span key={d} style={{ width: 3, height: 18, borderRadius: 2, background: "var(--acc)",
                  animation: listening ? "wave 0.9s ease infinite" : "none", animationDelay: `${d}s`, opacity: listening ? 1 : 0.4 }} />
              ))}
            </div>
            <input value={text} onChange={(e) => setText(e.target.value)} autoFocus
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              placeholder="Add a task — say or type what you need…"
              style={{ flex: 1, background: "transparent", border: "none", padding: 0, color: "var(--t1)", fontStyle: text ? "normal" : "italic" }} />
            {SpeechRecognitionCtor !== undefined && (
              <button onClick={listening ? stopListening : startListening} className="btn-ghost" style={{ padding: "5px 12px", fontSize: 12 }}>
                {listening ? "Stop" : "Speak"}
              </button>
            )}
            <button className="btn-primary" style={{ padding: "6px 14px", fontSize: 12 }} disabled={busy || text.trim() === ""} onClick={() => void submit()}>Create</button>
          </div>
          {receipt !== null && (
            <div className="row gap-2" style={{ background: "var(--okSoft)", border: "1px solid var(--ok)", borderRadius: 12, padding: "10px 14px" }}>
              <span style={{ color: "var(--ok)", fontWeight: 700 }}>✓</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Created: {receipt}</div>
                <div style={{ fontSize: 11, color: "var(--t3)" }}>added to the backlog · linked through the sync worker</div>
              </div>
              <button onClick={() => setReceipt(null)} style={{ flex: "none", borderRadius: "var(--r-pill)", padding: "5px 12px", fontSize: 11.5 }}>Undo</button>
            </div>
          )}
        </div>
      ) : (
        <button onClick={() => setOpen(true)}
          className="glass"
          style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--line2)", borderRadius: "var(--r-pill)", padding: "9px 16px 9px 10px", color: "var(--t2)", fontSize: 12.5, fontWeight: 500 }}>
          <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--grad)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ width: 7, height: 10, border: "1.5px solid #fff", borderRadius: 4, display: "inline-block" }} />
          </span>
          Ask Foreman
          <span className="kbd" style={{ color: "var(--t3)" }}>⌥ Space</span>
        </button>
      )}
    </div>
  );
}
