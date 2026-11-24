// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
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
import { useCameraMotion } from "./useCameraMotion";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<Client>()),
  getCameraMotion: vi.fn<Client["getCameraMotion"]>(),
  trackCameraMotion: vi.fn<Client["trackCameraMotion"]>(),
  getCameraMotionFrames: vi.fn<Client["getCameraMotionFrames"]>(),
}));

const SEGMENTS: PlaySegment[] = [{ start_frame: 100, end_frame: 103, camera_view: "sideline" }];
const CALIBRATIONS: Calibration[] = [
  { camera_view: "sideline", effective_from_frame: 100, reference_frame: 100, landmarks: {} },
];
const SAVED = { state: "saved" as const };
const MATRIX = [
  [1, 0, 0.1],
  [0, 1, 0.2],
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

const FRAMES_OUT: CameraMotionFramesOut = {
  start_frame: 100,
  end_frame: 103,
  court_to_image: [MATRIX, MATRIX, null, MATRIX],
  unmapped: [false, false, true, false],
};

beforeEach(() => {
  vi.mocked(getCameraMotion).mockResolvedValue(READY_MOTION);
  vi.mocked(trackCameraMotion).mockResolvedValue(READY_MOTION);
  vi.mocked(getCameraMotionFrames).mockResolvedValue(FRAMES_OUT);
});

afterEach(() => {
  vi.clearAllMocks();
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

    await waitFor(() => expect(result.current.frameMatrix).toEqual(MATRIX));
    expect(trackCameraMotion).toHaveBeenCalledWith("match-1");
    expect(getCameraMotionFrames).toHaveBeenCalledTimes(1);
    expect(getCameraMotionFrames).toHaveBeenCalledWith("match-1", 100, 103);
    expect(result.current.frameUnmapped).toBe(false);

    // Seeking onto an unmapped frame in the cached window returns null + frameUnmapped without re-fetching.
    rerender({ frame: 102 });
    expect(result.current.frameMatrix).toBeNull();
    expect(result.current.frameUnmapped).toBe(true);
    expect(getCameraMotionFrames).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled or while edits are still saving", () => {
    const { result } = renderHook(() =>
      useCameraMotion("match-1", true, { state: "saving" }, SEGMENTS, CALIBRATIONS, 100),
    );

    expect(getCameraMotion).not.toHaveBeenCalled();
    expect(result.current.motion).toBeNull();
    expect(result.current.frameMatrix).toBeUndefined();
  });
});
