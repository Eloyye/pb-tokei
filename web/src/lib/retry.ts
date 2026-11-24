import { backoffMs } from "./saveQueue";

export interface RetryOptions {
  /** Tries in all, the first included. */
  attempts?: number;
  retryable(error: unknown): boolean;
  /** Waits before retry `attempt` (1, 2, ...); defaults to the save queue's backoff. */
  wait?(attempt: number): Promise<void>;
}

/** Runs `load`, trying again after errors `retryable` accepts, up to `attempts` tries. */
export async function withRetries<T>(
  load: () => Promise<T>,
  {
    attempts = 5,
    retryable,
    wait = (attempt) => new Promise((resolve) => setTimeout(resolve, backoffMs(attempt))),
  }: RetryOptions,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      await wait(attempt);
    }
  }
}
