import type { Calibration, CameraView, PlaySegment } from "../api/client";

/**
 * Play Segment editing (#10). Every function is pure: it takes the segments in frame order and
 * returns the edit's result, which the caller records for undo and saves.
 *
 * Segments never overlap. An edit that would run into a neighbour stops at its edge and says so.
 * Frame ranges are inclusive at both ends, so a one-frame segment is allowed.
 */

/** A segment begun with `Shift+I` and not yet ended with `Shift+O`. It isn't saved. */
export interface PendingSegment {
  start: number;
  camera_view: CameraView;
}

export interface SegmentEdit {
  segments: PlaySegment[];
  pending: PendingSegment | null;
  /** A segment's start that moved, so Calibrations that began there can move with it. */
  startMoved: { from: number; to: number; camera_view: CameraView } | null;
  /** A hint for the status bar. */
  message: string;
}

export const VIEW_LABELS: Record<CameraView, string> = {
  main: "Main View",
  sideline: "Sideline View",
};

export function segmentAt(segments: PlaySegment[], frame: number): PlaySegment | undefined {
  return segments.find((s) => s.start_frame <= frame && frame <= s.end_frame);
}

/** A new segment's view: that of the nearest segment before it, or Main View. */
export function defaultView(segments: PlaySegment[], frame: number): CameraView {
  const before = segments.filter((s) => s.end_frame < frame);
  return before.at(-1)?.camera_view ?? "main";
}

/**
 * `Shift+I`: inside a segment, its start moves to the frame; outside, a pending segment opens
 * there.
 */
export function markIn(
  segments: PlaySegment[],
  pending: PendingSegment | null,
  frame: number,
): SegmentEdit {
  const segment = segmentAt(segments, frame);
  if (segment) return moveEdge(segments, pending, segment.start_frame, "start", frame);
  const view = defaultView(segments, frame);
  return {
    segments,
    pending: { start: frame, camera_view: view },
    startMoved: null,
    message: `${VIEW_LABELS[view]} Play Segment from frame ${frame}: Shift+O on its last frame`,
  };
}

/**
 * `Shift+O`: ends the pending segment at the frame, or moves the end of the segment under the
 * playhead there.
 */
export function markOut(
  segments: PlaySegment[],
  pending: PendingSegment | null,
  frame: number,
): SegmentEdit {
  if (pending) return closePending(segments, pending, frame);
  const segment = segmentAt(segments, frame);
  if (segment) return moveEdge(segments, pending, segment.start_frame, "end", frame);
  return unchanged(segments, pending, "Shift+I on a Play Segment's first frame starts one");
}

function closePending(
  segments: PlaySegment[],
  pending: PendingSegment,
  frame: number,
): SegmentEdit {
  if (segmentAt(segments, pending.start)) {
    return unchanged(segments, null, "The pending start is now inside a Play Segment; dropped it");
  }
  const { low, high } = room(segments, pending.start);
  const start = Math.max(Math.min(pending.start, frame), low);
  const end = Math.min(Math.max(pending.start, frame), high);
  const added = { start_frame: start, end_frame: end, camera_view: pending.camera_view };
  const stopped =
    start !== Math.min(pending.start, frame) || end !== Math.max(pending.start, frame);
  return {
    segments: sorted([...segments, added]),
    pending: null,
    startMoved: null,
    message: `${stopped ? "Stopped at the next Play Segment. " : ""}${describe(added)} added`,
  };
}

/**
 * Moves one edge of the segment starting at `segmentStart` to `frame`, stopping at its
 * neighbours and at its other edge.
 */
