import { describe, expect, it } from "vitest";
import {
  centreOn,
  followFrame,
  frameAt,
  fullView,
  lockWheelAxis,
  MIN_SPAN,
  reconcileView,
  rulerTicks,
  toPercent,
  wheelToView,
  ZOOM_STEP,
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

describe("wheelToView", () => {
  const view = { start: 400, end: 1000 };
  const context = {
    laneWidth: 600,
    pageHeight: 200,
    pointerFraction: 0.25,
    playing: false,
    frame: 800,
    totalFrames: 3000,
    overview: false,
  };
  const wheel = { deltaMode: 0, deltaX: 0, deltaY: 0, shiftKey: false, ctrlKey: false };
  const apply = (
    input: Partial<typeof wheel>,
    options?: Partial<Parameters<typeof wheelToView>[2]>,
  ) => wheelToView(view, { ...wheel, ...input }, { ...context, ...options });

  it.each([
    { deltaMode: 1, deltaX: 2, deltaY: 0, pixelsX: 32, pixelsY: 0 },
    { deltaMode: 1, deltaX: 0, deltaY: -2, pixelsX: 0, pixelsY: -32 },
    { deltaMode: 2, deltaX: 0.5, deltaY: 0, pixelsX: 300, pixelsY: 0 },
    { deltaMode: 2, deltaX: 0, deltaY: 0.25, pixelsX: 0, pixelsY: 50 },
  ])("converts delta mode $deltaMode to pixels ($pixelsX, $pixelsY)", (test) => {
    const { deltaMode, deltaX, deltaY, pixelsX, pixelsY } = test;
    expect(apply({ deltaMode, deltaX, deltaY })).toEqual(
      apply({ deltaX: pixelsX, deltaY: pixelsY }),
    );
  });

  it("zooms one step per notch, with positive deltas zooming out", () => {
    expect(apply({ deltaY: 100 })).toEqual({ start: 325, end: 1225 });
    expect(apply({ deltaY: -100 })).toEqual({ start: 450, end: 850 });
    const halfNotch = apply({ deltaY: 50 });
    expect(halfNotch.end - halfNotch.start).toBeCloseTo(600 * ZOOM_STEP ** 0.5);
  });

  it("uses an exponential factor for pinches, even during a horizontal scroll lock", () => {
    const pinched = apply({ deltaY: 20, ctrlKey: true }, { axis: "x" });
    expect(pinched.end - pinched.start).toBeCloseTo(600 * Math.exp(0.2));
  });

  it.each([false, true])("caps each wheel event at one step (pinch: %s)", (ctrlKey) => {
    expect(apply({ deltaY: 900, ctrlKey })).toEqual({ start: 325, end: 1225 });
    expect(apply({ deltaY: -900, ctrlKey })).toEqual({ start: 450, end: 850 });
  });

  it("keeps the same point under the pointer while paused", () => {
    const pointerFraction = 0.251;
    const pointerFrame = view.start + pointerFraction * (view.end - view.start);
    const zoomed = apply({ deltaY: -100 }, { pointerFraction });
    expect(toPercent(zoomed, pointerFrame)).toBeCloseTo(pointerFraction * 100);
  });

  it("anchors at the playhead during playback and over the headers", () => {
    const zoomed = { start: 200, end: 1100 };
    expect(apply({ deltaY: 100 }, { playing: true })).toEqual(zoomed);
    expect(apply({ deltaY: 100 }, { pointerFraction: undefined })).toEqual(zoomed);
  });

  it("pans by the same distance over the lanes, headers, and Overview bar", () => {
    const panned = { start: 500, end: 1100 };
    expect(apply({ deltaX: 100 })).toEqual(panned);
    expect(apply({ deltaY: 100, shiftKey: true }, { pointerFraction: undefined })).toEqual(panned);
    expect(apply({ deltaX: 100, shiftKey: true })).toEqual(panned);
    expect(apply({ deltaX: 100 }, { overview: true })).toEqual(panned);
    expect(apply({ deltaY: 100, ctrlKey: true }, { overview: true })).toEqual(panned);
    expect(apply({ deltaX: -100 })).toEqual({ start: 300, end: 900 });
    expect(apply({ deltaY: -100 }, { overview: true })).toEqual({ start: 300, end: 900 });
    expect(apply({ deltaX: 100 }, { laneWidth: 300 })).toEqual({ start: 600, end: 1200 });
  });

  it("ignores deltas on the other axis during a locked scroll", () => {
    expect(apply({ deltaX: 15, deltaY: 100 }, { axis: "x" })).toEqual({
      start: 415,
      end: 1015,
    });
    expect(apply({ deltaX: 100, deltaY: 10 }, { axis: "y" })).toEqual(apply({ deltaY: 10 }));
    expect(apply({ deltaY: 100 }, { axis: "x" })).toBe(view);
  });

  it("keeps pans inside the video and respects the zoom bounds", () => {
    expect(apply({ deltaX: -500 })).toEqual({ start: 0, end: 600 });
    expect(apply({ deltaX: 2500 })).toEqual({ start: 2400, end: 3000 });
    const zoomIn = wheelToView({ start: 500, end: 518 }, { ...wheel, deltaY: -100 }, context);
    expect(zoomIn.end - zoomIn.start).toBe(MIN_SPAN);
    expect(apply({ deltaY: 100 }, { totalFrames: 1000 })).toEqual({ start: 100, end: 1000 });
    expect(apply({ deltaY: 100 }, { totalFrames: 800 })).toEqual(fullView(800));
  });
});

describe("lockWheelAxis", () => {
  const dimensions = { laneWidth: 600, pageHeight: 200 };

  it("locks to the first dominant axis until 150 ms after the last event", () => {
    const first = lockWheelAxis(
      undefined,
      { deltaMode: 0, deltaX: 20, deltaY: 4, timeStamp: 0 },
      dimensions,
    );
    expect(first).toEqual({ axis: "x", timeStamp: 0 });

    const second = lockWheelAxis(
      first,
      { deltaMode: 0, deltaX: 0, deltaY: 20, timeStamp: 100 },
      dimensions,
    );
    expect(second).toEqual({ axis: "x", timeStamp: 100 });

    const third = lockWheelAxis(
      second,
      { deltaMode: 0, deltaX: 0, deltaY: 20, timeStamp: 200 },
      dimensions,
    );
    expect(third).toEqual({ axis: "x", timeStamp: 200 });

    expect(
      lockWheelAxis(third, { deltaMode: 0, deltaX: 4, deltaY: 20, timeStamp: 350 }, dimensions),
    ).toEqual({
      axis: "y",
      timeStamp: 350,
    });
  });

  it("waits for a nonzero delta to pick an axis", () => {
    expect(
      lockWheelAxis(undefined, { deltaMode: 0, deltaX: 0, deltaY: 0, timeStamp: 0 }, dimensions),
    ).toBeUndefined();
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

describe("reconcileView", () => {
  it("fits the whole video when the length first becomes known", () => {
    const view = { start: 500, end: 1000 };
    expect(
      reconcileView(view, { frame: 0, totalFrames: 0 }, { frame: 0, totalFrames: 600 }),
    ).toEqual({ start: 0, end: 600 });
  });

  it("keeps the zoom when the known length gets shorter", () => {
    const view = { start: 500, end: 600 };
    expect(
      reconcileView(view, { frame: 0, totalFrames: 600 }, { frame: 0, totalFrames: 580 }),
    ).toEqual({ start: 480, end: 580 });
  });

  it("fits the video when the view is wider than the new bounds", () => {
    const view = { start: 0, end: 600 };
    expect(
      reconcileView(view, { frame: 0, totalFrames: 600 }, { frame: 0, totalFrames: 580 }),
    ).toEqual({ start: 0, end: 580 });
  });

  it("returns the original view object when the length grows", () => {
    const view = { start: 500, end: 600 };
    expect(
      reconcileView(view, { frame: 0, totalFrames: 600 }, { frame: 0, totalFrames: 800 }),
    ).toBe(view);
  });

  it("applies the new bounds before following a changed playhead", () => {
    const view = { start: 800, end: 1000 };
    const previous = { frame: 999, totalFrames: 1000 };
    expect(reconcileView(view, previous, { frame: 550, totalFrames: 600 })).toEqual({
      start: 400,
      end: 600,
    });
    expect(reconcileView(view, previous, { frame: 300, totalFrames: 600 })).toEqual({
      start: 120,
      end: 320,
    });
  });
});
