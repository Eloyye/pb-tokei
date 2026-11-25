/**
 * Every editor's save status in this tab, so switching Rally Log can wait for queued saves to
 * land before the app moves to another file.
 */
import { combineStatus, type SaveStatus } from "./saveQueue";

const statuses = new Map<object, SaveStatus>();
const listeners = new Set<() => void>();

/** Records an editor's save status; null when the editor closes. */
export function reportSaveStatus(owner: object, status: SaveStatus | null): void {
  if (status === null) statuses.delete(owner);
  else statuses.set(owner, status);
  for (const listener of listeners) listener();
}

/** The worst save status of every open editor in this tab. */
export function tabSaveStatus(): SaveStatus {
  return combineStatus([...statuses.values()]);
}

export const SAVE_WAIT_MS = 15000;

/**
 * Resolves once every queued save in this tab has landed. Rejects at once if a save is failing
 * (retrying or refused), since those changes would be lost or sent to the wrong Rally Log, and
 * after `timeoutMs` if saves are still going.
 */
export function waitUntilSaved(timeoutMs = SAVE_WAIT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      listeners.delete(check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      const status = tabSaveStatus();
      if (status.state === "saved") finish();
      else if (status.state !== "saving") {
        finish(new Error(`Changes aren't saved (${status.error}). Undo them or reload first.`));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("Changes are still saving; try again in a moment.")),
      timeoutMs,
    );
    listeners.add(check);
    check();
  });
}
