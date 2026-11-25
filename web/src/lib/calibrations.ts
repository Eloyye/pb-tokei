import type {
  Calibration,
  CalibrationOut,
  CameraView,
  Landmark,
  Lens,
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
  return fit &&
    fit.reference_frame === calibration.reference_frame &&
    sameLandmarks(fit.landmarks, calibration.landmarks) &&
    sameNotVisible(fit.not_visible, calibration.not_visible)
    ? fit
    : undefined;
}

function sameLandmarks(a: Calibration["landmarks"], b: Calibration["landmarks"]): boolean {
  const keys = Object.keys(a) as (keyof typeof a)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (k) => a[k]?.x === b[k]?.x && a[k]?.y === b[k]?.y && a[k]?.frame === b[k]?.frame,
  );
}

function sameNotVisible(a: readonly Landmark[], b: readonly Landmark[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((lm) => setA.has(lm));
}

function sortedNotVisible(items: Iterable<Landmark>): Landmark[] {
  const set = new Set(items);
  return LANDMARKS.filter((lm) => set.has(lm));
}

/** A new, empty Calibration of a segment's view, in effect from the segment's start. */
function startingWith(segment: PlaySegment, frame: number): Calibration {
  return {
    camera_view: segment.camera_view,
    effective_from_frame: segment.start_frame,
    reference_frame: frame,
    landmarks: {},
    not_visible: [],
  };
}

export interface LandmarkCounts {
  placed: number;
  notVisible: number;
  remaining: number;
  confirmedOnRef: number;
  otherFrame: number;
}

/** Counts placed, not visible, remaining, confirmed on reference frame, and off-reference Landmarks. */
export function landmarkCounts(calibration: Calibration | undefined): LandmarkCounts {
  if (!calibration) {
    return {
      placed: 0,
      notVisible: 0,
      remaining: LANDMARKS.length,
      confirmedOnRef: 0,
      otherFrame: 0,
    };
  }
  const placedEntries = Object.values(calibration.landmarks).filter(Boolean);
  const placed = placedEntries.length;
  const notVisible = calibration.not_visible.length;
  const confirmedOnRef = placedEntries.filter(
    (p) => p.frame === calibration.reference_frame,
  ).length;
  return {
    placed,
    notVisible,
    remaining: Math.max(0, LANDMARKS.length - placed - notVisible),
    confirmedOnRef,
    otherFrame: placed - confirmedOnRef,
  };
}

/**
 * Whether a placed Landmark came from outside the current Play Segment (carried over from another
 * Calibration via `N` or "Use here") rather than clicked on another frame of this Play Segment.
 */
export function isCarriedOver(
  landmarkFrame: number,
  referenceFrame: number,
  segment: PlaySegment,
): boolean {
  return (
    landmarkFrame !== referenceFrame &&
    (landmarkFrame < segment.start_frame || landmarkFrame > segment.end_frame)
  );
}

/**
 * Places a Landmark in the Calibration in effect on the segment, recording `frame` on the
 * Landmark. If its view has no Calibration yet, the click creates one starting with the segment
 * and anchored at `frame`. Placing a Landmark previously marked not visible clears that mark.
 */
export function placeLandmark(
  calibrations: Calibration[],
  segment: PlaySegment,
  frame: number,
  landmark: Landmark,
  point: Point,
): CalibrationEdit {
  const at = { x: clamp01(point.x), y: clamp01(point.y), frame };
  const active = calibrationAt(calibrations, segment.camera_view, frame);
  if (!active) {
    const created: Calibration = { ...startingWith(segment, frame), landmarks: { [landmark]: at } };
    return {
      calibrations: [...calibrations, created],
      edited: created,
      message: `New ${VIEW_LABELS[segment.camera_view]} Calibration from frame ${segment.start_frame}: ${landmarkLabel(landmark)} placed`,
    };
  }
  const not_visible = active.not_visible.filter((lm) => lm !== landmark);
  const edited: Calibration = {
    ...active,
    landmarks: { ...active.landmarks, [landmark]: at },
    not_visible,
  };
  const onRef = frame === active.reference_frame;
  return {
    calibrations: replace(calibrations, active, edited),
    edited,
    message: onRef
      ? `${landmarkLabel(landmark)} placed`
      : `${landmarkLabel(landmark)} placed on frame ${frame} (maps to ref frame ${active.reference_frame})`,
  };
}

/**
 * `V`: marks a Landmark as not visible in the Calibration in effect on the segment, removing any
 * placed point for it. Creates a Calibration starting with the segment if none exists yet.
 */
export function markNotVisible(
  calibrations: Calibration[],
  segment: PlaySegment,
  frame: number,
  landmark: Landmark,
): CalibrationEdit {
  const active = calibrationAt(calibrations, segment.camera_view, frame);
  if (!active) {
    const created: Calibration = {
      ...startingWith(segment, frame),
      not_visible: [landmark],
    };
    return {
      calibrations: [...calibrations, created],
      edited: created,
      message: `New ${VIEW_LABELS[segment.camera_view]} Calibration from frame ${segment.start_frame}: ${landmarkLabel(landmark)} marked not visible`,
    };
  }
  if (active.not_visible.includes(landmark)) {
    return {
      calibrations,
      message: `${landmarkLabel(landmark)} is already marked not visible`,
    };
  }
  const { [landmark]: _removed, ...landmarks } = active.landmarks;
  const edited: Calibration = {
    ...active,
    landmarks,
    not_visible: sortedNotVisible([...active.not_visible, landmark]),
  };
  return {
    calibrations: replace(calibrations, active, edited),
    edited,
    message: `${landmarkLabel(landmark)} marked not visible`,
  };
}

/** `X`: clears a placed or not-visible Landmark from the Calibration in effect, making it remaining. */
export function clearLandmark(
  calibrations: Calibration[],
  view: CameraView,
  frame: number,
  landmark: Landmark,
): CalibrationEdit {
  const active = calibrationAt(calibrations, view, frame);
  const wasPlaced = Boolean(active?.landmarks[landmark]);
  const wasNotVisible = Boolean(active?.not_visible.includes(landmark));
  if (!active || (!wasPlaced && !wasNotVisible)) {
    return { calibrations, message: `${landmarkLabel(landmark)} isn't placed` };
  }
  const { [landmark]: _cleared, ...landmarks } = active.landmarks;
  const not_visible = active.not_visible.filter((lm) => lm !== landmark);
  const edited: Calibration = { ...active, landmarks, not_visible };
  return {
    calibrations: replace(calibrations, active, edited),
    edited,
    message: `${landmarkLabel(landmark)} cleared`,
  };
}

/** Whether a normalised image point lies inside `[0, 1]^2` (with finite coordinates). */
export function isInFramePoint(point: Point | null | undefined): point is Point {
  return (
    point !== null &&
    point !== undefined &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1
  );
}

/**
 * `C`: confirms an off-reference placed Landmark onto the Calibration's `reference_frame` (e.g.
 * after `N` or "Use here"). Only allowed on `reference_frame` when Camera Motion has mapped the
 * Landmark to a valid in-frame `resolvedPoint`; never stamps a stale point from another frame.
 */
export function confirmLandmark(
  calibrations: Calibration[],
  view: CameraView,
  frame: number,
  landmark: Landmark,
  resolvedPoint?: Point,
): CalibrationEdit {
  const active = calibrationAt(calibrations, view, frame);
  const existing = active?.landmarks[landmark];
  if (!active || !existing) {
    return { calibrations, message: `${landmarkLabel(landmark)} isn't placed` };
  }
  if (frame !== active.reference_frame) {
    return {
      calibrations,
      message: `Go to reference frame ${active.reference_frame} to confirm ${landmarkLabel(landmark)}`,
    };
  }
  if (existing.frame === frame) {
    return {
      calibrations,
      message: `${landmarkLabel(landmark)} is already confirmed on frame ${frame}`,
    };
  }
  if (!isInFramePoint(resolvedPoint)) {
    return {
      calibrations,
      message: `Can't confirm ${landmarkLabel(landmark)} automatically: re-click it on frame ${frame}`,
    };
  }
  const updated = {
    x: resolvedPoint.x,
    y: resolvedPoint.y,
    frame,
  };
  const edited: Calibration = {
    ...active,
    landmarks: { ...active.landmarks, [landmark]: updated },
  };
  return {
    calibrations: replace(calibrations, active, edited),
    edited,
    message: `${landmarkLabel(landmark)} confirmed on frame ${frame}`,
  };
}

/**
 * Confirms every off-reference placed Landmark of the active Calibration that has a valid
 * in-frame mapped position on `reference_frame`. Unmapped or out-of-frame Landmarks are left
 * untouched so they can be re-clicked rather than stamped at stale coordinates.
 */
export function confirmAllLandmarks(
  calibrations: Calibration[],
  view: CameraView,
  frame: number,
  resolvedLandmarks?: Partial<Record<Landmark, Point>>,
): CalibrationEdit {
  const active = calibrationAt(calibrations, view, frame);
  if (!active) return { calibrations, message: "No Calibration in effect" };
  if (frame !== active.reference_frame) {
    return {
      calibrations,
      message: `Go to reference frame ${active.reference_frame} to confirm Landmarks`,
    };
  }
  let changed = 0;
  let skipped = 0;
  const landmarks: Calibration["landmarks"] = {};
  for (const [key, placed] of Object.entries(active.landmarks)) {
    const lm = key as Landmark;
    if (!placed) continue;
    if (placed.frame === frame) {
      landmarks[lm] = placed;
      continue;
    }
    const resolved = resolvedLandmarks?.[lm];
    if (!isInFramePoint(resolved)) {
      skipped += 1;
      landmarks[lm] = placed;
      continue;
    }
    changed += 1;
    landmarks[lm] = {
      x: resolved.x,
      y: resolved.y,
      frame,
    };
  }
  if (changed === 0) {
    return {
      calibrations,
      message:
        skipped > 0
          ? `No off-reference Landmarks can be confirmed automatically: re-click them on frame ${frame}`
          : `All placed Landmarks are already confirmed on frame ${frame}`,
    };
  }
  const edited: Calibration = { ...active, landmarks };
  const suffix = skipped > 0 ? ` (${skipped} still need re-clicking)` : "";
  return {
    calibrations: replace(calibrations, active, edited),
    edited,
    message: `Confirmed ${changed} ${changed === 1 ? "Landmark" : "Landmarks"} on frame ${frame}${suffix}`,
  };
}

/**
 * `N`: starts a new Calibration in effect from the segment's start, with a copy of the Landmarks
 * of the one in effect (preserving each Landmark's original click frame so carried-over points
 * stay visibly distinct from points confirmed on the new reference frame).
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
    landmarks: active ? cloneLandmarks(active.landmarks) : {},
    not_visible: active ? [...active.not_visible] : [],
  };
  return {
    calibrations: [...calibrations, created],
    edited: created,
    message: `New ${VIEW_LABELS[view]} Calibration from frame ${segment.start_frame}${active ? ", carried over from the one before: move or confirm Landmarks on this frame" : ""}`,
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
    not_visible: [],
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
  if (
    atStart &&
    sameLandmarks(atStart.landmarks, source.landmarks) &&
    sameNotVisible(atStart.not_visible, source.not_visible)
  ) {
    return "This Play Segment already uses these points";
  }
  return null;
}

/**
 * "Use here": puts an earlier Calibration's points in effect from the segment's start, for a
 * camera that has gone back to an angle it had before. Preserves each copied Landmark's original
 * click frame so carried-over points remain clearly marked until confirmed on the new reference
 * frame. If a Calibration of the view already starts with the segment, its points are replaced;
 * otherwise a new one is made.
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
  const landmarks = cloneLandmarks(source.landmarks);
  const not_visible = [...source.not_visible];
  const existing = calibrationStartingWith(calibrations, segment);
  if (existing) {
    const edited: Calibration = { ...existing, reference_frame: frame, landmarks, not_visible };
    return {
      calibrations: replace(calibrations, existing, edited),
      edited,
      message: `This Play Segment's Calibration now uses the points of ${from}`,
    };
  }
  const created: Calibration = { ...startingWith(segment, frame), landmarks, not_visible };
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
 * The Landmark to place after `current`: the next remaining one (neither placed nor marked not
 * visible) in clicking order, wrapping round, or null once none remain.
 */
export function nextLandmark(
  placed: Partial<Record<Landmark, unknown>>,
  current: Landmark | null,
  notVisible: readonly Landmark[] = [],
): Landmark | null {
  const skipped = new Set(notVisible);
  const start = current ? LANDMARKS.indexOf(current) + 1 : 0;
  for (let i = 0; i < LANDMARKS.length; i++) {
    const landmark = LANDMARKS[(start + i) % LANDMARKS.length]!;
    if (!placed[landmark] && !skipped.has(landmark)) return landmark;
  }
  return null;
}

function cloneLandmarks(landmarks: Calibration["landmarks"]): Calibration["landmarks"] {
  const copy: Calibration["landmarks"] = {};
  for (const [key, value] of Object.entries(landmarks)) {
    if (value) copy[key as Landmark] = { ...value };
  }
  return copy;
}

/** `Tab`: the Landmark after `current` in clicking order, placed or not, wrapping round. */
export function skipLandmark(current: Landmark | null): Landmark {
  const index = current ? LANDMARKS.indexOf(current) : -1;
  return LANDMARKS[(index + 1) % LANDMARKS.length]!;
}

/** A Landmark marker rendered on the Monitor for the current frame. */
export interface VisibleLandmarkMarker {
  landmark: Landmark;
  index: number;
  at: Point;
  otherFrame: boolean;
  clickedFrame: number;
  flagged: boolean;
}

/**
 * Where a Landmark's marker sits on `frame`, or null if no marker is drawn on this frame:
 * - while dragged: at the live drag point
 * - clicked on `frame`: at its placed position
 * - on `reference_frame`, clicked on another frame: at its in-frame resolved position, or its raw
 *   placed position when unresolved (so carried-over/unmapped points can be dragged into place)
 * - off `reference_frame`, clicked on another frame: not drawn (null)
 */
function markerPosition(
  calibration: Calibration | undefined,
  frame: number,
  landmark: Landmark,
  resolvedLandmarks: Partial<Record<Landmark, Point>> | undefined,
  drag: { landmark: Landmark; at: Point } | null | undefined,
): { at: Point; otherFrame: boolean; clickedFrame: number } | null {
  if (!calibration) return null;
  if (drag?.landmark === landmark) {
    return { at: drag.at, otherFrame: false, clickedFrame: frame };
  }
  const placed = calibration.landmarks[landmark];
  if (!placed) return null;
  if (placed.frame === frame) {
    return { at: { x: placed.x, y: placed.y }, otherFrame: false, clickedFrame: placed.frame };
  }
  if (frame !== calibration.reference_frame) return null;
  const resolved = resolvedLandmarks?.[landmark];
  if (resolved) {
    if (!isInFramePoint(resolved)) return null;
    return { at: resolved, otherFrame: true, clickedFrame: placed.frame };
  }
  return { at: { x: placed.x, y: placed.y }, otherFrame: true, clickedFrame: placed.frame };
}

/** Builds the visible Landmark markers for `frame` in clicking order. */
export function visibleLandmarkMarkers(
  calibration: Calibration | undefined,
  frame: number,
  fit: CalibrationOut | undefined,
  drag?: { landmark: Landmark; at: Point } | null,
): VisibleLandmarkMarker[] {
  if (!calibration) return [];
  const unmappedSet = new Set(fit?.unmapped_landmarks ?? []);
  const markers: VisibleLandmarkMarker[] = [];
  LANDMARKS.forEach((landmark, index) => {
    const pos = markerPosition(calibration, frame, landmark, fit?.resolved_landmarks, drag);
    if (!pos) return;
    const isDragged = drag?.landmark === landmark;
    const resolved = fit?.resolved_landmarks[landmark];
    const flagged = isDragged
      ? false
      : pos.otherFrame && !resolved
        ? unmappedSet.has(landmark)
        : Boolean(fit?.errors[landmark]?.needs_attention);
    markers.push({ landmark, index, ...pos, flagged });
  });
  return markers;
}

/**
 * How the Monitor highlights the currently selected Landmark:
 * - `marker`: glow behind the Landmark's existing `.landmark-marker` on this frame
 * - `ghost`: glow at its projected court intersection when it has no marker on this frame
 * - `none`: no highlight (nothing selected, no matrix, or projection outside the picture)
 */
export type LandmarkHighlight =
  | { kind: "none" }
  | { kind: "marker"; at: Point }
  | { kind: "ghost"; at: Point };

export interface LandmarkHighlightInput {
  selected: Landmark | null;
  calibration: Calibration | undefined;
  frame: number;
  /** Resolved reference-frame positions from the current fit, if any. */
  resolvedLandmarks?: Partial<Record<Landmark, Point>>;
  /** The Landmark currently being dragged and its live image position, if any. */
  drag?: { landmark: Landmark; at: Point } | null;
  /** The court-to-image matrix the court template uses, or null/undefined if unavailable. */
  matrix: number[][] | null | undefined;
  /** The lens that bends `matrix`'s image into the frame, if any (see `distort`). */
  lens?: Lens | null;
}

/** Computes the Monitor highlight for the selected Landmark on `frame`. */
export function landmarkHighlight({
  selected,
  calibration,
  frame,
  resolvedLandmarks,
  drag,
  matrix,
  lens,
}: LandmarkHighlightInput): LandmarkHighlight {
  if (!selected) return { kind: "none" };
  const marker = markerPosition(calibration, frame, selected, resolvedLandmarks, drag);
  if (marker) return { kind: "marker", at: marker.at };
  if (!matrix) return { kind: "none" };
  const projected = project(matrix, courtPoint(selected), lens);
  if (!isInFramePoint(projected)) return { kind: "none" };
  return { kind: "ghost", at: projected };
}

/**
 * A court point through a 3×3 homography into normalised image coordinates, or null if it is
 * behind the camera (`w` not positive, as the server orients its matrices). With a `lens`, the
 * matrix maps into the undistorted image and the point is then bent into the frame (`distort`).
 */
export function project(matrix: number[][], point: Point, lens?: Lens | null): Point | null {
  const [a, b, c] = matrix as [number[], number[], number[]];
  const w = c[0]! * point.x + c[1]! * point.y + c[2]!;
  if (!(w > 0)) return null;
  const at = {
    x: (a[0]! * point.x + a[1]! * point.y + a[2]!) / w,
    y: (b[0]! * point.x + b[1]! * point.y + b[2]!) / w,
  };
  return lens ? distort(at, lens) : at;
}

// `distort`'s fixed-point iteration, matching `Lens.distort` in src/pb_tokei/calibration.py: both
// are checked against lens-golden.json, which pytest asserts against the server's model.
const DISTORT_ITERATIONS = 12;
const DISTORT_SCALE_RANGE = [0.2, 5] as const;
const DISTORT_MIN_DENOMINATOR = 1e-3;

/**
 * Where an undistorted normalised image point appears in the frame through a broadcast lens.
 *
 * The server's model (ADR 0011): an undistorted point lies at `c + (p - c) * (1 + k1 * r^2)` for
 * the frame point `p`, with `c` the centre and `r` its distance from it in half-diagonals; this
 * inverts that by fixed-point iteration on the radial scale.
 */
export function distort(point: Point, lens: Lens): Point {
  if (lens.k1 === 0) return point;
  const dx = point.x - 0.5;
  const dy = point.y - 0.5;
  const a2 = lens.aspect * lens.aspect;
  const ru2 = (4 * (dx * dx * a2 + dy * dy)) / (a2 + 1);
  const [low, high] = DISTORT_SCALE_RANGE;
  let s = 1;
  for (let i = 0; i < DISTORT_ITERATIONS; i++) {
    const denominator = Math.max(1 + lens.k1 * ru2 * s * s, DISTORT_MIN_DENOMINATOR);
    s = Math.min(high, Math.max(low, 1 / denominator));
  }
  return { x: 0.5 + dx * s, y: 0.5 + dy * s };
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
 * the camera; each visible stretch is sampled so it stays straight after projection, or follows
 * the bend when a `lens` bends it into the frame.
 */
export function projectLine(
  matrix: number[][],
  courtLine: CourtLine,
  lens?: Lens | null,
  samples = 24,
): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const at = project(
      matrix,
      {
        x: courtLine.from.x + (courtLine.to.x - courtLine.from.x) * t,
        y: courtLine.from.y + (courtLine.to.y - courtLine.from.y) * t,
      },
      lens,
    );
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
