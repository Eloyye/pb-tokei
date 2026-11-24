import { describe, expect, it } from "vitest";
import type { Calibration, CalibrationOut, CameraView, PlaySegment } from "../api/client";
import {
  calibrationAt,
  calibrationKeyFor,
  clearLandmark,
  confirmAllLandmarks,
  confirmLandmark,
  COURT_LINES,
  courtPoint,
  currentFit,
  deleteCalibration,
  fitKey,
  isCarriedOver,
  landmarkCounts,
  LANDMARKS,
  landmarkLabel,
  markNotVisible,
  newCalibration,
  nextLandmark,
  placeLandmark,
  project,
  projectLine,
  reanchorCalibration,
  reuseBlocker,
  reuseCalibration,
  skipLandmark,
  unmappedRangeAt,
} from "./calibrations";

function cal(
  view: CameraView,
  from: number,
  landmarks: Calibration["landmarks"] = {},
  not_visible: Calibration["not_visible"] = [],
): Calibration {
  return {
    camera_view: view,
    effective_from_frame: from,
    reference_frame: from + 5,
    landmarks,
    not_visible,
  };
}

const SEGMENT: PlaySegment = { start_frame: 1000, end_frame: 1999, camera_view: "main" };
const IDENTITY = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

describe("Landmarks", () => {
  it("sit on the court as the server has them", () => {
    expect(courtPoint("near_baseline_left")).toEqual({ x: -10, y: -22 });
    expect(courtPoint("far_kitchen_centre")).toEqual({ x: 0, y: 7 });
    expect(new Set(LANDMARKS.map((l) => JSON.stringify(courtPoint(l)))).size).toBe(12);
  });

  it("are named from the Main View camera", () => {
    expect(landmarkLabel("near_kitchen_right")).toBe("Near kitchen line, right");
    expect(landmarkLabel("far_baseline_centre")).toBe("Far baseline, centreline");
  });
});

describe("calibrationAt", () => {
  const list = [cal("main", 5000), cal("sideline", 0), cal("main", 100)];

  it("is the latest of the view started at or before the frame, else the earliest", () => {
    expect(calibrationAt(list, "main", 4999)?.effective_from_frame).toBe(100);
    expect(calibrationAt(list, "main", 5000)?.effective_from_frame).toBe(5000);
    expect(calibrationAt(list, "main", 50)?.effective_from_frame).toBe(100);
    expect(calibrationAt([], "main", 50)).toBeUndefined();
  });
});

describe("placeLandmark", () => {
  it("creates a Calibration from the segment's start on the first click, recording the frame", () => {
    const edit = placeLandmark([], SEGMENT, 1234, "near_kitchen_left", { x: 0.2, y: 0.7 });

    expect(edit.calibrations).toEqual([
      {
        camera_view: "main",
        effective_from_frame: 1000,
        reference_frame: 1234,
        landmarks: { near_kitchen_left: { x: 0.2, y: 0.7, frame: 1234 } },
        not_visible: [],
      },
    ]);
  });

  it("places a Landmark on the reference frame without mentioning mapping", () => {
    const existing = cal("main", 1000, { near_kitchen_left: { x: 0.1, y: 0.1, frame: 1005 } });

    const edit = placeLandmark([existing], SEGMENT, 1005, "near_kitchen_right", { x: 0.8, y: 0.6 });

    expect(edit.calibrations[0]?.landmarks.near_kitchen_right).toEqual({
      x: 0.8,
      y: 0.6,
      frame: 1005,
    });
    expect(edit.message).toBe("Near kitchen line, right placed");
  });

  it("records the click frame when placing off the reference frame, keeping reference_frame", () => {
    const existing = cal("main", 400, { near_kitchen_left: { x: 0.1, y: 0.1, frame: 405 } });
    const other = cal("sideline", 400);

    const edit = placeLandmark([existing, other], SEGMENT, 1234, "near_kitchen_left", {
      x: 0.3,
      y: 1.4,
    });

    expect(edit.calibrations).toEqual([
      { ...existing, landmarks: { near_kitchen_left: { x: 0.3, y: 1, frame: 1234 } } },
      other,
    ]);
    expect(edit.message).toMatch(/frame 1234.*ref frame 405/);
  });

  it("clears a not-visible mark when the Landmark is placed", () => {
    const existing = cal("main", 1000, {}, ["near_kitchen_left"]);

    const edit = placeLandmark([existing], SEGMENT, 1005, "near_kitchen_left", { x: 0.2, y: 0.6 });

    expect(edit.edited?.not_visible).toEqual([]);
    expect(edit.edited?.landmarks.near_kitchen_left).toEqual({ x: 0.2, y: 0.6, frame: 1005 });
  });
});

