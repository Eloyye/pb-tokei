import { describe, expect, it } from "vitest";
import {
  centreOn,
  clampView,
  followFrame,
  frameAt,
  fullView,
  MIN_SPAN,
  rulerTicks,
  toPercent,
  zoomView,
} from "./timeline";

describe("toPercent and frameAt", () => {
  const view = { start: 100, end: 300 };

  it("maps frames across the view", () => {
    expect(toPercent(view, 100)).toBe(0);
    expect(toPercent(view, 200)).toBe(50);
    expect(toPercent(view, 400)).toBe(150);
  });

  it("maps a fraction back to a whole frame", () => {
    expect(frameAt(view, 0)).toBe(100);
    expect(frameAt(view, 0.5)).toBe(200);
    expect(frameAt(view, 0.999)).toBe(299);
  });
});

describe("rulerTicks", () => {
  it("picks the smallest step that keeps ten ticks or fewer", () => {
    expect(rulerTicks({ start: 0, end: 600 }).step).toBe(60);
    expect(rulerTicks({ start: 0, end: 601 }).step).toBe(120);
    expect(rulerTicks({ start: 0, end: 8 }).step).toBe(1);
  });

  it("puts ticks on multiples of the step, starting at frame 0 at the earliest", () => {
    expect(rulerTicks({ start: -50, end: 250 }).frames).toEqual([
      0, 30, 60, 90, 120, 150, 180, 210, 240,
    ]);
    expect(rulerTicks({ start: 61, end: 600 }).frames[0]).toBe(120);
  });
});

describe("fullView", () => {
  it("covers the whole video", () => {
    expect(fullView(10_000)).toEqual({ start: 0, end: 10_000 });
    expect(fullView(600)).toEqual({ start: 0, end: 600 });
  });

  it("falls back to a minute before the length is known", () => {
    expect(fullView(0)).toEqual({ start: 0, end: 3600 });
  });
});

describe("clampView", () => {
  it("keeps the zoom when the known length gets shorter", () => {
    expect(clampView({ start: 500, end: 600 }, 580)).toEqual({ start: 480, end: 580 });
  });

  it("fits the video when the view is wider than the new bounds", () => {
    expect(clampView({ start: 0, end: 600 }, 580)).toEqual({ start: 0, end: 580 });
  });
});

describe("zoomView", () => {
  it("keeps the anchor at the same place on screen", () => {
    const view = { start: 0, end: 1000 };
    const zoomed = zoomView(view, 0.5, 250, 10_000);
    expect(zoomed.end - zoomed.start).toBe(500);
    expect(toPercent(zoomed, 250)).toBeCloseTo(toPercent(view, 250), 9);
  });

  it("never zooms in past the minimum span or out past the whole video", () => {
    const tiny = zoomView({ start: 0, end: 20 }, 0.1, 10, 10_000);
    expect(tiny.end - tiny.start).toBe(MIN_SPAN);
    const huge = zoomView({ start: 0, end: 8000 }, 4, 4000, 10_000);
    expect(huge).toEqual(fullView(10_000));
  });

  it("fits a video shorter than the minimum zoom span", () => {
    expect(zoomView(fullView(10), 0.5, 0, 10)).toEqual({ start: 0, end: 10 });
  });

  it("keeps the playhead visible when zooming out at either edge", () => {
    expect(zoomView({ start: 0, end: 200 }, 2, 1, 600)).toEqual({ start: 0, end: 400 });
    expect(zoomView({ start: 400, end: 600 }, 2, 599, 600)).toEqual({ start: 200, end: 600 });
  });

  it("zooms around the nearest edge when the anchor is off screen", () => {
    const zoomed = zoomView({ start: 0, end: 1000 }, 0.5, 2000, 10_000);
    expect(zoomed).toEqual({ start: 1500, end: 2000 });
  });
});

describe("followFrame", () => {
  const view = { start: 0, end: 1000 };

  it("leaves the view alone while the frame is on screen", () => {
    expect(followFrame(view, 999, 10_000)).toBe(view);
  });

  it("pages forward with the frame near the left edge", () => {
    expect(followFrame(view, 1000, 10_000)).toEqual({ start: 900, end: 1900 });
  });

  it("pages back with the frame near the right edge", () => {
    expect(followFrame({ start: 2000, end: 3000 }, 1500, 10_000)).toEqual({
      start: 600,
      end: 1600,
    });
  });

  it("keeps the span when following the playhead to either end", () => {
    const middle = { start: 1000, end: 2000 };
    expect(followFrame(middle, 0, 10_000)).toEqual({ start: 0, end: 1000 });
    expect(followFrame(middle, 9999, 10_000)).toEqual({ start: 9000, end: 10_000 });
  });
});

describe("centreOn", () => {
  const view = { start: 0, end: 1000 };

  it("centres the view and keeps its span", () => {
    expect(centreOn(view, 5000, 10_000)).toEqual({ start: 4500, end: 5500 });
  });

  it("keeps the span when centring near either end", () => {
    expect(centreOn(view, 10, 10_000)).toEqual({ start: 0, end: 1000 });
    expect(centreOn(view, 9990, 10_000)).toEqual({ start: 9000, end: 10_000 });
  });
});
