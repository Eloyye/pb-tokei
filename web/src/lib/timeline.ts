/**
 * Timeline view math. A view is the range of frames visible across the Timeline's width,
 * `[start, end)`, bounded by the full view.
 */

export interface FrameRange {
  start: number;
  end: number;
}

/** The narrowest view, in frames: a quarter second. */
export const MIN_SPAN = 15;

/** Tick spacings the ruler may use, in frames: from 1 frame to 10 minutes. */
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 18000, 36000];

/** At most this many labelled ticks across the ruler. */
const MAX_TICKS = 10;

/** Where frame `n` falls across the view, as a percentage (may be outside 0 to 100). */
export function toPercent(view: FrameRange, n: number): number {
  return ((n - view.start) / (view.end - view.start)) * 100;
}

/** The frame at `fraction` (0 to 1) across the view. */
export function frameAt(view: FrameRange, fraction: number): number {
  return Math.floor(view.start + fraction * (view.end - view.start));
}

/** The labelled ruler ticks for a view: multiples of one step, at most `MAX_TICKS` of them. */
export function rulerTicks(view: FrameRange): { step: number; frames: number[] } {
  const span = view.end - view.start;
  const step = TICK_STEPS.find((s) => span / s <= MAX_TICKS) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const frames: number[] = [];
  for (let f = Math.max(0, Math.ceil(view.start / step) * step); f < view.end; f += step) {
    frames.push(f);
  }
  return { step, frames };
}

/** The whole video, or a nominal minute when its length isn't known yet. */
export function fullView(totalFrames: number): FrameRange {
  return { start: 0, end: totalFrames > 0 ? totalFrames : 3600 };
}

/**
 * Shift the view inside the video, keeping its span up to the video's length.
 * Returns the original `view` object when it already fits.
 */
function clampView(view: FrameRange, totalFrames: number): FrameRange {
  const end = fullView(totalFrames).end;
  if (view.start >= 0 && view.end <= end) return view;
  const span = Math.min(view.end - view.start, end);
  if (view.start < 0) return { start: 0, end: span };
  return { start: end - span, end };
}

/**
 * Scale the view by `factor` (below 1 zooms in), keeping `anchor` at the same place on screen
 * when the video bounds allow it. The span is at least `MIN_SPAN` when the video is long enough.
 */
export function zoomView(
  view: FrameRange,
  factor: number,
  anchor: number,
  totalFrames: number,
): FrameRange {
  const span = view.end - view.start;
  const whole = fullView(totalFrames);
  const next = Math.max(MIN_SPAN, span * factor);
  if (next >= whole.end) return whole;
  const rel = span > 0 ? (anchor - view.start) / span : 0.5;
  const at = Math.min(1, Math.max(0, rel));
  return clampView({ start: anchor - next * at, end: anchor + next * (1 - at) }, totalFrames);
}

/**
 * Page the view to keep `frame` on screen within the video bounds.
 * Returns the original `view` object when the frame is on screen and the view already fits.
 */
export function followFrame(view: FrameRange, frame: number, totalFrames: number): FrameRange {
  if (frame >= view.start && frame < view.end) return clampView(view, totalFrames);
  const span = view.end - view.start;
  // Page forward with the playhead near the left edge, or back with it near the right.
  const start = frame >= view.end ? frame - span * 0.1 : frame - span * 0.9;
  return clampView({ start, end: start + span }, totalFrames);
}

/** Centre the view on `frame` within the video bounds, keeping its span. */
export function centreOn(view: FrameRange, frame: number, totalFrames: number): FrameRange {
  const span = view.end - view.start;
  return clampView({ start: frame - span / 2, end: frame + span / 2 }, totalFrames);
}

interface PlaybackPosition {
  frame: number;
  totalFrames: number;
}

/**
 * Fit the whole video when its length first becomes known. On later length changes, shift the
 * view inside the new bounds, keeping its span when it fits. Follow a changed playhead after
 * applying the length change.
 */
export function reconcileView(
  view: FrameRange,
  previous: PlaybackPosition,
  { frame, totalFrames }: PlaybackPosition,
): FrameRange {
  let nextView = view;
  if (previous.totalFrames !== totalFrames) {
    nextView = previous.totalFrames === 0 ? fullView(totalFrames) : clampView(view, totalFrames);
  }
  return previous.frame === frame ? nextView : followFrame(nextView, frame, totalFrames);
}
