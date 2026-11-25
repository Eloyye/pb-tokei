// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Calibration,
  type CameraMotionFramesOut,
  type CameraMotionOut,
  getCameraMotion,
  getCameraMotionFrames,
  type PlaySegment,
  trackCameraMotion,
} from "../api/client";
import { useCameraMotion, WINDOW_SIZE } from "./useCameraMotion";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<Client>()),
  getCameraMotion: vi.fn<Client["getCameraMotion"]>(),
  trackCameraMotion: vi.fn<Client["trackCameraMotion"]>(),
  getCameraMotionFrames: vi.fn<Client["getCameraMotionFrames"]>(),
}));

const SEGMENTS: PlaySegment[] = [{ start_frame: 100, end_frame: 103, camera_view: "sideline" }];
const CALIBRATIONS: Calibration[] = [
  {
    camera_view: "sideline",
    effective_from_frame: 100,
    reference_frame: 100,
    landmarks: {},
    not_visible: [],
  },
];
const SAVED = { state: "saved" as const };
const MATRIX_A = [
  [1, 0, 0.1],
  [0, 1, 0.2],
  [0, 0, 1],
];
const MATRIX_B = [
  [1, 0, 0.3],
  [0, 1, 0.4],
  [0, 0, 1],
];

const READY_MOTION: CameraMotionOut = {
  status: "ready",
  error: null,
  tracked_spans: 1,
  total_spans: 1,
  unmapped_ranges: [{ start_frame: 102, end_frame: 102, camera_view: "sideline" }],
  spans: [
    {
      start_frame: 100,
      end_frame: 103,
      camera_view: "sideline",
      calibration_effective_from: 100,
      calibration_reference_frame: 100,
      tracked: true,
      mapped_frames: 3,
      unmapped_frames: 1,
      unmapped_ranges: [{ start_frame: 102, end_frame: 102, camera_view: "sideline" }],
    },
  ],
};

const LENS = { k1: 0.09, aspect: 16 / 9 };

