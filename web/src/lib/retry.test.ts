import { describe, expect, it, vi } from "vitest";
import { withRetries } from "./retry";

const noWait = () => Promise.resolve();

describe("withRetries", () => {
  it("tries again after a retryable error", async () => {
    const load = vi.fn<() => Promise<string>>();
    load.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce("loaded");

    await expect(withRetries(load, { retryable: () => true, wait: noWait })).resolves.toBe(
      "loaded",
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives up at once on an error that won't go away", async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("404"));

    await expect(withRetries(load, { retryable: () => false, wait: noWait })).rejects.toThrow(
      "404",
    );
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("gives up after the last attempt", async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("503"));

    await expect(
      withRetries(load, { attempts: 5, retryable: () => true, wait: noWait }),
    ).rejects.toThrow("503");
    expect(load).toHaveBeenCalledTimes(5);
  });
});
