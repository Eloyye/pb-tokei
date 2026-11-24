/** An undo history for the session, kept in memory (docs/annotation-ui.md, "Saving and undo"). */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

/** How many steps back undo can go. */
export const HISTORY_LIMIT = 500;

export function startHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Records a new state; whatever could be redone is dropped. */
export function commit<T>(history: History<T>, next: T): History<T> {
  if (next === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  };
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}
