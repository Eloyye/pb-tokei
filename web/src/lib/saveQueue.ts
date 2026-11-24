/**
 * Autosave for one list that is saved whole (docs/annotation-ui.md, "Saving and undo").
 *
 * At most one save is in flight. Values pushed meanwhile are coalesced and only the latest is
 * sent next, so an older save can never land after a newer one and overwrite it. A failed save is
 * retried with the latest value, backing off, unless the server refused it outright.
 */

export type SaveStatus =
  | { state: "saved" }
  | { state: "saving" }
  | { state: "retrying"; error: string }
  | { state: "refused"; error: string };

export interface SaveQueue<T> {
  push(value: T): void;
  status(): SaveStatus;
  /** Stops retrying; a save in flight still finishes. */
  close(): void;
}

export interface SaveQueueOptions {
  /** Whether a failed save is worth retrying (a network error is; a 422 isn't). */
  retryable(error: unknown): boolean;
  onStatus(status: SaveStatus): void;
  /** Waits before retry `attempt` (1, 2, ...). */
  wait?(attempt: number): Promise<void>;
}

const BACKOFF_MS = [1000, 2000, 5000, 10000];

function defaultWait(attempt: number): Promise<void> {
  const ms = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 10000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSaveQueue<T>(
  save: (value: T) => Promise<unknown>,
  { retryable, onStatus, wait = defaultWait }: SaveQueueOptions,
): SaveQueue<T> {
  let next: { value: T } | null = null;
  let running = false;
  let closed = false;
  let current: SaveStatus = { state: "saved" };

  const setStatus = (status: SaveStatus) => {
    current = status;
    onStatus(status);
  };

  const run = async () => {
    running = true;
    let attempt = 0;
    while (next) {
      if (closed) break;
      const { value } = next;
      next = null;
      setStatus({ state: "saving" });
      try {
        await save(value);
        attempt = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!retryable(error)) {
          // Keep any newer value: it may well be valid, and it supersedes this one.
          if (!next) {
            setStatus({ state: "refused", error: message });
            running = false;
            return;
          }
          continue;
        }
        next ??= { value };
        attempt += 1;
        setStatus({ state: "retrying", error: message });
        await wait(attempt);
      }
    }
    running = false;
    if (!closed) setStatus({ state: "saved" });
  };

  return {
    push(value) {
      next = { value };
      if (!running && !closed) void run();
    },
    status: () => current,
    close() {
      closed = true;
    },
  };
}

/** The status of several queues as one: the worst of them. */
export function combineStatus(statuses: SaveStatus[]): SaveStatus {
  const order: SaveStatus["state"][] = ["refused", "retrying", "saving", "saved"];
  for (const state of order) {
    const found = statuses.find((s) => s.state === state);
    if (found) return found;
  }
  return { state: "saved" };
}
