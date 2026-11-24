import type {
  Calibration,
  CalibrationOut,
  CameraView,
  Landmark,
  PlaySegment,
  UnmappedRangeOut,
} from "../api/client";
import { VIEW_LABELS } from "./segments";

/**
 * Calibration editing (#10). Pure functions over a Match's Calibrations, like `lib/segments`;
 * the fit itself is computed by the server, and only applied here.
 *
 * A Calibration is in effect from its `effective_from_frame`: at a frame, the one in effect is
 * the latest of that frame's Camera View starting at or before it, or else the view's earliest
 * (`pb_tokei.calibration.calibration_at`).
 */

/** In clicking order: the near baseline first, as it is nearest the Main View camera. */
export const LANDMARKS: Landmark[] = [
  "near_baseline_left",
  "near_baseline_centre",
  "near_baseline_right",
  "near_kitchen_left",
  "near_kitchen_centre",
  "near_kitchen_right",
  "far_kitchen_left",
  "far_kitchen_centre",
  "far_kitchen_right",
  "far_baseline_left",
  "far_baseline_centre",
  "far_baseline_right",
];

export interface Point {
  x: number;
  y: number;
}

/** Where a Landmark is on the court, in feet (`pb_tokei.rally_log.Landmark.court_point`). */
export function courtPoint(landmark: Landmark): Point {
  const [end, courtLine, side] = landmark.split("_") as [string, string, string];
  const y = (courtLine === "baseline" ? 22 : 7) * (end === "near" ? -1 : 1);
  const x = side === "left" ? -10 : side === "right" ? 10 : 0;
  return { x, y };
}

/** "Near kitchen line, left" and the like; left and right as seen from the Main View camera. */
export function landmarkLabel(landmark: Landmark): string {
  const [end, courtLine, side] = landmark.split("_") as [string, string, string];
  const where = `${end === "near" ? "Near" : "Far"} ${courtLine === "baseline" ? "baseline" : "kitchen line"}`;
  return `${where}, ${side === "centre" ? "centreline" : side}`;
}

export function calibrationAt(
  calibrations: Calibration[],
  view: CameraView,
  frame: number,
): Calibration | undefined {
  const ofView = calibrations
    .filter((c) => c.camera_view === view)
    .toSorted((a, b) => a.effective_from_frame - b.effective_from_frame);
  return ofView.findLast((c) => c.effective_from_frame <= frame) ?? ofView[0];
}

export interface CalibrationEdit {
  calibrations: Calibration[];
  message: string;
  /** The Calibration the edit changed or created, if any. */
  edited?: Calibration;
}

/** Identifies a Calibration: its view and the frame it is in effect from. */
export function fitKey(calibration: Pick<Calibration, "camera_view" | "effective_from_frame">) {
  return `${calibration.camera_view}:${calibration.effective_from_frame}`;
}

/**
 * The key of the Calibration that clicks on a segment edit: the one in effect, or else the one
 * the first click will create, which starts with the segment (as `placeLandmark` creates it).
 */
export function calibrationKeyFor(segment: PlaySegment, calibration: Calibration | undefined) {
  return fitKey(calibration ?? startingWith(segment, 0));
}

/**
 * A Calibration's fit, only if the server has fitted exactly its current Landmarks; undefined
 * while an edit to it is still being saved.
 */
export function currentFit(
  fits: Map<string, CalibrationOut>,
  calibration: Calibration,
): CalibrationOut | undefined {
  const fit = fits.get(fitKey(calibration));
  return fit && sameLandmarks(fit.landmarks, calibration.landmarks) ? fit : undefined;
}

function sameLandmarks(a: Calibration["landmarks"], b: Calibration["landmarks"]): boolean {
  const keys = Object.keys(a) as (keyof typeof a)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k]?.x === b[k]?.x && a[k]?.y === b[k]?.y);
}

/** A new, empty Calibration of a segment's view, in effect from the segment's start. */
function startingWith(segment: PlaySegment, frame: number): Calibration {
  return {
    camera_view: segment.camera_view,
    effective_from_frame: segment.start_frame,
    reference_frame: frame,
    landmarks: {},
  };
}

/**
 * Places a Landmark in the Calibration in effect on the segment. If its view has none yet, the
 * click creates one, in effect from the segment's start.
 */
export function placeLandmark(
  calibrations: Calibration[],
  segment: PlaySegment,
  frame: number,
  landmark: Landmark,
  point: Point,
): CalibrationEdit {
  const at = { x: clamp01(point.x), y: clamp01(point.y) };
  const active = calibrationAt(calibrations, segment.camera_view, frame);
  if (!active) {
    const created: Calibration = { ...startingWith(segment, frame), landmarks: { [landmark]: at } };
    return {
      calibrations: [...calibrations, created],
      edited: created,
      message: `New ${VIEW_LABELS[segment.camera_view]} Calibration from frame ${segment.start_frame}: ${landmarkLabel(landmark)} placed`,
    };
  }
  const edited = { ...active, landmarks: { ...active.landmarks, [landmark]: at } };
  return {
    calibrations: replace(calibrations, active, edited),
    edited,
    message: `${landmarkLabel(landmark)} placed`,
  };
}

