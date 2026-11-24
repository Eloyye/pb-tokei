import { describe, expect, it } from "vitest";
import type { Calibration, CalibrationOut, CameraView, PlaySegment } from "../api/client";
import {
  calibrationAt,
  calibrationKeyFor,
  clearLandmark,
  currentFit,
  fitKey,
  COURT_LINES,
  courtPoint,
  deleteCalibration,
  LANDMARKS,
  landmarkLabel,
  newCalibration,
  nextLandmark,
  placeLandmark,
  project,
  reuseBlocker,
  reuseCalibration,
  projectLine,
  skipLandmark,
} from "./calibrations";

function cal(
  view: CameraView,
  from: number,
  landmarks: Calibration["landmarks"] = {},
): Calibration {
  return { camera_view: view, effective_from_frame: from, reference_frame: from + 5, landmarks };
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
  it("creates a Calibration from the segment's start on the first click", () => {
    const edit = placeLandmark([], SEGMENT, 1234, "near_kitchen_left", { x: 0.2, y: 0.7 });

    expect(edit.calibrations).toEqual([
      {
        camera_view: "main",
        effective_from_frame: 1000,
        reference_frame: 1234,
        landmarks: { near_kitchen_left: { x: 0.2, y: 0.7 } },
      },
    ]);
  });

  it("edits the Calibration in effect afterwards, keeping its frames", () => {
    const existing = cal("main", 400, { near_kitchen_left: { x: 0.1, y: 0.1 } });
    const other = cal("sideline", 400);

    const edit = placeLandmark([existing, other], SEGMENT, 1234, "near_kitchen_left", {
      x: 0.3,
      y: 1.4,
    });

    expect(edit.calibrations).toEqual([
      { ...existing, landmarks: { near_kitchen_left: { x: 0.3, y: 1 } } },
      other,
    ]);
  });
});

describe("clearLandmark", () => {
  it("removes a placed Landmark from the Calibration in effect", () => {
    const existing = cal("main", 0, { near_kitchen_left: { x: 0.1, y: 0.1 } });

    expect(clearLandmark([existing], "main", 10, "near_kitchen_left").calibrations).toEqual([
      { ...existing, landmarks: {} },
    ]);
  });

  it("changes nothing for an unplaced Landmark", () => {
    const list = [cal("main", 0)];

    expect(clearLandmark(list, "main", 10, "far_kitchen_left").calibrations).toBe(list);
  });
});

describe("newCalibration", () => {
  it("copies the points of the Calibration in effect from the segment's start", () => {
    const earlier = cal("main", 0, { near_kitchen_left: { x: 0.1, y: 0.2 } });

    const edit = newCalibration([earlier], SEGMENT, 1500);

    expect(edit.calibrations[1]).toEqual({
      camera_view: "main",
      effective_from_frame: 1000,
      reference_frame: 1500,
      landmarks: { near_kitchen_left: { x: 0.1, y: 0.2 } },
    });
    expect(edit.calibrations[1]!.landmarks).not.toBe(earlier.landmarks);
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

describe("deleteCalibration", () => {
  it("deletes only that view's Calibration from that frame", () => {
    const list = [cal("main", 0), cal("sideline", 0)];

    expect(deleteCalibration(list, "main", 0).calibrations).toEqual([cal("sideline", 0)]);
  });
});

describe("nextLandmark and skipLandmark", () => {
  it("moves to the next unplaced Landmark, wrapping round", () => {
    const placed = { near_baseline_left: {}, near_baseline_centre: {} };

    expect(nextLandmark(placed, null)).toBe("near_baseline_right");
    expect(nextLandmark({ ...placed, far_baseline_right: {} }, "far_baseline_right")).toBe(
      "near_baseline_right",
    );
    expect(nextLandmark(Object.fromEntries(LANDMARKS.map((l) => [l, {}])), null)).toBeNull();
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
  const placed = cal("main", 0, {
    near_kitchen_left: { x: 0.1, y: 0.2 },
    far_kitchen_left: { x: 0.3, y: 0.4 },
  });
  const fit = {
    camera_view: "main",
    effective_from_frame: 0,
    landmarks: placed.landmarks,
  } as CalibrationOut;
  const fits = new Map([[fitKey(placed), fit]]);

  it("returns the fit of exactly these Landmarks, in any order", () => {
    const reordered = {
      ...placed,
      landmarks: { far_kitchen_left: { x: 0.3, y: 0.4 }, near_kitchen_left: { x: 0.1, y: 0.2 } },
    };

    expect(currentFit(fits, reordered)).toBe(fit);
  });

  it("returns nothing while an edit is unsaved", () => {
    const moved = {
      ...placed,
      landmarks: { ...placed.landmarks, near_kitchen_left: { x: 0.1, y: 0.3 } },
    };

    expect(currentFit(fits, moved)).toBeUndefined();
    expect(currentFit(fits, cal("main", 5))).toBeUndefined();
  });
});

describe("reuseCalibration", () => {
  const original = cal("main", 26, { near_kitchen_left: { x: 0.1, y: 0.2 } });
  const moved = cal("main", 600, { near_kitchen_left: { x: 0.4, y: 0.5 } });
  // The camera is back at the frame-26 angle in this later segment.
  const later: PlaySegment = { start_frame: 900, end_frame: 1100, camera_view: "main" };

  it("puts an earlier Calibration's points in effect from the segment's start", () => {
    const edit = reuseCalibration([original, moved], original, later, 950);

    expect(edit.calibrations).toHaveLength(3);
    expect(edit.edited).toEqual({
      camera_view: "main",
      effective_from_frame: 900,
      reference_frame: 950,
      landmarks: original.landmarks,
    });
    expect(edit.edited!.landmarks).not.toBe(original.landmarks);
    expect(calibrationAt(edit.calibrations, "main", 1000)).toBe(edit.edited);
  });

  it("replaces the points of a Calibration already starting with the segment", () => {
    const here = cal("main", 900, { far_kitchen_left: { x: 0.6, y: 0.3 } });

    const edit = reuseCalibration([original, moved, here], original, later, 950);

    const replaced = { ...here, reference_frame: 950, landmarks: original.landmarks };
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
    const inside = cal("main", 1000, { far_kitchen_left: { x: 0.6, y: 0.3 } });
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
  const original = cal("main", 26, { near_kitchen_left: { x: 0.1, y: 0.2 } });
  const moved = cal("main", 600, { near_kitchen_left: { x: 0.4, y: 0.5 } });
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