describe("markNotVisible and clearLandmark", () => {
  it("marks a Landmark not visible and removes any placed point", () => {
    const existing = cal("main", 1000, { near_kitchen_left: { x: 0.1, y: 0.2, frame: 1005 } });

    const edit = markNotVisible([existing], SEGMENT, 1005, "near_kitchen_left");

    expect(edit.edited?.landmarks).toEqual({});
    expect(edit.edited?.not_visible).toEqual(["near_kitchen_left"]);
    // Marking the same Landmark again is a no-op.
    expect(markNotVisible(edit.calibrations, SEGMENT, 1005, "near_kitchen_left").calibrations).toBe(
      edit.calibrations,
    );
  });

  it("creates a Calibration if marking not visible before any clicks", () => {
    const edit = markNotVisible([], SEGMENT, 1100, "near_baseline_left");

    expect(edit.edited).toEqual({
      camera_view: "main",
      effective_from_frame: 1000,
      reference_frame: 1100,
      landmarks: {},
      not_visible: ["near_baseline_left"],
    });
  });

  it("clears a placed Landmark or a not-visible Landmark back to remaining", () => {
    const existing = cal("main", 0, { near_kitchen_left: { x: 0.1, y: 0.1, frame: 5 } }, [
      "far_kitchen_left",
    ]);

    const clearedPlaced = clearLandmark([existing], "main", 10, "near_kitchen_left");
    expect(clearedPlaced.calibrations[0]?.landmarks).toEqual({});
    expect(clearedPlaced.calibrations[0]?.not_visible).toEqual(["far_kitchen_left"]);

    const clearedNotVisible = clearLandmark(
      clearedPlaced.calibrations,
      "main",
      10,
      "far_kitchen_left",
    );
    expect(clearedNotVisible.calibrations[0]?.not_visible).toEqual([]);
  });

  it("changes nothing for a remaining Landmark", () => {
    const list = [cal("main", 0)];

    expect(clearLandmark(list, "main", 10, "far_kitchen_left").calibrations).toBe(list);
  });
});

describe("newCalibration", () => {
  it("carries over Landmarks with their original frames and not_visible marks", () => {
    const earlier = cal("main", 0, { near_kitchen_left: { x: 0.1, y: 0.2, frame: 5 } }, [
      "near_baseline_left",
    ]);

    const edit = newCalibration([earlier], SEGMENT, 1500);

    expect(edit.calibrations[1]).toEqual({
      camera_view: "main",
      effective_from_frame: 1000,
      reference_frame: 1500,
      landmarks: { near_kitchen_left: { x: 0.1, y: 0.2, frame: 5 } },
      not_visible: ["near_baseline_left"],
    });
    expect(edit.calibrations[1]!.landmarks).not.toBe(earlier.landmarks);
    expect(edit.calibrations[1]!.landmarks.near_kitchen_left).not.toBe(
      earlier.landmarks.near_kitchen_left,
    );
    expect(isCarriedOver(5, 1500, SEGMENT)).toBe(true);
    expect(isCarriedOver(1200, 1500, SEGMENT)).toBe(false);
    expect(landmarkCounts(edit.calibrations[1])).toEqual({
      placed: 1,
      notVisible: 1,
      remaining: 10,
      confirmedOnRef: 0,
      otherFrame: 1,
    });
  });

  it("does nothing when one already starts with the segment", () => {
    const list = [cal("main", 1000)];

    const edit = newCalibration(list, SEGMENT, 1500);

    expect(edit.calibrations).toBe(list);
    expect(edit.message).toMatch(/already starts/);
  });

  it("isn't blocked by the other view's Calibration at that frame", () => {
    expect(newCalibration([cal("sideline", 1000)], SEGMENT, 1500).calibrations).toHaveLength(2);
  });
});