const FRAMES_OUT: CameraMotionFramesOut = {
  start_frame: 100,
  end_frame: 103,
  court_to_image: [MATRIX_A, MATRIX_B, null, MATRIX_A],
  lens: [LENS, LENS, null, null],
  unmapped: [false, false, true, false],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(getCameraMotion).mockResolvedValue(READY_MOTION);
  vi.mocked(trackCameraMotion).mockResolvedValue(READY_MOTION);
  vi.mocked(getCameraMotionFrames).mockResolvedValue(FRAMES_OUT);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useCameraMotion", () => {
  it("auto-triggers tracking when idle and fetches frames once ready", async () => {
    vi.mocked(getCameraMotion).mockResolvedValueOnce({
      ...READY_MOTION,
      status: "idle",
      tracked_spans: 0,
      unmapped_ranges: [],
      spans: [{ ...READY_MOTION.spans[0]!, tracked: false, mapped_frames: 0, unmapped_frames: 0 }],
    });
    vi.mocked(trackCameraMotion).mockResolvedValueOnce(READY_MOTION);

    const { result, rerender } = renderHook(
      ({ frame }: { frame: number }) =>
        useCameraMotion("match-1", true, SAVED, SEGMENTS, CALIBRATIONS, frame),
      { initialProps: { frame: 101 } },
    );

    await waitFor(() => expect(result.current.frameMatrix).toEqual(MATRIX_B));
    expect(result.current.frameLens).toEqual(LENS);
    expect(trackCameraMotion).toHaveBeenCalledWith("match-1");
    expect(getCameraMotionFrames).toHaveBeenCalledTimes(1);
    expect(getCameraMotionFrames).toHaveBeenCalledWith("match-1", 100, 103);
    expect(result.current.frameUnmapped).toBe(false);

    // Seeking onto an unmapped frame in the cached window returns null + frameUnmapped without re-fetching.
    rerender({ frame: 102 });
    expect(result.current.frameMatrix).toBeNull();
    expect(result.current.frameLens).toBeNull();
    expect(result.current.frameUnmapped).toBe(true);
    expect(getCameraMotionFrames).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight frame-window fetch when the playhead moves within the window", async () => {
    const framesReq = deferred<CameraMotionFramesOut>();
    vi.mocked(getCameraMotionFrames).mockReturnValueOnce(framesReq.promise);

    const { result, rerender } = renderHook(
      ({ frame }: { frame: number }) =>
        useCameraMotion("match-1", true, SAVED, SEGMENTS, CALIBRATIONS, frame),
      { initialProps: { frame: 100 } },
    );

    await waitFor(() => expect(getCameraMotionFrames).toHaveBeenCalledTimes(1));

    // Advance the playhead during playback before the response resolves.
    rerender({ frame: 101 });
    rerender({ frame: 103 });

    await act(async () => {
      framesReq.resolve(FRAMES_OUT);
      await framesReq.promise;
    });

    expect(result.current.frameMatrix).toEqual(MATRIX_A);
    expect(getCameraMotionFrames).toHaveBeenCalledTimes(1);
  });

  it("polls while tracking and re-triggers if tracking settles back to idle", async () => {
    vi.useFakeTimers();
    const tracking: CameraMotionOut = {
      ...READY_MOTION,
      status: "tracking",
      tracked_spans: 0,
      unmapped_ranges: [],
      spans: [{ ...READY_MOTION.spans[0]!, tracked: false, mapped_frames: 0, unmapped_frames: 0 }],
    };
    const idle: CameraMotionOut = { ...tracking, status: "idle" };
    vi.mocked(getCameraMotion)
      .mockResolvedValueOnce(tracking)
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(READY_MOTION);
    vi.mocked(trackCameraMotion).mockResolvedValueOnce(tracking);

    const { result } = renderHook(() =>
      useCameraMotion("match-1", true, SAVED, SEGMENTS, CALIBRATIONS, 100),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.motion?.status).toBe("tracking");

    // First poll lands on idle -> automatically calls trackCameraMotion and stays tracking.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(trackCameraMotion).toHaveBeenCalledTimes(1);
    expect(result.current.motion?.status).toBe("tracking");

    // Second poll finishes ready -> fetches frames.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(result.current.motion?.status).toBe("ready");
    expect(result.current.frameMatrix).toEqual(MATRIX_A);
  });

  it("clears stale motion and cached windows when Calibrations change", async () => {
    const edited: Calibration[] = [
      {
        ...CALIBRATIONS[0]!,
        landmarks: { near_kitchen_left: { x: 0.25, y: 0.6, frame: 100 } },
      },
    ];
    const nextMotionReq = deferred<CameraMotionOut>();

    const { result, rerender } = renderHook(
      ({ calibrations }: { calibrations: Calibration[] }) =>
        useCameraMotion("match-1", true, SAVED, SEGMENTS, calibrations, 100),
      { initialProps: { calibrations: CALIBRATIONS } },
    );

    await waitFor(() => expect(result.current.frameMatrix).toEqual(MATRIX_A));

    vi.mocked(getCameraMotion).mockReturnValueOnce(nextMotionReq.promise);
    rerender({ calibrations: edited });

    // Stale motion and frame matrix are cleared immediately while the new scope loads.
    expect(result.current.motion).toBeNull();
    expect(result.current.frameMatrix).toBeUndefined();

    await act(async () => {
      nextMotionReq.resolve(READY_MOTION);
      await nextMotionReq.promise;
    });
    await waitFor(() => expect(result.current.frameMatrix).toEqual(MATRIX_A));
    expect(getCameraMotionFrames).toHaveBeenCalledTimes(2);
  });

  it("splits spans longer than WINDOW_SIZE into chunked frame requests", async () => {
    const longEnd = WINDOW_SIZE + 500;
    const longSegments: PlaySegment[] = [
      { start_frame: 0, end_frame: longEnd, camera_view: "main" },
    ];
    const longMotion: CameraMotionOut = {
      status: "ready",
      error: null,
      tracked_spans: 1,
      total_spans: 1,
      unmapped_ranges: [],
      spans: [
        {
          start_frame: 0,
          end_frame: longEnd,
          camera_view: "main",
          calibration_effective_from: 0,
          calibration_reference_frame: 0,
          tracked: true,
          mapped_frames: longEnd + 1,
          unmapped_frames: 0,
          unmapped_ranges: [],
        },
      ],
    };
    vi.mocked(getCameraMotion).mockResolvedValue(longMotion);
    vi.mocked(getCameraMotionFrames).mockImplementation(async (_id, start, end) => ({
      start_frame: start,
      end_frame: end,
      court_to_image: Array.from({ length: end - start + 1 }, () =>
        start === 0 ? MATRIX_A : MATRIX_B,
      ),
      lens: Array.from({ length: end - start + 1 }, () => null),
      unmapped: Array.from({ length: end - start + 1 }, () => false),
    }));

    const { result, rerender } = renderHook(
      ({ frame }: { frame: number }) =>
        useCameraMotion("match-1", true, SAVED, longSegments, CALIBRATIONS, frame),
      { initialProps: { frame: 100 } },
    );

    await waitFor(() => expect(result.current.frameMatrix).toEqual(MATRIX_A));
    expect(getCameraMotionFrames).toHaveBeenCalledWith("match-1", 0, WINDOW_SIZE - 1);

    rerender({ frame: WINDOW_SIZE + 10 });
    await waitFor(() => expect(result.current.frameMatrix).toEqual(MATRIX_B));
    expect(getCameraMotionFrames).toHaveBeenCalledWith("match-1", WINDOW_SIZE, longEnd);
  });

  it("retries tracking when retrack is called after an error", async () => {
    vi.mocked(getCameraMotion).mockResolvedValueOnce({
      ...READY_MOTION,
      status: "error",
      error: "ffmpeg error",
      tracked_spans: 0,
      unmapped_ranges: [],
      spans: [{ ...READY_MOTION.spans[0]!, tracked: false, mapped_frames: 0, unmapped_frames: 0 }],
    });

    const { result } = renderHook(() =>
      useCameraMotion("match-1", true, SAVED, SEGMENTS, CALIBRATIONS, 100),
    );

    await waitFor(() => expect(result.current.motion?.status).toBe("error"));

    act(() => result.current.retrack());
    await waitFor(() => expect(result.current.motion?.status).toBe("ready"));
    expect(trackCameraMotion).toHaveBeenCalledWith("match-1");
  });

  it("does nothing while disabled or while edits are still saving", () => {
    const disabled = renderHook(() =>
      useCameraMotion("match-1", false, SAVED, SEGMENTS, CALIBRATIONS, 100),
    );
    const saving = renderHook(() =>
      useCameraMotion("match-1", true, { state: "saving" }, SEGMENTS, CALIBRATIONS, 100),
    );

    expect(getCameraMotion).not.toHaveBeenCalled();
    expect(disabled.result.current.motion).toBeNull();
    expect(disabled.result.current.frameMatrix).toBeUndefined();
    expect(saving.result.current.motion).toBeNull();
    expect(saving.result.current.frameMatrix).toBeUndefined();
  });
});
