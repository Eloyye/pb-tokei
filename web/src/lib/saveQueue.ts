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
  /**
   * Stops retrying and reporting status, but still sends the latest waiting value once, so an
   * edit made just before the editor closed isn't lost. Values pushed afterwards are ignored.
   */
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

/** How long to wait before retry `attempt` (1, 2, ...), in milliseconds. */
export function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? 10000;
}

function defaultWait(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
}

export function createSaveQueue<T>(
  save: (value: T) => Promise<unknown>,
  { retryable, onStatus, wait = defaultWait }: SaveQueueOptions,
): SaveQueue<T> {
  let next: { value: T } | null = null;
  let running = false;
  let closed = false;
  let current: SaveStatus = { state: "saved" };
  // Cuts a retry wait short when the queue closes.
  let wakeUp: (() => void) | null = null;

  const setStatus = (status: SaveStatus) => {
    current = status;
    if (!closed) onStatus(status);
  };

  const run = async () => {
    running = true;
    let attempt = 0;
    while (next) {
      const { value } = next;
      next = null;
      if (closed) {
        // The flush: one last try, with nobody left to tell if it fails.
        await save(value).catch(() => {});
        continue;
      }
      setStatus({ state: "saving" });
      try {
        await save(value);
        attempt = 0;
      } catch (error) {
        if (closed) {
          next ??= { value };
          continue;
        }
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
        await Promise.race([
          wait(attempt),
          new Promise<void>((resolve) => {
            wakeUp = resolve;
          }),
        ]);
        wakeUp = null;
      }
    }
    running = false;
    setStatus({ state: "saved" });
  };

  return {
    push(value) {
      if (closed) return;
      next = { value };
      if (!running) void run();
    },
    status: () => current,
    close() {
      closed = true;
      wakeUp?.();
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
