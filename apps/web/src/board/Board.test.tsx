import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { Board, type BoardItem } from "./Board.js";

afterEach(cleanup);

const item = (id: string, status: string): BoardItem => ({ id, title: id, kind: "task", status, priority: 100 });

const dragTo = (id: string, toCol: string) => {
  const card = document.querySelector(`[data-item-id="${id}"]`)!;
  fireEvent.dragStart(card);
  const col = document.querySelector(`[data-col="${toCol}"]`)!;
  fireEvent.dragOver(col);
  fireEvent.drop(col);
};

describe("Board", () => {
  it("dropping a card into backlog persists via onMove(id, 'queued')", () => {
    const calls: Array<[string, string]> = [];
    render(<Board items={[item("i1", "blocked")]} onMove={(id, to) => calls.push([id, to])} />);
    dragTo("i1", "backlog");
    expect(calls).toEqual([["i1", "queued"]]);
  });

  it("dropping into onhold/done/reviewed/deployed maps to blocked/done/in_review/done", () => {
    const calls: Array<[string, string]> = [];
    render(<Board items={[item("a", "queued"), item("b", "queued"), item("c", "queued"), item("d", "queued")]}
      onMove={(id, to) => calls.push([id, to])} />);
    dragTo("a", "onhold");
    dragTo("b", "done");
    dragTo("c", "reviewed");
    dragTo("d", "deployed");
    expect(calls).toEqual([["a", "blocked"], ["b", "done"], ["c", "in_review"], ["d", "done"]]);
  });

  it("dropping into 'in progress' moves the card locally but does not call onMove (queue-owned)", () => {
    const calls: Array<[string, string]> = [];
    render(<Board items={[item("i1", "queued")]} onMove={(id, to) => calls.push([id, to])} />);
    dragTo("i1", "inprogress");
    expect(calls).toEqual([]);
    expect(document.querySelector('[data-col="inprogress"] [data-item-id="i1"]')).not.toBeNull();
  });

  it("works without an onMove callback", () => {
    render(<Board items={[item("i1", "queued")]} />);
    expect(() => dragTo("i1", "backlog")).not.toThrow();
  });
});
