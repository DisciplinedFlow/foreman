import { useState } from "react";
import type { AgentRow } from "./AgentTable.js";

export type DirectiveKind = "pause" | "resume" | "cancel_item" | "message" | "request_checkpoint";

// AVW-5: these create directives the agent drains on its next heartbeat —
// offers, not process control.
export function AgentActions({ agent, onAction }: {
  agent: Pick<AgentRow, "id" | "display_name" | "status" | "work_item_id">;
  onAction(kind: DirectiveKind, extra: { message?: string; work_item_id?: string }): void;
}) {
  const [mode, setMode] = useState<"idle" | "message" | "checkpoint">("idle");
  const [text, setText] = useState("");

  const send = (kind: DirectiveKind) => {
    const v = text.trim();
    if (v === "") return;
    onAction(kind, { message: v });
    setText("");
    setMode("idle");
  };

  if (mode !== "idle") {
    const kind: DirectiveKind = mode === "message" ? "message" : "request_checkpoint";
    return (
      <form onSubmit={(e) => { e.preventDefault(); send(kind); }} style={{ display: "inline" }}>
        <label>
          {mode === "message" ? "Message" : "Checkpoint question"}{" "}
          <input value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </label>{" "}
        <button type="submit">Send</button>{" "}
        <button type="button" onClick={() => { setMode("idle"); setText(""); }}>✕</button>
      </form>
    );
  }

  return (
    <span style={{ whiteSpace: "nowrap" }}>
      {agent.status === "working" ? (
        <button onClick={() => onAction("pause", {})}>Pause</button>
      ) : (
        <button onClick={() => onAction("resume", {})}>Resume</button>
      )}{" "}
      <button onClick={() => setMode("message")}>Message…</button>{" "}
      <button onClick={() => setMode("checkpoint")}>Checkpoint…</button>
      {agent.work_item_id !== null && (
        <>
          {" "}
          <button onClick={() => onAction("cancel_item", { work_item_id: agent.work_item_id! })}>
            Cancel item
          </button>
        </>
      )}
    </span>
  );
}
