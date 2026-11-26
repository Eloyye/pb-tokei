// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Calibration,
  cancelPlayerTracking,
  getPlayerTracking,
  getPlayerTrackingFrames,
  type PlayerAnchor,
  type PlayerTrackingFrameOut,
  type PlayerTrackingFramesOut,
  type PlayerTrackingOut,
  type PlaySegment,
  type TeamEnd,
  trackPlayers,
} from "../api/client";
import { PLAYER_WINDOW_SIZE, usePlayerTracking } from "./usePlayerTracking";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<Client>()),
  getPlayerTracking: vi.fn<Client["getPlayerTracking"]>(),
  trackPlayers: vi.fn<Client["trackPlayers"]>(),
  cancelPlayerTracking: vi.fn<Client["cancelPlayerTracking"]>(),
  getPlayerTrackingFrames: vi.fn<Client["getPlayerTrackingFrames"]>(),
}));

const SEGMENTS: PlaySegment[] = [{ start_frame: 0, end_frame: 399, camera_view: "main" }];
const CALIBRATIONS: Calibration[] = [
  {
    camera_view: "main",
    effective_from_frame: 0,
    reference_frame: 0,
    landmarks: {},
    not_visible: [],
  },
];
const EMPTY_ANCHORS: PlayerAnchor[] = [];
const EMPTY_ENDS: TeamEnd[] = [];
const SAVED = { state: "saved" as const };

const IDLE_STATUS: PlayerTrackingOut = {
  status: "idle",
  error: null,
  device: "mps",
  progress: 0,
  tracked_segments: 0,
  total_segments: 1,
  opposite_end_flip_y_ft: 2.0,
  spans: [
    { start_frame: 0, end_frame: 399, camera_view: "main", tracked: false, status: "pending" },
  ],
};

const TRACKING_STATUS: PlayerTrackingOut = {
  ...IDLE_STATUS,
  status: "tracking",
  progress: 40,
  spans: [
    { start_frame: 0, end_frame: 399, camera_view: "main", tracked: false, status: "tracking" },
  ],
};

const READY_STATUS: PlayerTrackingOut = {
  ...IDLE_STATUS,
  status: "ready",
  progress: 100,
  tracked_segments: 1,
  spans: [{ start_frame: 0, end_frame: 399, camera_view: "main", tracked: true, status: "done" }],
};