/** `X`: clears a Landmark from the Calibration in effect. */
export function clearLandmark(
  calibrations: Calibration[],
  view: CameraView,
  frame: number,
  landmark: Landmark,
): CalibrationEdit {
  const active = calibrationAt(calibrations, view, frame);
  if (!active?.landmarks[landmark]) {
    return { calibrations, message: `${landmarkLabel(landmark)} isn't placed` };
  }
  const { [landmark]: _cleared, ...landmarks } = active.landmarks;
  return {
    calibrations: replace(calibrations, active, { ...active, landmarks }),
    message: `${landmarkLabel(landmark)} cleared`,
  };
}

/**
 * `N`: starts a new Calibration in effect from the segment's start, with a copy of the points of
 * the one in effect, so only the Landmarks that drifted need moving.
 */
export function newCalibration(
  calibrations: Calibration[],
  segment: PlaySegment,
  frame: number,
): CalibrationEdit {
  const view = segment.camera_view;
  if (calibrationStartingWith(calibrations, segment)) {
    return {
      calibrations,
      message: `A ${VIEW_LABELS[view]} Calibration already starts with this Play Segment`,
    };
  }
  const active = calibrationAt(calibrations, view, frame);
  const created: Calibration = {
    ...startingWith(segment, frame),
    landmarks: { ...active?.landmarks },
  };
  return {
    calibrations: [...calibrations, created],
    message: `New ${VIEW_LABELS[view]} Calibration from frame ${segment.start_frame}${active ? ", copied from the one before: move the Landmarks that drifted" : ""}`,
  };
}

/**
 * Starts a fresh Calibration inside a Play Segment at `frame`, used to re-anchor Camera Motion
 * after tracking fails (ADR 0006). Starts with no Landmarks so the operator clicks the new angle.
 */
export function reanchorCalibration(
  calibrations: Calibration[],
  segment: PlaySegment,
  frame: number,
): CalibrationEdit {
  const view = segment.camera_view;
  if (calibrations.some((c) => c.camera_view === view && c.effective_from_frame === frame)) {
    return {
      calibrations,
      message: `A ${VIEW_LABELS[view]} Calibration already starts at frame ${frame}`,
    };
  }
  const created: Calibration = {
    camera_view: view,
    effective_from_frame: frame,
    reference_frame: frame,
    landmarks: {},
  };
  return {
    calibrations: [...calibrations, created],
    edited: created,
    message: `New ${VIEW_LABELS[view]} Calibration from frame ${frame}: click Landmarks to re-anchor`,
  };
}

/** The unmapped Camera Motion range containing `frame`, if any. */
export function unmappedRangeAt(
  ranges: readonly UnmappedRangeOut[],
  frame: number,
): UnmappedRangeOut | undefined {
  return ranges.find((r) => frame >= r.start_frame && frame <= r.end_frame);
}

/** The Calibration of a segment's view that starts with the segment, if there is one. */
export function calibrationStartingWith(
  calibrations: Calibration[],
  segment: PlaySegment,
): Calibration | undefined {
  return calibrations.find(
    (c) => c.camera_view === segment.camera_view && c.effective_from_frame === segment.start_frame,
  );
}

/**
 * Why "Use here" can't put `source`'s points in effect on the segment, or null if it can. It
 * can't for another view's Calibration, when the segment already starts with those points, or
 * when another Calibration starts inside the segment (it would take over part way through).
 */
export function reuseBlocker(
  calibrations: Calibration[],
  source: Calibration,
  segment: PlaySegment,
): string | null {
  const view = segment.camera_view;
  if (source.camera_view !== view) {
    return `That's a ${VIEW_LABELS[source.camera_view]} Calibration; this Play Segment is ${VIEW_LABELS[view]}`;
  }
  const inside = calibrations.find(
    (c) =>
      c.camera_view === view &&
      c.effective_from_frame > segment.start_frame &&
      c.effective_from_frame <= segment.end_frame,
  );
  if (inside) {
    return `A ${VIEW_LABELS[view]} Calibration starts inside this Play Segment, at frame ${inside.effective_from_frame}: delete it first`;
  }
  const atStart = calibrationAt(calibrations, view, segment.start_frame);
  if (atStart && sameLandmarks(atStart.landmarks, source.landmarks)) {
    return "This Play Segment already uses these points";
  }
  return null;
}

