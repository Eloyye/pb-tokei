// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useActionQueue } from "./useActionQueue";

interface Item {
  key: string;
  frame: number;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A queue whose `m` items wait on `pending` (when set); every run is logged. */
function setUp() {
  const log: Item[] = [];
  let pending: Promise<void> | undefined;
  const execute = vi.fn<(item: Item) => unknown>((item) => {
    log.push(item);
    return item.key === "m" ? pending : undefined;
  });
  const hook = renderHook(() => useActionQueue(execute));
  return {
    log,
    run: (item: Item) => act(() => hook.result.current(item)),
    waitOn: (promise: Promise<void> | undefined) => {
      pending = promise;
    },
  };
}

describe("useActionQueue", () => {
  it("runs at once when nothing is waiting", () => {
    const { log, run } = setUp();
    run({ key: "s", frame: 10 });
    expect(log).toEqual([{ key: "s", frame: 10 }]);
  });

  it("holds two or more later items until a pending action settles, then runs them in order", async () => {
    const { log, run, waitOn } = setUp();
    const fetch = deferred();
    waitOn(fetch.promise);
    run({ key: "m", frame: 100 });
    run({ key: "s", frame: 100 });
    run({ key: "Enter", frame: 140 });
    run({ key: "g", frame: 150 });
    expect(log.map((i) => i.key)).toEqual(["m"]);

    await act(async () => fetch.resolve());
    expect(log).toEqual([
      { key: "m", frame: 100 },
      { key: "s", frame: 100 },
      { key: "Enter", frame: 140 },
      { key: "g", frame: 150 },
    ]);

    // Drained: the next item runs straight away.
    run({ key: "h", frame: 160 });
    expect(log.at(-1)).toEqual({ key: "h", frame: 160 });
  });

  it("holds again for a pending action that was itself waiting", async () => {
    const { log, run, waitOn } = setUp();
    const first = deferred();
    waitOn(first.promise);
    run({ key: "m", frame: 100 });
    run({ key: "m", frame: 200 });
    run({ key: "s", frame: 200 });
    const second = deferred();
    waitOn(second.promise);

    await act(async () => first.resolve());
    expect(log.map((i) => `${i.key}@${i.frame}`)).toEqual(["m@100", "m@200"]);

    await act(async () => second.resolve());
    expect(log.map((i) => `${i.key}@${i.frame}`)).toEqual(["m@100", "m@200", "s@200"]);
  });

  it("releases the queue when the pending action fails", async () => {
    const { log, run, waitOn } = setUp();
    const fetch = deferred();
    waitOn(fetch.promise);
    run({ key: "m", frame: 100 });
    run({ key: "s", frame: 100 });
    await act(async () => fetch.reject(new Error("offline")));
    expect(log.map((i) => i.key)).toEqual(["m", "s"]);
  });
});