function makeFramesWindow(start: number, end: number): PlayerTrackingFramesOut {
  const frames: PlayerTrackingFrameOut[] = [];
  for (let f = start; f <= end; f++) {
    frames.push({
      frame: f,
      near_team_id: "team-a",
      players: [],
      detections: [],
    });
  }
  return { start_frame: start, end_frame: end, frames };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(getPlayerTracking).mockResolvedValue(IDLE_STATUS);
  vi.mocked(trackPlayers).mockResolvedValue(TRACKING_STATUS);
  vi.mocked(cancelPlayerTracking).mockResolvedValue(IDLE_STATUS);
  vi.mocked(getPlayerTrackingFrames).mockImplementation(async (_id, s, e) =>
    makeFramesWindow(s, e),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Tracking at frame 10 of SEGMENTS, for a new Shot's snapshot. */
function renderAt(enabled = true, anchors: PlayerAnchor[] = EMPTY_ANCHORS) {
  return renderHook(() =>
    usePlayerTracking(
      "match-1",
      enabled,
      SAVED,
      SEGMENTS,
      CALIBRATIONS,
      anchors,
      EMPTY_ENDS,
      0,
      10,
    ),
  );
}

describe("usePlayerTracking", () => {
  it("loads status without auto-triggering tracking, then polls after explicit startTracking until ready", async () => {
    vi.useFakeTimers();
    vi.mocked(getPlayerTracking)
      .mockResolvedValueOnce(IDLE_STATUS)
      .mockResolvedValueOnce(TRACKING_STATUS)
      .mockResolvedValueOnce(READY_STATUS);

    const { result } = renderHook(() =>
      usePlayerTracking(
        "match-1",
        true,
        SAVED,
        SEGMENTS,
        CALIBRATIONS,
        EMPTY_ANCHORS,
        EMPTY_ENDS,
        0,
        25,
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status?.status).toBe("idle");
    expect(trackPlayers).not.toHaveBeenCalled();

    // Explicit trigger passes priority_frame and enters polling mode.
    await act(async () => {
      result.current.startTracking(25);
      await Promise.resolve();
    });
    expect(trackPlayers).toHaveBeenCalledWith("match-1", { priority_frame: 25 });
    expect(result.current.status?.status).toBe("tracking");

    // First poll still tracking -> schedules next poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.status?.status).toBe("tracking");

    // Second poll completes ready -> fetches the aligned frame window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.status?.status).toBe("ready");
    expect(getPlayerTrackingFrames).toHaveBeenCalledWith("match-1", 0, PLAYER_WINDOW_SIZE - 1);
    expect(result.current.frameData?.frame).toBe(25);
  });

  it("cancels an active tracking job and stops polling", async () => {
    vi.useFakeTimers();
    vi.mocked(getPlayerTracking).mockResolvedValue(TRACKING_STATUS);

    const { result } = renderHook(() =>
      usePlayerTracking(
        "match-1",
        true,
        SAVED,
        SEGMENTS,
        CALIBRATIONS,
        EMPTY_ANCHORS,
        EMPTY_ENDS,
        0,
        10,
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status?.status).toBe("tracking");

    await act(async () => {
      result.current.cancelTracking();
      await Promise.resolve();
    });
    expect(cancelPlayerTracking).toHaveBeenCalledWith("match-1");
    expect(result.current.status?.status).toBe("idle");

    const callsAfterCancel = vi.mocked(getPlayerTracking).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(vi.mocked(getPlayerTracking).mock.calls.length).toBe(callsAfterCancel);
  });

  it("caches frame windows across seeks and fetches the next window past PLAYER_WINDOW_SIZE", async () => {
    vi.mocked(getPlayerTracking).mockResolvedValue(READY_STATUS);

    const { result, rerender } = renderHook(
      ({ frame }: { frame: number }) =>
        usePlayerTracking(
          "match-1",
          true,
          SAVED,
          SEGMENTS,
          CALIBRATIONS,
          EMPTY_ANCHORS,
          EMPTY_ENDS,
          0,
          frame,
        ),
      { initialProps: { frame: 10 } },
    );

    await waitFor(() => expect(result.current.frameData?.frame).toBe(10));
    expect(getPlayerTrackingFrames).toHaveBeenCalledTimes(1);
    expect(getPlayerTrackingFrames).toHaveBeenCalledWith("match-1", 0, PLAYER_WINDOW_SIZE - 1);

    // Seeking within the same window reuses the cached window without a new fetch.
    rerender({ frame: 120 });
    expect(result.current.frameData?.frame).toBe(120);
    expect(getPlayerTrackingFrames).toHaveBeenCalledTimes(1);

    // Seeking into the second chunk fetches [PLAYER_WINDOW_SIZE, 399].
    rerender({ frame: 350 });
    await waitFor(() => expect(result.current.frameData?.frame).toBe(350));
    expect(getPlayerTrackingFrames).toHaveBeenCalledTimes(2);
    expect(getPlayerTrackingFrames).toHaveBeenLastCalledWith("match-1", PLAYER_WINDOW_SIZE, 399);
  });

  it("ignores stale status and frame responses after switching to another Match", async () => {
    const match1Status = deferred<PlayerTrackingOut>();
    const match2Status = deferred<PlayerTrackingOut>();
    const match1Frames = deferred<PlayerTrackingFramesOut>();

    vi.mocked(getPlayerTracking)
      .mockReturnValueOnce(match1Status.promise)
      .mockReturnValueOnce(match2Status.promise);
    vi.mocked(getPlayerTrackingFrames).mockReturnValueOnce(match1Frames.promise);

    const { result, rerender } = renderHook(
      ({ matchId }: { matchId: string }) =>
        usePlayerTracking(
          matchId,
          true,
          SAVED,
          SEGMENTS,
          CALIBRATIONS,
          EMPTY_ANCHORS,
          EMPTY_ENDS,
          0,
          5,
        ),
      { initialProps: { matchId: "match-1" } },
    );

    // Switch to match-2 while match-1's status request is still in flight.
    rerender({ matchId: "match-2" });
    expect(result.current.status).toBeNull();

    // Resolve match-1 late: must NOT overwrite match-2's status!
    await act(async () => {
      match1Status.resolve(READY_STATUS);
      await match1Status.promise;
    });
    expect(result.current.status).toBeNull();

    // Now resolve match-2 cleanly.
    await act(async () => {
      match2Status.resolve({ ...IDLE_STATUS, device: "cpu" });
      await match2Status.promise;
    });
    expect(result.current.status?.device).toBe("cpu");
  });

  describe("Player Tracking for a new Shot (cachedAt / trackingAt)", () => {
    it("asks for a fetch until the status has loaded, then knows nothing is tracked", async () => {
      const status = deferred<PlayerTrackingOut>();
      vi.mocked(getPlayerTracking).mockReturnValue(status.promise);
      const { result } = renderAt();
      expect(result.current.cachedAt(10)).toBeUndefined();

      await act(async () => status.resolve(IDLE_STATUS));
      expect(result.current.cachedAt(10)).toBeNull();
    });

    it("needs a fetch when an anchor exists but the frame isn't loaded", async () => {
      vi.mocked(getPlayerTracking).mockResolvedValue(IDLE_STATUS);
      vi.mocked(getPlayerTrackingFrames).mockReturnValue(new Promise(() => {}));
      const anchor: PlayerAnchor = {
        frame: 5,
        player_id: "p1",
        kind: "identity",
        image_x: 0.5,
        image_y: 0.5,
      };
      const { result } = renderAt(true, [anchor]);
      await waitFor(() => expect(getPlayerTracking).toHaveBeenCalled());
      expect(result.current.cachedAt(10)).toBeUndefined();
    });

    it("serves a loaded frame without fetching, and fetches one frame otherwise", async () => {
      vi.mocked(getPlayerTracking).mockResolvedValue(READY_STATUS);
      const { result } = renderAt();
      await waitFor(() => expect(result.current.frameData?.frame).toBe(10));
      expect(result.current.cachedAt(42)?.frame).toBe(42);
      expect((await result.current.trackingAt(42))?.frame).toBe(42);
      expect(getPlayerTrackingFrames).toHaveBeenCalledTimes(1);

      // Outside the loaded window (frame 350 is in the next one): a one-frame fetch.
      expect(result.current.cachedAt(350)).toBeUndefined();
      expect((await result.current.trackingAt(350))?.frame).toBe(350);
      expect(getPlayerTrackingFrames).toHaveBeenLastCalledWith("match-1", 350, 350);
    });

    it("gives nothing without video, and nothing when a fetch fails", async () => {
      const disabled = renderAt(false);
      expect(disabled.result.current.cachedAt(10)).toBeNull();
      expect(await disabled.result.current.trackingAt(10)).toBeUndefined();
      disabled.unmount();

      vi.mocked(getPlayerTracking).mockResolvedValue(READY_STATUS);
      vi.mocked(getPlayerTrackingFrames).mockRejectedValue(new Error("offline"));
      const { result } = renderAt();
      expect(await result.current.trackingAt(350)).toBeUndefined();
    });
  });
});
