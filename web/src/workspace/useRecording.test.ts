// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type CalibrationOut,
  getCalibrations,
  getPlaySegments,
  type PlaySegment,
  replaceCalibrations,
  replacePlaySegments,
} from "../api/client";
import { clearLandmark, currentFit, fitKey, placeLandmark } from "../lib/calibrations";
import { markIn, markOut } from "../lib/segments";
import { useRecording } from "./useRecording";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<Client>()),
  getPlaySegments: vi.fn<Client["getPlaySegments"]>(),
  getCalibrations: vi.fn<Client["getCalibrations"]>(),
  replacePlaySegments: vi.fn<Client["replacePlaySegments"]>(),
  replaceCalibrations: vi.fn<Client["replaceCalibrations"]>(),
}));

const SEGMENTS: PlaySegment[] = [
  { start_frame: 100, end_frame: 199, camera_view: "main" },
  { start_frame: 300, end_frame: 399, camera_view: "sideline" },
];

function calibrationOut(view: "main" | "sideline", from: number): CalibrationOut {
  return {
    camera_view: view,
    effective_from_frame: from,
    reference_frame: from,
    landmarks: {},
    complete: false,
    image_to_court: null,
    court_to_image: null,
    errors: {},
    worst_error_ft: null,
    needs_attention: false,
  };
}

async function loaded() {
  const hook = renderHook(() => useRecording("match-1"));
  await waitFor(() => expect(hook.result.current[0].recording).not.toBeNull());
  return hook;
}

