import { describe, expect, it } from "vitest";
import { courtTransform, FIT_COURT, panCourtView, zoomCourtView } from "./courtView";

describe.each(["vertical", "horizontal"] as const)("%s Court view", (orientation) => {
  it.each([
    FIT_COURT,
    { zoom: 1.5, center: { x: -2, y: 4 } },
    { zoom: 4, center: { x: 10, y: -25 } },
    { zoom: 8, center: { x: -12, y: 22 } },
  ])("round-trips court feet and clamps out-of-bounds points at $zoom×", (view) => {
    const { toSvg, toCourt } = courtTransform(orientation, view);
    for (const point of [
      { x: 0, y: 0 },
      { x: 2.3, y: -11 },
      { x: -16, y: 32 },
    ]) {
      const result = toCourt(toSvg(point));
      expect(result.x).toBeCloseTo(point.x);
      expect(result.y).toBeCloseTo(point.y);
    }
    expect(toCourt(toSvg({ x: -28, y: -40 }))).toEqual({ x: -16, y: -32 });
    expect(toCourt(toSvg({ x: 28, y: 40 }))).toEqual({ x: 16, y: 32 });
  });

  it("keeps the pointer's court position during zoom and translates the drawing during pan", () => {
    const anchor = { x: 33, y: -52 };
    const feet = courtTransform(orientation, FIT_COURT).toCourt(anchor);
    const zoomed = zoomCourtView(orientation, FIT_COURT, 0.25, anchor);
    const at = courtTransform(orientation, zoomed).toSvg(feet);
    expect(at.x).toBeCloseTo(anchor.x);
    expect(at.y).toBeCloseTo(anchor.y);

    const panned = panCourtView(orientation, zoomed, { x: 24, y: -12 });
    const moved = courtTransform(orientation, panned).toSvg(feet);
    expect(moved.x).toBeCloseTo(anchor.x + 24);
    expect(moved.y).toBeCloseTo(anchor.y - 12);
  });

  it("clamps zoom and pan to keep the playing area in view", () => {
    const zoomed = zoomCourtView(orientation, FIT_COURT, 0.01, { x: 0, y: 0 });
    expect(zoomed.zoom).toBe(8);
    const panned = panCourtView(orientation, zoomed, { x: 100_000, y: -100_000 });
    expect(Math.abs(panned.center.x)).toBeLessThanOrEqual(16);
    expect(Math.abs(panned.center.y)).toBeLessThanOrEqual(32);
    expect(zoomCourtView(orientation, panned, 20, { x: 10, y: -200 })).toBe(FIT_COURT);
    expect(panCourtView(orientation, FIT_COURT, { x: 80, y: 100 })).toBe(FIT_COURT);
  });
});

it("puts the near end on the right and the camera's left sideline at the bottom", () => {
  const { toSvg } = courtTransform("horizontal", FIT_COURT);
  expect(toSvg({ x: -10, y: -22 })).toEqual({ x: 220, y: 100 });
  expect(toSvg({ x: 10, y: 22 })).toEqual({ x: -220, y: -100 });
});
