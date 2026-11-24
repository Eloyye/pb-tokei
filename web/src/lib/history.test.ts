import { describe, expect, it } from "vitest";
import { commit, HISTORY_LIMIT, redo, startHistory, undo } from "./history";

describe("history", () => {
  it("undoes and redoes in order", () => {
    let h = startHistory(1);
    h = commit(h, 2);
    h = commit(h, 3);

    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = redo(h);
    expect(h.present).toBe(2);
  });

  it("drops what could be redone when a new state is recorded", () => {
    const h = commit(undo(commit(startHistory("a"), "b")), "c");

    expect(h.present).toBe("c");
    expect(redo(h)).toBe(h);
  });

  it("does nothing past either end", () => {
    const h = startHistory(1);

    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it("ignores a commit of the same state", () => {
    const h = startHistory({ x: 1 });

    expect(commit(h, h.present)).toBe(h);
  });

  it("keeps at most the limit of steps back", () => {
    let h = startHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 10; i++) h = commit(h, i);

    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(10);
  });
});
