import { describe, expect, it } from "vitest";
import { combineStatus, createSaveQueue, type SaveStatus } from "./saveQueue";

/** A save whose calls finish only when the test says so. */
function controlledSave() {
  const calls: { value: number; resolve: () => void; reject: (e: Error) => void }[] = [];
  const save = (value: number) =>
    new Promise<void>((resolve, reject) => calls.push({ value, resolve, reject }));
  return { calls, save };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function queueFor(save: (value: number) => Promise<void>, retryable = () => true) {
  const statuses: SaveStatus["state"][] = [];
  const queue = createSaveQueue(save, {
    retryable,
    onStatus: (s) => statuses.push(s.state),
    wait: () => Promise.resolve(),
  });
  return { queue, statuses };
}

describe("createSaveQueue", () => {
  it("keeps one save in flight and sends only the latest value next", async () => {
    const { calls, save } = controlledSave();
    const { queue } = queueFor(save);

    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(calls.map((c) => c.value)).toEqual([1]);

    calls[0]!.resolve();
    await settle();
    expect(calls.map((c) => c.value)).toEqual([1, 3]);

    calls[1]!.resolve();
    await settle();
    expect(queue.status()).toEqual({ state: "saved" });
  });

  it("retries a failed save with the latest value", async () => {
    const { calls, save } = controlledSave();
    const { queue, statuses } = queueFor(save);

    queue.push(1);
    queue.push(2);
    calls[0]!.reject(new Error("offline"));
    await settle();
    expect(statuses).toContain("retrying");
    expect(calls.map((c) => c.value)).toEqual([1, 2]);

    calls[1]!.resolve();
    await settle();
    expect(queue.status().state).toBe("saved");
  });

  it("retries the same value when nothing newer came in", async () => {
    const { calls, save } = controlledSave();
    const { queue } = queueFor(save);

    queue.push(7);
    calls[0]!.reject(new Error("offline"));
    await settle();

    expect(calls.map((c) => c.value)).toEqual([7, 7]);
  });

  it("stops on a refused save unless a newer value is waiting", async () => {
    const { calls, save } = controlledSave();
    const { queue } = queueFor(save, () => false);

    queue.push(1);
    calls[0]!.reject(new Error("422 overlap"));
    await settle();
    expect(queue.status()).toEqual({ state: "refused", error: "422 overlap" });
    expect(calls).toHaveLength(1);

    queue.push(2);
    queue.push(3);
    calls[1]!.reject(new Error("422 again"));
    await settle();
    expect(calls.map((c) => c.value)).toEqual([1, 2, 3]);
  });

  it("still sends the value waiting behind a save in flight when closed", async () => {
    const { calls, save } = controlledSave();
    const { queue, statuses } = queueFor(save);

    queue.push(1);
    queue.push(2);
    const reported = statuses.length;
    queue.close();
    calls[0]!.resolve();
    await settle();

    expect(calls.map((c) => c.value)).toEqual([1, 2]);
    calls[1]!.reject(new Error("offline"));
    await settle();
    expect(calls).toHaveLength(2); // the flush is not retried
    expect(statuses).toHaveLength(reported); // nor reported
  });

  it("cuts a retry wait short when closed and sends the waiting value once", async () => {
    const { calls, save } = controlledSave();
    const statuses: SaveStatus["state"][] = [];
    const queue = createSaveQueue(save, {
      retryable: () => true,
      onStatus: (s) => statuses.push(s.state),
      wait: () => new Promise(() => {}), // a backoff that never ends on its own
    });

    queue.push(1);
    calls[0]!.reject(new Error("503"));
    await settle();
    queue.push(2);
    expect(calls).toHaveLength(1);

    queue.close();
    await settle();

    expect(calls.map((c) => c.value)).toEqual([1, 2]);
    expect(statuses.at(-1)).toBe("retrying");
  });

  it("ignores values pushed after closing", async () => {
    const { calls, save } = controlledSave();
    const { queue } = queueFor(save);

    queue.close();
    queue.push(1);
    await settle();

    expect(calls).toHaveLength(0);
  });
});

describe("settled", () => {
  it("resolves at once when idle, and after the save in flight lands otherwise", async () => {
    const { calls, save } = controlledSave();
    const { queue } = queueFor(save);
    let settled = false;

    await queue.settled();
    queue.push(1);
    void queue.settled().then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);

    calls[0]!.resolve();
    await settle();
    expect(settled).toBe(true);
  });

  it("waits for the last value a closing queue still sends", async () => {
    const { calls, save } = controlledSave();
    const { queue } = queueFor(save);
    let settled = false;

    queue.push(1);
    queue.push(2);
    queue.close();
    void queue.settled().then(() => {
      settled = true;
    });
    calls[0]!.resolve();
    await settle();
    expect(calls.map((c) => c.value)).toEqual([1, 2]);
    expect(settled).toBe(false);

    calls[1]!.resolve();
    await settle();
    expect(settled).toBe(true);
  });
});

describe("combineStatus", () => {
  it("reports the worst status", () => {
    expect(combineStatus([{ state: "saved" }, { state: "saving" }]).state).toBe("saving");
    expect(
      combineStatus([{ state: "saving" }, { state: "retrying", error: "x" }, { state: "saved" }])
        .state,
    ).toBe("retrying");
    expect(combineStatus([]).state).toBe("saved");
  });
});