describe("confirmLandmark and confirmAllLandmarks", () => {
  it("confirms a carried-over Landmark on the current frame, adopting resolved coords if given", () => {
    const carried = cal("main", 1000, {
      near_kitchen_left: { x: 0.1, y: 0.2, frame: 50 },
      near_kitchen_right: { x: 0.8, y: 0.2, frame: 1005 },
    });

    const one = confirmLandmark([carried], "main", 1005, "near_kitchen_left", { x: 0.12, y: 0.21 });
    expect(one.edited?.landmarks.near_kitchen_left).toEqual({ x: 0.12, y: 0.21, frame: 1005 });

    // Confirming an already-confirmed Landmark is a no-op.
    expect(confirmLandmark(one.calibrations, "main", 1005, "near_kitchen_left").calibrations).toBe(
      one.calibrations,
    );
  });

  it("confirms all off-frame Landmarks onto the current frame at once", () => {
    const carried = cal("main", 1000, {
      near_kitchen_left: { x: 0.1, y: 0.2, frame: 50 },
      far_kitchen_left: { x: 0.3, y: 0.4, frame: 50 },
    });

    const edit = confirmAllLandmarks([carried], "main", 1005, {
      near_kitchen_left: { x: 0.11, y: 0.22 },
      // Out-of-frame resolved point falls back to the stored coordinates.
      far_kitchen_left: { x: -0.2, y: 0.4 },
    });

    expect(edit.edited?.landmarks).toEqual({
      near_kitchen_left: { x: 0.11, y: 0.22, frame: 1005 },
      far_kitchen_left: { x: 0.3, y: 0.4, frame: 1005 },
    });
    expect(landmarkCounts(edit.edited)).toEqual({
      placed: 2,
      notVisible: 0,
      remaining: 10,
      confirmedOnRef: 2,
      otherFrame: 0,
    });
    expect(confirmAllLandmarks(edit.calibrations, "main", 1005).calibrations).toBe(
      edit.calibrations,
    );
  });
});

describe("deleteCalibration", () => {
  it("deletes only that view's Calibration from that frame", () => {
    const list = [cal("main", 0), cal("sideline", 0)];

    expect(deleteCalibration(list, "main", 0).calibrations).toEqual([cal("sideline", 0)]);
  });
});

describe("nextLandmark and skipLandmark", () => {
  it("moves to the next remaining Landmark (skipping placed and not visible), wrapping round", () => {
    const placed = { near_baseline_left: {}, near_baseline_centre: {} };

    expect(nextLandmark(placed, null)).toBe("near_baseline_right");
    expect(nextLandmark(placed, null, ["near_baseline_right"])).toBe("near_kitchen_left");
    expect(nextLandmark({ ...placed, far_baseline_right: {} }, "far_baseline_right")).toBe(
      "near_baseline_right",
    );
    expect(nextLandmark(Object.fromEntries(LANDMARKS.map((l) => [l, {}])), null)).toBeNull();
    expect(nextLandmark({}, null, LANDMARKS)).toBeNull();
  });

  it("skips to the next Landmark, placed or not", () => {
    expect(skipLandmark(null)).toBe("near_baseline_left");
    expect(skipLandmark("near_baseline_left")).toBe("near_baseline_centre");
    expect(skipLandmark("far_baseline_right")).toBe("near_baseline_left");
  });
});

describe("project", () => {
  it("applies the homography and rejects points behind the camera", () => {
    const scaled = [
      [2, 0, 1],
      [0, 2, 1],
      [0, 0, 2],
    ];

    expect(project(scaled, { x: 1, y: 3 })).toEqual({ x: 1.5, y: 3.5 });
    expect(project([...IDENTITY.slice(0, 2), [0, -1, 1]], { x: 0, y: 2 })).toBeNull();
  });

  it("splits a line where it passes behind the camera", () => {
    // w = 1 - y / 10: positive for y below 10, behind the camera beyond.
    const matrix = [...IDENTITY.slice(0, 2), [0, -0.1, 1]];

    const runs = projectLine(matrix, { from: { x: 0, y: 0 }, to: { x: 0, y: 20 }, dashed: false });

    expect(runs).toHaveLength(1);
    expect(runs[0]!.at(-1)!.y).toBeGreaterThan(0);
    expect(runs[0]!.length).toBeLessThan(25);
  });

  it("draws the court lines and the dashed Zone boundaries", () => {
    expect(COURT_LINES.filter((l) => l.dashed).map((l) => l.from.y)).toEqual([
      -18, -12, -9, 9, 12, 18,
    ]);
  });
});

