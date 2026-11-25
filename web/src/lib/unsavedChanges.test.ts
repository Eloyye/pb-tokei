import { afterEach, describe, expect, it, vi } from "vitest";
import { reportSaveStatus, tabSaveStatus, waitUntilSaved } from "./unsavedChanges";

const owners: object[] = [];
function editor() {
  const owner = {};
  owners.push(owner);
  return owner;
}

afterEach(() => {
  for (const owner of owners.splice(0)) reportSaveStatus(owner, null);
  vi.useRealTimers();
});

describe("waitUntilSaved", () => {
  it("resolves at once when nothing is waiting to save", async () => {
    reportSaveStatus(editor(), { state: "saved" });

    await expect(waitUntilSaved()).resolves.toBeUndefined();
  });

  it("waits while a save is in flight, then resolves once every editor has saved", async () => {
    const a = editor();
    const b = editor();
    reportSaveStatus(a, { state: "saving" });
    reportSaveStatus(b, { state: "saving" });
    let done = false;
    const waiting = waitUntilSaved().then(() => {
      done = true;
    });

    reportSaveStatus(a, { state: "saved" });
    await Promise.resolve();
    expect(done).toBe(false);

    reportSaveStatus(b, null);
    await waiting;
    expect(done).toBe(true);
    expect(tabSaveStatus().state).toBe("saved");
  });

  it("refuses when a save is failing, rather than leave it behind", async () => {
    const a = editor();
    reportSaveStatus(a, { state: "saving" });
    const waiting = waitUntilSaved();

    reportSaveStatus(a, { state: "retrying", error: "503 Service Unavailable" });

    await expect(waiting).rejects.toThrow("503 Service Unavailable");
  });

  it("refuses a change the server refused", async () => {
    reportSaveStatus(editor(), { state: "refused", error: "segments overlap" });

    await expect(waitUntilSaved()).rejects.toThrow("segments overlap");
  });

  it("gives up after the timeout if saves are still going", async () => {
    vi.useFakeTimers();
    reportSaveStatus(editor(), { state: "saving" });
    const waiting = waitUntilSaved(1000);

    vi.advanceTimersByTime(1000);

    await expect(waiting).rejects.toThrow("still saving");
  });
});
