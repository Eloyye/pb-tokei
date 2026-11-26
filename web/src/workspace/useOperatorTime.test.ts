// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type MatchDetail,
  type OperatorTime,
  upsertOperatorSession,
} from "../api/client";
import { FLUSH_INTERVAL_MS, IDLE_TIMEOUT_MS } from "../lib/operatorTime";
import { tabSaveStatus } from "../lib/unsavedChanges";
import type { Workspace } from "../lib/workspaces";
import { useOperatorTime } from "./useOperatorTime";

type Client = typeof import("../api/client");
const LOG = "/tmp/one.duckdb";

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getTabRallyLog: () => LOG,
  upsertOperatorSession: vi.fn<Client["upsertOperatorSession"]>(),
}));

const save = vi.mocked(upsertOperatorSession);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function totals(annotate = 0, calibrate = 0, review = 0): OperatorTime {
  return {
    annotate_seconds: annotate,
    calibrate_seconds: calibrate,
    review_seconds: review,
    active_seconds: annotate + calibrate + review,
  };
}

const match: MatchDetail = {
  id: "match",
  tournament: "Test Open",
  team_a: ["A1", "A2"],
  team_b: ["B1", "B2"],
  franchise_a: null,
  franchise_b: null,
  video_status: "ready",
  annotation_mode: "gold",
  operator_time: totals(10),
  broadcast_seconds: 100,
  operator_time_ratio: 0.1,
  fix_command: null,
  source_url: null,
  original_present: true,
  team_a_id: "team-a",
  team_b_id: "team-b",
  players: [],
};

function renderClock(initialWorkspace: Workspace = "annotate", initialMatch = match) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["matches"], [initialMatch]);
  queryClient.setQueryData(["matches", match.id], initialMatch);
  return {
    queryClient,
    ...renderHook(({ currentMatch, workspace }) => useOperatorTime(currentMatch, workspace), {
      initialProps: { currentMatch: initialMatch, workspace: initialWorkspace },
      wrapper: ({ children }: PropsWithChildren) =>
        createElement(QueryClientProvider, { client: queryClient }, children),
    }),
  };
}

function input(type = "pointerdown") {
  fireEvent(window, new Event(type));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  save.mockReset();
  save.mockImplementation(async (_matchId, _sessionId, body) =>
    totals(10 + (body.workspace === "annotate" ? body.active_seconds : 0)),
  );
});