/** Lets the save queues send what the last edit pushed. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.mocked(getPlaySegments).mockResolvedValue(SEGMENTS);
  vi.mocked(getCalibrations).mockResolvedValue([
    calibrationOut("main", 100),
    calibrationOut("sideline", 300),
  ]);
  vi.mocked(replacePlaySegments).mockImplementation(async (_id, segments) => segments);
  vi.mocked(replaceCalibrations).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useRecording", () => {
  it("loads segments and Calibrations without the server's fit", async () => {
    const { result } = await loaded();

    expect(result.current[0].recording?.segments).toEqual(SEGMENTS);
    expect(result.current[0].recording?.calibrations[0]).toEqual({
      camera_view: "main",
      effective_from_frame: 100,
      reference_frame: 100,
      landmarks: {},
    });
  });

  it("saves only the segments after a segments-only edit", async () => {
    const { result } = await loaded();

    act(() => result.current[1].editSegments((s, p) => markIn(s, p, 500)));
    act(() => result.current[1].editSegments((s, p) => markOut(s, p, 600)));
    await flush();

    expect(replacePlaySegments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replacePlaySegments).mock.calls[0]![1]).toContainEqual({
      start_frame: 500,
      end_frame: 600,
      camera_view: "sideline",
    });
    expect(replaceCalibrations).not.toHaveBeenCalled();
  });

  it("moves and saves only that view's Calibrations when a start moves", async () => {
    const { result } = await loaded();

    act(() => result.current[1].editSegments((s, p) => markIn(s, p, 150)));
    await flush();

    expect(replacePlaySegments).toHaveBeenCalledTimes(1);
    expect(replaceCalibrations).toHaveBeenCalledTimes(1);
    expect(replaceCalibrations).toHaveBeenCalledWith("match-1", "main", [
      { camera_view: "main", effective_from_frame: 150, reference_frame: 100, landmarks: {} },
    ]);
  });

  it("records no step and saves nothing for an edit that changes nothing", async () => {
    const { result } = await loaded();

    act(() => result.current[1].editSegments((s, p) => markIn(s, p, 100)));
    act(() => result.current[1].undo());
    await flush();

    expect(result.current[0].message).toBe("Nothing to undo");
    expect(replacePlaySegments).not.toHaveBeenCalled();
    expect(replaceCalibrations).not.toHaveBeenCalled();
  });

  it("undoes a moved start, its Calibration included, in one step", async () => {
    const { result } = await loaded();
    act(() => result.current[1].editSegments((s, p) => markIn(s, p, 150)));
    await flush();

    act(() => result.current[1].undo());
    await flush();

    expect(result.current[0].recording?.segments).toEqual(SEGMENTS);
    expect(result.current[0].recording?.calibrations[0]?.effective_from_frame).toBe(100);
    expect(vi.mocked(replacePlaySegments).mock.calls.at(-1)![1]).toEqual(SEGMENTS);
    expect(vi.mocked(replaceCalibrations).mock.calls.at(-1)).toEqual([
      "match-1",
      "main",
      [{ camera_view: "main", effective_from_frame: 100, reference_frame: 100, landmarks: {} }],
    ]);
  });

  it("saves a Calibration edit and keeps the fit the server returns", async () => {
    const fitted = {
      ...calibrationOut("main", 100),
      landmarks: { near_kitchen_left: { x: 0.25, y: 0.5 } },
      complete: true,
    };
    vi.mocked(replaceCalibrations).mockResolvedValue([fitted]);
    const { result } = await loaded();

    act(() =>
      result.current[1].editCalibrations((list) =>
        placeLandmark(list, SEGMENTS[0]!, 150, "near_kitchen_left", { x: 0.25, y: 0.5 }),
      ),
    );
    const edited = result.current[0].recording!.calibrations[0]!;
    expect(currentFit(result.current[0].fits, edited)).toBeUndefined();
    await flush();

    expect(replacePlaySegments).not.toHaveBeenCalled();
    expect(replaceCalibrations).toHaveBeenCalledWith("match-1", "main", [edited]);
    expect(currentFit(result.current[0].fits, edited)).toBe(fitted);
  });

  it("undoes and redoes a Calibration edit, saving only its view", async () => {
    const { result } = await loaded();
    const before = result.current[0].recording!.calibrations;
    act(() =>
      result.current[1].editCalibrations((list) =>
        placeLandmark(list, SEGMENTS[0]!, 150, "near_kitchen_left", { x: 0.25, y: 0.5 }),
      ),
    );
    const after = result.current[0].recording!.calibrations;
    await flush();
    vi.mocked(replaceCalibrations).mockClear();

    act(() => result.current[1].undo());
    expect(result.current[0].recording!.calibrations).toEqual(before);
    await flush();
    expect(replaceCalibrations).toHaveBeenCalledTimes(1);
    expect(replaceCalibrations).toHaveBeenCalledWith("match-1", "main", [before[0]]);

    act(() => result.current[1].redo());
    expect(result.current[0].recording!.calibrations).toEqual(after);
  });

  it("records no undo step for a Calibration edit that changes nothing", async () => {
    const { result } = await loaded();
    act(() =>
      result.current[1].editCalibrations((list) =>
        placeLandmark(list, SEGMENTS[0]!, 150, "near_kitchen_left", { x: 0.25, y: 0.5 }),
      ),
    );

    act(() =>
      result.current[1].editCalibrations((list) =>
        clearLandmark(list, "main", 150, "far_kitchen_left"),
      ),
    );
    expect(result.current[0].message).toMatch(/isn't placed/);
    act(() => result.current[1].undo());

    // The undo took back the placement, the edit before the one that changed nothing.
    expect(result.current[0].recording!.calibrations[0]!.landmarks).toEqual({});
  });

  it("treats a fit as stale after an undo until that save comes back", async () => {
    const point = { x: 0.25, y: 0.5 };
    // The save sends as soon as the edit is made, so its fit is set up first.
    vi.mocked(replaceCalibrations)
      .mockResolvedValueOnce([
        { ...calibrationOut("main", 100), landmarks: { near_kitchen_left: point } },
      ])
      .mockResolvedValueOnce([calibrationOut("main", 100)]);
    const { result } = await loaded();
    act(() =>
      result.current[1].editCalibrations((list) =>
        placeLandmark(list, SEGMENTS[0]!, 150, "near_kitchen_left", point),
      ),
    );
    const placed = result.current[0].recording!.calibrations[0]!;
    await flush();
    expect(currentFit(result.current[0].fits, placed)).toBeDefined();

    act(() => result.current[1].undo());
    const restored = result.current[0].recording!.calibrations[0]!;

    expect(currentFit(result.current[0].fits, restored)).toBeUndefined();
    await flush();
    expect(currentFit(result.current[0].fits, restored)).toBeDefined();
  });

  it("keeps the other view's fits when one view is saved", async () => {
    const { result } = await loaded();
    const sidelineKey = fitKey({ camera_view: "sideline", effective_from_frame: 300 });
    expect(result.current[0].fits.has(sidelineKey)).toBe(true);

    act(() =>
      result.current[1].editCalibrations((list) =>
        placeLandmark(list, SEGMENTS[0]!, 150, "near_kitchen_left", { x: 0.25, y: 0.5 }),
      ),
    );
    await flush();

    expect(result.current[0].fits.has(sidelineKey)).toBe(true);
  });

  it("retries loading while the Rally Log is busy", async () => {
    vi.useFakeTimers();
    vi.mocked(getPlaySegments).mockRejectedValueOnce(new ApiError(503, "busy"));

    const { result } = renderHook(() => useRecording("match-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(getPlaySegments).toHaveBeenCalledTimes(2);
    expect(result.current[0].recording?.segments).toEqual(SEGMENTS);
  });

  it("reports a load that can't succeed", async () => {
    vi.mocked(getPlaySegments).mockRejectedValue(new ApiError(404, "Match not found"));

    const { result } = renderHook(() => useRecording("match-1"));

    await waitFor(() => expect(result.current[0].message).toMatch(/Match not found/));
    expect(getPlaySegments).toHaveBeenCalledTimes(1);
    expect(result.current[0].recording).toBeNull();
  });
});
