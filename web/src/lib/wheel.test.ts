import { describe, expect, it } from "vitest";
import { wheelPixels, wheelZoomFactor, ZOOM_STEP } from "./wheel";

describe("wheelPixels", () => {
  it.each([
    [0, 2, -3],
    [1, 32, -48],
    [2, 1200, -900],
  ])("normalizes deltaMode %i on both axes", (deltaMode, x, y) => {
    expect(wheelPixels({ deltaMode, deltaX: 2, deltaY: -3 }, 600, 300)).toEqual({ x, y });
  });
});

describe("wheelZoomFactor", () => {
  it.each([false, true])("caps scrolling and pinching at one step (pinch: %s)", (pinch) => {
    expect(wheelZoomFactor(-1000, pinch)).toBe(1 / ZOOM_STEP);
    expect(wheelZoomFactor(0, pinch)).toBe(1);
    expect(wheelZoomFactor(1000, pinch)).toBe(ZOOM_STEP);
  });

  it("keeps small inputs proportional to the wheel or pinch delta", () => {
    expect(wheelZoomFactor(20, false)).toBeCloseTo(ZOOM_STEP ** 0.2);
    expect(wheelZoomFactor(-20, true)).toBeCloseTo(Math.exp(-0.2));
  });
});