afterEach(async () => {
  await act(async () => cleanup());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useOperatorTime", () => {
  it("starts idle and sends committed intervals, rolling back the live tail on blur", async () => {
    const { result, queryClient } = renderClock();
    input("pointermove");
    input("playing");
    await advance(FLUSH_INTERVAL_MS);
    expect(result.current).toEqual({ time: totals(10), idle: true });

    input("keydown");
    await advance(FLUSH_INTERVAL_MS);
    expect(save).not.toHaveBeenCalled();
    expect(result.current.time.active_seconds).toBe(25);
    input("wheel");
    await advance(FLUSH_INTERVAL_MS);

    expect(save).toHaveBeenCalledExactlyOnceWith(
      match.id,
      expect.any(String),
      expect.objectContaining({ workspace: "annotate", active_seconds: 15 }),
      { keepalive: true, rallyLog: LOG },
    );
    expect(result.current.time.active_seconds).toBe(40);
    expect(queryClient.getQueryData<MatchDetail>(["matches", match.id])?.operator_time).toEqual(
      totals(25),
    );
    expect(tabSaveStatus().state).toBe("saved");

    input("blur");
    expect(result.current).toEqual({ time: totals(25), idle: true });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    input("wheel");
    await advance(5000);
    expect(result.current.idle).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("discards the idle tail and requires deliberate input after hiding the tab", async () => {
    const { result } = renderClock();
    input("input");
    await advance(2000);
    input("change");
    await advance(IDLE_TIMEOUT_MS - 1000);
    expect(result.current.time.active_seconds).toBe(131);
    await advance(1000);
    expect(result.current).toEqual({ time: totals(12), idle: true });

    input();
    await advance(3000);
    expect(result.current.time.active_seconds).toBe(15);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    input("keydown");
    expect(result.current).toEqual({ time: totals(12), idle: true });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("coalesces writes and keeps workspace totals continuous through a keepalive flush", async () => {
    const first = deferred<OperatorTime>();
    save
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(totals(10, 16))
      .mockResolvedValueOnce(totals(10, 16, 2));
    const { result, rerender } = renderClock("calibrate");

    input();
    await advance(4000);
    input();
    await advance(12_000);
    expect(save).toHaveBeenCalledTimes(1);
    input();
    rerender({ currentMatch: match, workspace: "review" });
    expect(result.current).toEqual({ time: totals(10, 16), idle: true });

    input();
    await advance(2000);
    input();
    await advance(1000);
    input("pagehide");
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ time: totals(10, 16, 2), idle: true });
    await act(async () => first.resolve(totals(10, 4)));

    expect(save.mock.calls.map(([, , body]) => [body.workspace, body.active_seconds])).toEqual([
      ["calibrate", 4],
      ["calibrate", 16],
      ["review", 2],
    ]);
    expect(save.mock.calls[0]?.[1]).toBe(save.mock.calls[1]?.[1]);
    expect(save.mock.calls[2]?.[1]).not.toBe(save.mock.calls[1]?.[1]);
    expect(save.mock.calls[2]?.[3]?.keepalive).toBe(true);
    expect(result.current).toEqual({ time: totals(10, 16, 2), idle: true });
  });

  it.each([new ApiError(503, "Busy"), new TypeError("Network error")])(
    "backs off and retries a temporary failure (%s)",
    async (error) => {
      save.mockRejectedValueOnce(error);
      const { result } = renderClock();
      input();
      await advance(1000);
      input();
      input("blur");
      await advance(999);
      expect(save).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(save).toHaveBeenCalledTimes(2);
      expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
      expect(result.current).toEqual({ time: totals(11), idle: true });
      expect(tabSaveStatus().state).toBe("saved");
    },
  );

  it("acknowledges an uncertain write before sending the next workspace's time", async () => {
    const first = deferred<OperatorTime>();
    save
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(totals(10, 4))
      .mockResolvedValueOnce(totals(10, 4, 2));
    const { result, rerender } = renderClock("calibrate");
    input();
    await advance(4000);
    input();
    rerender({ currentMatch: match, workspace: "review" });
    input();
    await advance(2000);
    input();
    input("blur");
    await act(async () => first.reject(new TypeError("Response lost")));
    await advance(1000);

    expect(save.mock.calls.map(([, , body]) => body.workspace)).toEqual([
      "calibrate",
      "calibrate",
      "review",
    ]);
    expect(result.current).toEqual({ time: totals(10, 4, 2), idle: true });
  });

  it("records a new session if the wall clock moves backward", async () => {
    save.mockResolvedValueOnce(totals(14)).mockResolvedValueOnce(totals(16));
    const { result } = renderClock();
    input();
    await advance(4000);
    input();

    vi.setSystemTime(Date.now() - 60_000);
    input();
    await advance(2000);
    input();
    input("blur");
    await advance(0);

    expect(save).toHaveBeenCalledTimes(2);
    const [, firstId, first] = save.mock.calls[0]!;
    const [, secondId, second] = save.mock.calls[1]!;
    expect(first.active_seconds).toBe(4);
    expect(second.active_seconds).toBe(2);
    expect(secondId).not.toBe(firstId);
    expect(Date.parse(second.ended_at) - Date.parse(second.started_at)).toBe(2000);
    expect(result.current).toEqual({ time: totals(16), idle: true });
  });

  it.each([409, 422])("stops silently after a refused write (%s)", async (status) => {
    save.mockRejectedValueOnce(new ApiError(status, "Refused"));
    const { result } = renderClock();
    input();
    await advance(1000);
    input();
    input("blur");
    await advance(2000);
    input();
    await advance(FLUSH_INTERVAL_MS);
    input();
    expect(result.current).toEqual({ time: totals(10), idle: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(tabSaveStatus().state).toBe("saved");
  });

  it("keeps the Home row current on unmount and saves the final committed interval", async () => {
    const write = deferred<OperatorTime>();
    save.mockReturnValueOnce(write.promise);
    const { queryClient, unmount } = renderClock();
    input();
    await advance(4000);
    input();
    await advance(1000);
    unmount();

    expect(save.mock.calls[0]?.[2].active_seconds).toBe(4);
    expect(queryClient.getQueryData<MatchDetail[]>(["matches"])?.[0]?.operator_time_ratio).toBe(
      0.14,
    );
    await act(async () => write.resolve(totals(14)));
    expect(queryClient.getQueryState(["matches"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData<MatchDetail>(["matches", match.id])?.operator_time).toEqual(
      totals(14),
    );
  });

  it("stays idle and sends nothing when a Match has no ready footage", async () => {
    const { result } = renderClock("annotate", { ...match, video_status: "not_converted" });
    input();
    await advance(1000);
    input();
    await advance(FLUSH_INTERVAL_MS);
    expect(save).not.toHaveBeenCalled();
    expect(result.current).toEqual({ time: totals(10), idle: true });
  });
});