describe("calibrationKeyFor", () => {
  it("names the Calibration the first click creates", () => {
    const edit = placeLandmark([], SEGMENT, 1234, "near_kitchen_left", { x: 0.2, y: 0.7 });

    expect(calibrationKeyFor(SEGMENT, undefined)).toBe(fitKey(edit.edited!));
  });

  it("names the Calibration in effect when there is one", () => {
    const existing = cal("main", 400);

    expect(calibrationKeyFor(SEGMENT, existing)).toBe("main:400");
  });
});

describe("currentFit", () => {
  const placed = cal(
    "main",
    0,
    {
      near_kitchen_left: { x: 0.1, y: 0.2, frame: 5 },
      far_kitchen_left: { x: 0.3, y: 0.4, frame: 8 },
    },
    ["near_baseline_left"],
  );
  const fit = {
    camera_view: "main",
    effective_from_frame: 0,
    reference_frame: 5,
    landmarks: placed.landmarks,
    not_visible: placed.not_visible,
  } as CalibrationOut;
  const fits = new Map([[fitKey(placed), fit]]);

  it("returns the fit of exactly these Landmarks, in any order", () => {
    const reordered = {
      ...placed,
      landmarks: {
        far_kitchen_left: { x: 0.3, y: 0.4, frame: 8 },
        near_kitchen_left: { x: 0.1, y: 0.2, frame: 5 },
      },
    };

    expect(currentFit(fits, reordered)).toBe(fit);
  });

  it("returns nothing while an edit (coords, frame, or not_visible) is unsaved", () => {
    const moved = {
      ...placed,
      landmarks: { ...placed.landmarks, near_kitchen_left: { x: 0.1, y: 0.3, frame: 5 } },
    };
    const reframed = {
      ...placed,
      landmarks: { ...placed.landmarks, far_kitchen_left: { x: 0.3, y: 0.4, frame: 5 } },
    };
    const differentNotVisible = { ...placed, not_visible: [] };

    expect(currentFit(fits, moved)).toBeUndefined();
    expect(currentFit(fits, reframed)).toBeUndefined();
    expect(currentFit(fits, differentNotVisible)).toBeUndefined();
    expect(currentFit(fits, cal("main", 5))).toBeUndefined();
  });
});

