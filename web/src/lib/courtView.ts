import type { Point } from "./calibrations";

export type CourtOrientation = "vertical" | "horizontal";

export interface CourtView {
  zoom: number;
  /** The point at the middle of the viewport, in court feet. */
  center: Point;
}

export const FIT_COURT: CourtView = { zoom: 1, center: { x: 0, y: 0 } };
const MAX_ZOOM = 8;

/** Half the 32 × 64 ft playing area, including the surround. */
export const COURT_BOUNDS = { x: 16, y: 32 };
export const COURT_UNITS_PER_FT = 10;

/** SVG units reserved at either end for upright Team names. */
export const TEAM_LABEL_STRIP: Record<CourtOrientation, number> = {
  vertical: 16,
  horizontal: 108,
};

export function clampCourtPoint(point: Point, inset = 0): Point {
  const x = COURT_BOUNDS.x - inset;
  const y = COURT_BOUNDS.y - inset;
  return { x: clamp(point.x, -x, x), y: clamp(point.y, -y, y) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function courtViewBox(orientation: CourtOrientation) {
  const width = 2 * COURT_BOUNDS.x * COURT_UNITS_PER_FT;
  const length = 2 * (COURT_BOUNDS.y * COURT_UNITS_PER_FT + TEAM_LABEL_STRIP[orientation]);
  return orientation === "horizontal"
    ? { width: length, height: width }
    : { width, height: length };
}

/** Both axis mappings are their own inverse. Negative court y is the near end. */
function orient({ x, y }: Point, orientation: CourtOrientation): Point {
  return orientation === "horizontal" ? { x: -y, y: -x } : { x, y: -y };
}

/** The drawing matrix, overlay positions, and the inverse for placing facts in court feet. */
export function courtTransform(orientation: CourtOrientation, { zoom, center }: CourtView) {
  const origin = orient(center, orientation);
  const scale = COURT_UNITS_PER_FT * zoom;
  const tx = -origin.x * scale;
  const ty = -origin.y * scale;
  // The SVG shapes are drawn in the vertical view's units, so only horizontal needs a rotation.
  const linear = orientation === "horizontal" ? `0 ${-zoom} ${zoom} 0` : `${zoom} 0 0 ${zoom}`;
  return {
    svg: `matrix(${linear} ${tx} ${ty})`,
    toSvg(point: Point): Point {
      const p = orient(point, orientation);
      return { x: p.x * scale + tx, y: p.y * scale + ty };
    },
    toCourt(point: Point): Point {
      const feet = { x: (point.x - tx) / scale, y: (point.y - ty) / scale };
      return clampCourtPoint(orient(feet, orientation));
    },
  };
}

/** Convert a client point through the SVG's centered, aspect-preserving viewBox. */
export function courtSvgPoint(
  orientation: CourtOrientation,
  rect: Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">,
  client: Point,
): Point | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const box = courtViewBox(orientation);
  const scale = Math.min(rect.width / box.width, rect.height / box.height);
  return {
    x: (client.x - rect.left - rect.width / 2) / scale,
    y: (client.y - rect.top - rect.height / 2) / scale,
  };
}

function boundedView(orientation: CourtOrientation, zoom: number, center: Point): CourtView {
  if (zoom === 1) return FIT_COURT;
  const { width, height } = courtViewBox(orientation);
  const margin = (1 - 1 / zoom) / (2 * COURT_UNITS_PER_FT);
  const limits = orient({ x: width * margin, y: height * margin }, orientation);
  // Keep some playing area in view even when the Team name strips are wider than the viewport.
  const x = Math.min(COURT_BOUNDS.x, Math.abs(limits.x));
  const y = Math.min(COURT_BOUNDS.y, Math.abs(limits.y));
  return { zoom, center: { x: clamp(center.x, -x, x), y: clamp(center.y, -y, y) } };
}

/** Change zoom around an SVG point, keeping that point fixed where the bounds allow. */
export function zoomCourtView(
  orientation: CourtOrientation,
  view: CourtView,
  factor: number,
  anchor: Point,
): CourtView {
  const zoom = clamp(view.zoom / factor, 1, MAX_ZOOM);
  if (zoom === view.zoom) return view;
  const delta = orient(anchor, orientation);
  const shift = (1 / view.zoom - 1 / zoom) / COURT_UNITS_PER_FT;
  return boundedView(orientation, zoom, {
    x: view.center.x + delta.x * shift,
    y: view.center.y + delta.y * shift,
  });
}

/** Translate the drawing by a drag delta in SVG units. */
export function panCourtView(
  orientation: CourtOrientation,
  view: CourtView,
  delta: Point,
): CourtView {
  const offset = orient(delta, orientation);
  const scale = COURT_UNITS_PER_FT * view.zoom;
  return boundedView(orientation, view.zoom, {
    x: view.center.x - offset.x / scale,
    y: view.center.y - offset.y / scale,
  });
}
