/**
 * Timeline view math. A view is the range of frames visible across the Timeline's width,
 * `[start, end)`; it may run past either end of the video so zooming around the playhead stays
 * centred.
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
  return { start: 0, end: Math.max(totalFrames, 3600) };
}

/**
 * The view scaled by `factor` (below 1 zooms in) around `anchor`, which stays at the same place
 * on screen. The span is kept between `MIN_SPAN` and the whole video.
 */
export function zoomView(
  view: FrameRange,
  factor: number,
  anchor: number,
  totalFrames: number,
): FrameRange {
  const span = view.end - view.start;
  const maxSpan = fullView(totalFrames).end;
  const next = Math.min(maxSpan, Math.max(MIN_SPAN, span * factor));
  const rel = span > 0 ? (anchor - view.start) / span : 0.5;
  const at = Math.min(1, Math.max(0, rel));
  return { start: anchor - next * at, end: anchor + next * (1 - at) };
}

/** The view, paged so `frame` is on screen; unchanged if it already is. */
export function followFrame(view: FrameRange, frame: number): FrameRange {
  if (frame >= view.start && frame < view.end) return view;
  const span = view.end - view.start;
  // Page forward with the playhead near the left edge, or back with it near the right.
  const start = frame >= view.end ? frame - span * 0.1 : frame - span * 0.9;
  return { start, end: start + span };
}

/** The view moved so it is centred on `frame`, keeping its span. */
export function centreOn(view: FrameRange, frame: number): FrameRange {
  const span = view.end - view.start;
  return { start: frame - span / 2, end: frame + span / 2 };
}