describe("reuseCalibration", () => {
  const original = cal("main", 26, { near_kitchen_left: { x: 0.1, y: 0.2, frame: 31 } }, [
    "near_baseline_left",
  ]);
  const moved = cal("main", 600, { near_kitchen_left: { x: 0.4, y: 0.5, frame: 605 } });
  // The camera is back at the frame-26 angle in this later segment.
  const later: PlaySegment = { start_frame: 900, end_frame: 1100, camera_view: "main" };

  it("carries over an earlier Calibration's points (with their original frames) from the segment's start", () => {
    const edit = reuseCalibration([original, moved], original, later, 950);

    expect(edit.calibrations).toHaveLength(3);
    expect(edit.edited).toEqual({
      camera_view: "main",
      effective_from_frame: 900,
      reference_frame: 950,
      landmarks: original.landmarks,
      not_visible: original.not_visible,
    });
    expect(edit.edited!.landmarks).not.toBe(original.landmarks);
    expect(edit.edited!.landmarks.near_kitchen_left?.frame).toBe(31);
    expect(calibrationAt(edit.calibrations, "main", 1000)).toBe(edit.edited);
  });

  it("replaces the points of a Calibration already starting with the segment", () => {
    const here = cal("main", 900, { far_kitchen_left: { x: 0.6, y: 0.3, frame: 905 } });

    const edit = reuseCalibration([original, moved, here], original, later, 950);

    const replaced = {
      ...here,
      reference_frame: 950,
      landmarks: original.landmarks,
      not_visible: original.not_visible,
    };
    expect(edit.calibrations).toEqual([original, moved, replaced]);
    expect(edit.edited).toBe(edit.calibrations[2]);
    expect(edit.edited!.landmarks).not.toBe(original.landmarks);
  });

  it("does nothing the second time, once the segment uses those points", () => {
    const once = reuseCalibration([original, moved], original, later, 950);

    const twice = reuseCalibration(once.calibrations, original, later, 960);

    expect(twice.calibrations).toBe(once.calibrations);
    expect(twice.message).toMatch(/already uses these points/);
  });

  it("does nothing when that Calibration is already in effect", () => {
    const list = [original];

    expect(reuseCalibration(list, original, later, 950).calibrations).toBe(list);
  });

  it("refuses when another Calibration starts inside the segment", () => {
    const inside = cal("main", 1000, { far_kitchen_left: { x: 0.6, y: 0.3, frame: 1005 } });
    const list = [original, moved, inside];

    const edit = reuseCalibration(list, original, later, 950);

    expect(edit.calibrations).toBe(list);
    expect(edit.message).toMatch(/starts inside this Play Segment, at frame 1000/);
  });

  it("refuses another view's Calibration", () => {
    const list = [original, cal("sideline", 0)];

    const edit = reuseCalibration(list, list[1]!, later, 950);

    expect(edit.calibrations).toBe(list);
    expect(edit.message).toMatch(/Sideline View Calibration/);
  });
});

describe("reuseBlocker", () => {
  const original = cal("main", 26, { near_kitchen_left: { x: 0.1, y: 0.2, frame: 31 } });
  const moved = cal("main", 600, { near_kitchen_left: { x: 0.4, y: 0.5, frame: 605 } });
  const later: PlaySegment = { start_frame: 900, end_frame: 1100, camera_view: "main" };

  it("allows an earlier angle on a segment using different points", () => {
    expect(reuseBlocker([original, moved], original, later)).toBeNull();
  });

  it("blocks the Calibration in effect, or any with the same points", () => {
    expect(reuseBlocker([original, moved], moved, later)).not.toBeNull();
    const copy = cal("main", 700, { ...original.landmarks });
    expect(reuseBlocker([original, copy], original, later)).not.toBeNull();
  });

  it("ignores a Calibration starting after the segment", () => {
    expect(reuseBlocker([original, moved, cal("main", 1101)], original, later)).toBeNull();
  });
});

describe("reanchorCalibration", () => {
  it("starts a fresh empty Calibration at the playhead inside a Play Segment", () => {
    const existing = cal("main", 1000, { near_kitchen_left: { x: 0.2, y: 0.5, frame: 1005 } });

    const edit = reanchorCalibration([existing], SEGMENT, 1450);

    expect(edit.calibrations).toHaveLength(2);
    expect(edit.edited).toEqual({
      camera_view: "main",
      effective_from_frame: 1450,
      reference_frame: 1450,
      landmarks: {},
      not_visible: [],
    });
    expect(calibrationAt(edit.calibrations, "main", 1450)).toBe(edit.edited);
  });

  it("refuses when a Calibration of the same view already starts at that frame", () => {
    const existing = cal("main", 1450);

    const edit = reanchorCalibration([existing], SEGMENT, 1450);

    expect(edit.calibrations).toEqual([existing]);
    expect(edit.message).toMatch(/already starts at frame 1450/);
  });
});

describe("unmappedRangeAt", () => {
  const ranges = [
    { start_frame: 200, end_frame: 250, camera_view: "sideline" as const },
    { start_frame: 400, end_frame: 400, camera_view: "main" as const },
  ];

  it("finds the inclusive range containing the frame", () => {
    expect(unmappedRangeAt(ranges, 200)).toBe(ranges[0]);
    expect(unmappedRangeAt(ranges, 250)).toBe(ranges[0]);
    expect(unmappedRangeAt(ranges, 400)).toBe(ranges[1]);
    expect(unmappedRangeAt(ranges, 199)).toBeUndefined();
    expect(unmappedRangeAt(ranges, 251)).toBeUndefined();
  });
});