/**
 * "Use here": puts an earlier Calibration's points in effect from the segment's start, for a
 * camera that has gone back to an angle it had before. If a Calibration of the view already
 * starts with the segment, its points are replaced; otherwise a new one is made. Either way its
 * reference frame becomes `frame`, where the operator saw the angle match.
 */
export function reuseCalibration(
  calibrations: Calibration[],
  source: Calibration,
  segment: PlaySegment,
  frame: number,
): CalibrationEdit {
  const blocker = reuseBlocker(calibrations, source, segment);
  if (blocker) return { calibrations, message: blocker };
  const from = `the Calibration from frame ${source.effective_from_frame}`;
  const landmarks = { ...source.landmarks };
  const existing = calibrationStartingWith(calibrations, segment);
  if (existing) {
    const edited = { ...existing, reference_frame: frame, landmarks };
    return {
      calibrations: replace(calibrations, existing, edited),
      edited,
      message: `This Play Segment's Calibration now uses the points of ${from}`,
    };
  }
  const created: Calibration = { ...startingWith(segment, frame), landmarks };
  return {
    calibrations: [...calibrations, created],
    edited: created,
    message: `New ${VIEW_LABELS[segment.camera_view]} Calibration from frame ${segment.start_frame}, using the points of ${from}`,
  };
}

export function deleteCalibration(
  calibrations: Calibration[],
  view: CameraView,
  effectiveFrom: number,
): CalibrationEdit {
  return {
    calibrations: calibrations.filter(
      (c) => !(c.camera_view === view && c.effective_from_frame === effectiveFrom),
    ),
    message: `${VIEW_LABELS[view]} Calibration from frame ${effectiveFrom} deleted`,
  };
}

/**
 * The Landmark to place after `current`: the next unplaced one in clicking order, wrapping
 * round, or null once all are placed.
 */
export function nextLandmark(
  placed: Partial<Record<Landmark, unknown>>,
  current: Landmark | null,
): Landmark | null {
  const start = current ? LANDMARKS.indexOf(current) + 1 : 0;
  for (let i = 0; i < LANDMARKS.length; i++) {
    const landmark = LANDMARKS[(start + i) % LANDMARKS.length]!;
    if (!placed[landmark]) return landmark;
  }
  return null;
}

/** `Tab`: the Landmark after `current` in clicking order, placed or not, wrapping round. */
export function skipLandmark(current: Landmark | null): Landmark {
  const index = current ? LANDMARKS.indexOf(current) : -1;
  return LANDMARKS[(index + 1) % LANDMARKS.length]!;
}

/**
 * A court point through a 3×3 homography into normalised image coordinates, or null if it is
 * behind the camera (`w` not positive, as the server orients its matrices).
 */
export function project(matrix: number[][], point: Point): Point | null {
  const [a, b, c] = matrix as [number[], number[], number[]];
  const w = c[0]! * point.x + c[1]! * point.y + c[2]!;
  if (!(w > 0)) return null;
  return {
    x: (a[0]! * point.x + a[1]! * point.y + a[2]!) / w,
    y: (b[0]! * point.x + b[1]! * point.y + b[2]!) / w,
  };
}

/** A court line, and whether it is drawn dashed (the Zone boundaries at 9, 12 and 18 ft). */
export interface CourtLine {
  from: Point;
  to: Point;
  dashed: boolean;
}

/** The court's lines in feet, plus dashed Zone boundaries, for drawing the fitted template. */
export const COURT_LINES: CourtLine[] = [
  ...[-22, -7, 7, 22].map((y) => line(-10, y, 10, y)),
  line(-10, -22, -10, 22),
  line(10, -22, 10, 22),
  line(0, -22, 0, -7),
  line(0, 7, 0, 22),
  line(-10, 0, 10, 0),
  ...[-18, -12, -9, 9, 12, 18].map((y) => ({ ...line(-10, y, 10, y), dashed: true })),
];

/**
 * A court line through a homography as image polylines. A line is cut where it passes behind
 * the camera; each visible stretch is sampled so it stays straight after projection.
 */
export function projectLine(matrix: number[][], courtLine: CourtLine, samples = 24): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const at = project(matrix, {
      x: courtLine.from.x + (courtLine.to.x - courtLine.from.x) * t,
      y: courtLine.from.y + (courtLine.to.y - courtLine.from.y) * t,
    });
    if (at) {
      run.push(at);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  runs.push(run);
  return runs.filter((r) => r.length > 1);
}

function line(x1: number, y1: number, x2: number, y2: number): CourtLine {
  return { from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, dashed: false };
}

function replace(list: Calibration[], old: Calibration, next: Calibration): Calibration[] {
  return list.map((c) => (c === old ? next : c));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
