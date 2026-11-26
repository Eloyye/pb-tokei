import type { Point } from "./calibrations";

/** The zoom factor for one button click, keypress, or wheel notch. */
export const ZOOM_STEP = 1.5;

export interface WheelDeltas {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
}

const LINE_PIXELS = 16;
const NOTCH_PIXELS = 100;

export function wheelPixels(
  { deltaMode, deltaX, deltaY }: WheelDeltas,
  pageWidth: number,
  pageHeight: number,
): Point {
  switch (deltaMode) {
    case 1: // DOM_DELTA_LINE
      return { x: deltaX * LINE_PIXELS, y: deltaY * LINE_PIXELS };
    case 2: // DOM_DELTA_PAGE
      return { x: deltaX * pageWidth, y: deltaY * pageHeight };
    default:
      return { x: deltaX, y: deltaY };
  }
}

/** Limit each wheel or trackpad pinch event to one zoom step. */
export function wheelZoomFactor(deltaY: number, pinch: boolean): number {
  const notches = deltaY / NOTCH_PIXELS;
  const factor = pinch ? Math.exp(notches) : ZOOM_STEP ** notches;
  return Math.max(1 / ZOOM_STEP, Math.min(ZOOM_STEP, factor));
}