export function moveEdge(
  segments: PlaySegment[],
  pending: PendingSegment | null,
  segmentStart: number,
  edge: "start" | "end",
  frame: number,
): SegmentEdit {
  const segment = segments.find((s) => s.start_frame === segmentStart);
  if (!segment) return unchanged(segments, pending, "That Play Segment is gone");
  const others = segments.filter((s) => s !== segment);
  const { low, high } = room(others, segment.start_frame);
  const moved =
    edge === "start"
      ? { ...segment, start_frame: clamp(frame, low, segment.end_frame) }
      : { ...segment, end_frame: clamp(frame, segment.start_frame, high) };
  const reached = edge === "start" ? moved.start_frame : moved.end_frame;
  const neighbour = edge === "start" ? low : high;
  const stop =
    reached === frame
      ? ""
      : reached === neighbour
        ? "Stopped at the next Play Segment. "
        : "A Play Segment can't end before it starts. ";
  if (moved.start_frame === segment.start_frame && moved.end_frame === segment.end_frame) {
    return unchanged(segments, pending, `${stop}${describe(segment)} unchanged`);
  }
  return {
    segments: sorted([...others, moved]),
    pending,
    startMoved:
      moved.start_frame === segment.start_frame
        ? null
        : { from: segment.start_frame, to: moved.start_frame, camera_view: segment.camera_view },
    message: `${stop}${describe(moved)}`,
  };
}

/** `1`/`2`: sets the view of the pending segment, or of the segment under the playhead. */
export function setCameraView(
  segments: PlaySegment[],
  pending: PendingSegment | null,
  frame: number,
  view: CameraView,
): SegmentEdit {
  if (pending) {
    return unchanged(segments, { ...pending, camera_view: view }, `Pending: ${VIEW_LABELS[view]}`);
  }
  const segment = segmentAt(segments, frame);
  if (!segment) return unchanged(segments, pending, "Not in a Play Segment");
  if (segment.camera_view === view) return unchanged(segments, pending, describe(segment));
  const changed = { ...segment, camera_view: view };
  return {
    segments: segments.map((s) => (s === segment ? changed : s)),
    pending,
    startMoved: null,
    message: describe(changed),
  };
}

/** `Backspace`: removes the segment under the playhead. */
export function removeAt(
  segments: PlaySegment[],
  pending: PendingSegment | null,
  frame: number,
): SegmentEdit {
  const segment = segmentAt(segments, frame);
  if (!segment) return unchanged(segments, pending, "Not in a Play Segment");
  return {
    segments: segments.filter((s) => s !== segment),
    pending,
    startMoved: null,
    message: `${describe(segment)} removed`,
  };
}

/**
 * Moves the Calibrations that began where a segment used to start, so they still begin at it.
 * One is left where it is if another of its view already starts at the new frame.
 */
export function followStart(
  calibrations: Calibration[],
  move: { from: number; to: number; camera_view: CameraView },
): Calibration[] {
  const ofView = calibrations.filter((c) => c.camera_view === move.camera_view);
  if (ofView.some((c) => c.effective_from_frame === move.to)) return calibrations;
  return calibrations.map((c) =>
    c.camera_view === move.camera_view && c.effective_from_frame === move.from
      ? { ...c, effective_from_frame: move.to }
      : c,
  );
}

export function describe(segment: PlaySegment): string {
  const { start_frame: start, end_frame: end } = segment;
  return `${VIEW_LABELS[segment.camera_view]} Play Segment, frames ${start}–${end}`;
}

/** The frames free around `frame` (which is outside every segment): from `low` to `high`. */
function room(segments: PlaySegment[], frame: number): { low: number; high: number } {
  const before = segments.filter((s) => s.end_frame < frame).at(-1);
  const after = segments.find((s) => s.start_frame > frame);
  return {
    low: before ? before.end_frame + 1 : 0,
    high: after ? after.start_frame - 1 : Number.POSITIVE_INFINITY,
  };
}

function unchanged(
  segments: PlaySegment[],
  pending: PendingSegment | null,
  message: string,
): SegmentEdit {
  return { segments, pending, startMoved: null, message };
}

function sorted(segments: PlaySegment[]): PlaySegment[] {
  return segments.toSorted((a, b) => a.start_frame - b.start_frame);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
