// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  type CalibrationOut,
  getCalibrations,
  getGames,
  getPlayerAnchors,
  getPlaySegments,
  getTeamEnds,
  type PlaySegment,
  replaceCalibrations,
  replaceGames,
  replacePlayerAnchors,
  replacePlaySegments,
  replaceTeamEnds,
} from "../api/client";
import { clearLandmark, currentFit, fitKey, placeLandmark } from "../lib/calibrations";
import { addShot, markRallyStart, NO_SELECTION, swapShotTeammates } from "../lib/annotate";
import { markIn, markOut, splitPlaySegmentAt } from "../lib/segments";
import { ROSTER } from "../lib/testRoster";
import { tabSaveStatus, waitUntilSaved } from "../lib/unsavedChanges";
import { useRecording } from "./useRecording";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importActual) => ({
  ...(await importActual<Client>()),
  getPlaySegments: vi.fn<Client["getPlaySegments"]>(),
  getCalibrations: vi.fn<Client["getCalibrations"]>(),
  getPlayerAnchors: vi.fn<Client["getPlayerAnchors"]>(),
  getTeamEnds: vi.fn<Client["getTeamEnds"]>(),
  getGames: vi.fn<Client["getGames"]>(),
  replaceGames: vi.fn<Client["replaceGames"]>(),
  replacePlaySegments: vi.fn<Client["replacePlaySegments"]>(),
  replaceCalibrations: vi.fn<Client["replaceCalibrations"]>(),
  replacePlayerAnchors: vi.fn<Client["replacePlayerAnchors"]>(),
  replaceTeamEnds: vi.fn<Client["replaceTeamEnds"]>(),
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
    not_visible: [],
    complete: false,
    image_to_court: null,
    court_to_image: null,
    errors: {},
    resolved_landmarks: {},
    unmapped_landmarks: [],
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
  vi.mocked(getPlayerAnchors).mockResolvedValue([]);
  vi.mocked(getTeamEnds).mockResolvedValue([]);
  vi.mocked(getGames).mockResolvedValue([]);
  vi.mocked(replaceGames).mockImplementation(async (_id, games) => games);
  vi.mocked(replacePlaySegments).mockImplementation(async (_id, segments) => segments);
  vi.mocked(replaceCalibrations).mockResolvedValue([]);
  vi.mocked(replacePlayerAnchors).mockImplementation(async (_id, anchors) => anchors);
  vi.mocked(replaceTeamEnds).mockImplementation(async (_id, ends) => ends);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Holds the next Play Segments save in flight; the returned function lets it land. */
function holdNextSegmentsSave(): () => void {
  let land: (() => void) | undefined;
  vi.mocked(replacePlaySegments).mockImplementationOnce(
    (_id, segments) =>
      new Promise((resolve) => {
        land = () => resolve(segments);
      }),
  );
  return () => land?.();
}

/** An Annotate context at frame 100 with nothing selected. */
function ctx(games: Parameters<typeof markRallyStart>[0]["games"]) {
  return { games, selection: NO_SELECTION, roster: ROSTER, frame: 100 };
}

describe("useRecording with a Rally Log switch", () => {
  it("holds a switch until its queued save has landed", async () => {
    const { result } = await loaded();
    const finishSave = holdNextSegmentsSave();
    let switched = false;

    act(() => result.current[1].editSegments((s, p) => markIn(s, p, 500)));
    act(() => result.current[1].editSegments((s, p) => markOut(s, p, 600)));
    const waiting = waitUntilSaved().then(() => {
      switched = true;
    });
    await flush();
    expect(switched).toBe(false);

    await act(async () => finishSave());
    await waiting;
    expect(switched).toBe(true);
  });

  it("keeps the tab unsaved after the editor closes until its last save lands", async () => {
    const { result, unmount } = await loaded();
    const finishSave = holdNextSegmentsSave();

    act(() => result.current[1].editSegments((s, p) => markIn(s, p, 500)));
    act(() => result.current[1].editSegments((s, p) => markOut(s, p, 600)));
    unmount();
    expect(tabSaveStatus().state).toBe("saving");

    finishSave();
    await flush();
    expect(tabSaveStatus().state).toBe("saved");
  });
});

describe("useRecording", () => {
  it("refreshes off-reference Calibration fits after a Play Segment split saves", async () => {
    const fit = calibrationOut("main", 100);
    fit.landmarks.near_baseline_left = { x: 0.2, y: 0.8, frame: 155 };
    fit.resolved_landmarks.near_baseline_left = { x: 0.25, y: 0.8 };
    const nextFit: CalibrationOut = {
      ...fit,
      resolved_landmarks: {},
      unmapped_landmarks: ["near_baseline_left"],
    };
    vi.mocked(getCalibrations).mockResolvedValueOnce([fit]).mockResolvedValueOnce([nextFit]);
    const { result } = await loaded();
    const finishSave = holdNextSegmentsSave();
    expect(result.current[0].fits.get(fitKey(fit))).toBe(fit);

    act(() =>
      result.current[1].editSegments((list, pending) => splitPlaySegmentAt(list, pending, 150)),
    );
    expect(result.current[0].fits.has(fitKey(fit))).toBe(false);
    expect(getCalibrations).toHaveBeenCalledTimes(1);

    await act(async () => finishSave());
    await waitFor(() => expect(result.current[0].fits.get(fitKey(fit))).toBe(nextFit));
    expect(replaceCalibrations).not.toHaveBeenCalled();
  });

  it("loads segments and Calibrations without the server's fit", async () => {
    const { result } = await loaded();

    expect(result.current[0].recording?.segments).toEqual(SEGMENTS);
    expect(result.current[0].recording?.calibrations[0]).toEqual({
      camera_view: "main",
      effective_from_frame: 100,
      reference_frame: 100,
      landmarks: {},
      not_visible: [],
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
      {
        camera_view: "main",
        effective_from_frame: 150,
        reference_frame: 100,
        landmarks: {},
        not_visible: [],
      },
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
      [
        {
          camera_view: "main",
          effective_from_frame: 100,
          reference_frame: 100,
          landmarks: {},
          not_visible: [],
        },
      ],
    ]);
  });

  it("saves a Calibration edit and keeps the fit the server returns", async () => {
    const fitted = {
      ...calibrationOut("main", 100),
      landmarks: { near_kitchen_left: { x: 0.25, y: 0.5, frame: 150 } },
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
        {
          ...calibrationOut("main", 100),
          landmarks: { near_kitchen_left: { ...point, frame: 150 } },
        },
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

  it("autosaves and undoes/redoes Player anchor and team_ends edits", async () => {
    const { result } = await loaded();

    act(() =>
      result.current[1].editPlayers(() => ({
        anchors: [{ frame: 120, player_id: "p1", kind: "identity", image_x: 0.3, image_y: 0.7 }],
        teamEnds: [{ effective_from_frame: 0, near_team_id: "team-a" }],
        message: "Anchored p1",
      })),
    );
    await flush();

    expect(replacePlayerAnchors).toHaveBeenCalledWith("match-1", [
      { frame: 120, player_id: "p1", kind: "identity", image_x: 0.3, image_y: 0.7 },
    ]);
    expect(replaceTeamEnds).toHaveBeenCalledWith("match-1", [
      { effective_from_frame: 0, near_team_id: "team-a" },
    ]);

    act(() => result.current[1].undo());
    await flush();
    expect(result.current[0].recording?.anchors).toEqual([]);
    expect(result.current[0].recording?.teamEnds).toEqual([]);
    expect(vi.mocked(replacePlayerAnchors).mock.calls.at(-1)).toEqual(["match-1", []]);
    expect(vi.mocked(replaceTeamEnds).mock.calls.at(-1)).toEqual(["match-1", []]);

    act(() => result.current[1].redo());
    await flush();
    expect(result.current[0].recording?.anchors).toHaveLength(1);
    expect(result.current[0].recording?.teamEnds).toHaveLength(1);
  });

  it("autosaves Rally Log edits and undoes them with the rest of the Recording", async () => {
    const { result } = await loaded();

    let started: ReturnType<typeof markRallyStart> | null = null;
    act(() => {
      started = result.current[1].editGames((games) => markRallyStart(ctx(games)));
    });
    await flush();
    expect(result.current[0].recording?.games).toHaveLength(1);
    expect(vi.mocked(replaceGames).mock.calls.at(-1)?.[1]).toHaveLength(1);
    expect(replacePlaySegments).not.toHaveBeenCalled();

    act(() => result.current[1].editSegments((s, p) => markIn(s, p, 500)));
    act(() => result.current[1].editSegments((s, p) => markOut(s, p, 600)));
    act(() => result.current[1].undo());
    act(() => result.current[1].undo());
    await flush();
    expect(result.current[0].recording?.games).toEqual([]);
    expect(vi.mocked(replaceGames).mock.calls.at(-1)).toEqual(["match-1", []]);

    act(() => result.current[1].redo());
    await flush();
    expect(result.current[0].recording?.games).toEqual(started!.games);
  });

  it("records a Swap on the anchors and the selected Shot as one undo step", async () => {
    const { result } = await loaded();
    let selection = NO_SELECTION;
    act(() => {
      const started = result.current[1].editGames((games) =>
        markRallyStart({ games, selection, roster: ROSTER, frame: 100 }),
      );
      selection = started!.selection;
    });
    act(() => {
      const added = result.current[1].editGames((games) =>
        addShot({ games, selection, roster: ROSTER, frame: 120 }, null),
      );
      selection = added!.selection;
    });
    const before = result.current[0].recording!;
    act(() =>
      result.current[1].editRecording((recording) => ({
        recording: {
          ...recording,
          anchors: [{ frame: 120, player_id: "a1", kind: "position", image_x: 0.5, image_y: 0.5 }],
          games: swapShotTeammates(
            { games: recording.games, selection, roster: ROSTER, frame: 120 },
            "A",
          ).games,
        },
        message: "Swapped",
      })),
    );
    expect(result.current[0].recording!.anchors).toHaveLength(1);
    act(() => result.current[1].undo());
    expect(result.current[0].recording).toEqual(before);
  });
});
