import { describe, expect, it } from "vitest";
import type { Calibration, CameraView, PlaySegment } from "../api/client";
import {
  defaultView,
  followStart,
  markIn,
  markOut,
  moveEdge,
  type PendingSegment,
  removeAt,
  segmentAt,
  setCameraView,
} from "./segments";

function seg(start: number, end: number, view: CameraView = "main"): PlaySegment {
  return { start_frame: start, end_frame: end, camera_view: view };
}

function pending(start: number, view: CameraView = "main"): PendingSegment {
  return { start, camera_view: view };
}

function cal(view: CameraView, from: number): Calibration {
  return {
    camera_view: view,
    effective_from_frame: from,
    reference_frame: from + 10,
    landmarks: {},
  };
}

const MAIN = seg(100, 199);
const SIDE = seg(300, 399, "sideline");
const SEGMENTS = [MAIN, SIDE];

describe("segmentAt", () => {
  it("includes both end frames", () => {
    expect(segmentAt(SEGMENTS, 100)).toBe(MAIN);
    expect(segmentAt(SEGMENTS, 199)).toBe(MAIN);
    expect(segmentAt(SEGMENTS, 200)).toBeUndefined();
  });
});

describe("defaultView", () => {
  it("takes the view of the nearest segment before, or Main View", () => {
    expect(defaultView(SEGMENTS, 50)).toBe("main");
    expect(defaultView(SEGMENTS, 250)).toBe("main");
    expect(defaultView(SEGMENTS, 500)).toBe("sideline");
  });
});

describe("markIn", () => {
  it("opens a pending segment outside every segment, in the inherited view", () => {
    const edit = markIn(SEGMENTS, null, 450);

    expect(edit.segments).toBe(SEGMENTS);
    expect(edit.pending).toEqual({ start: 450, camera_view: "sideline" });
  });

  it("moves the start of the segment under the playhead", () => {
    const edit = markIn(SEGMENTS, null, 150);

    expect(edit.segments).toEqual([seg(150, 199), SIDE]);
    expect(edit.startMoved).toEqual({ from: 100, to: 150, camera_view: "main" });
  });

  it("changes nothing on a segment's own first frame", () => {
    const edit = markIn(SEGMENTS, null, 100);

    expect(edit.segments).toBe(SEGMENTS);
    expect(edit.startMoved).toBeNull();
  });
});

describe("markOut", () => {
  it("ends the pending segment at the playhead", () => {
    const edit = markOut(SEGMENTS, pending(220, "sideline"), 260);

    expect(edit.segments).toEqual([MAIN, seg(220, 260, "sideline"), SIDE]);
    expect(edit.pending).toBeNull();
  });

  it("allows a one-frame segment", () => {
    expect(markOut([], pending(5), 5).segments).toEqual([seg(5, 5)]);
  });

  it("works backwards when the playhead is before the pending start", () => {
    expect(markOut(SEGMENTS, pending(260), 220).segments).toContainEqual(seg(220, 260));
  });

  it("stops at a neighbour instead of overlapping it", () => {
    const forward = markOut(SEGMENTS, pending(220), 350);
    const backward = markOut(SEGMENTS, pending(280), 150);

    expect(forward.segments).toContainEqual(seg(220, 299));
    expect(forward.message).toMatch(/Stopped/);
    expect(backward.segments).toContainEqual(seg(200, 280));
  });

  it("moves the end of the segment under the playhead when nothing is pending", () => {
    expect(markOut(SEGMENTS, null, 150).segments).toEqual([seg(100, 150), SIDE]);
  });

  it("does nothing outside segments with nothing pending", () => {
    const edit = markOut(SEGMENTS, null, 250);

    expect(edit.segments).toBe(SEGMENTS);
    expect(edit.message).toMatch(/Shift\+I/);
  });

  it("drops a pending start that a later edit put inside a segment", () => {
    const edit = markOut(SEGMENTS, pending(150), 180);

    expect(edit.segments).toBe(SEGMENTS);
    expect(edit.pending).toBeNull();
  });
});

describe("moveEdge", () => {
  it("moves a start earlier, up to the previous segment", () => {
    const edit = moveEdge(SEGMENTS, null, 300, "start", 50);

    expect(edit.segments).toEqual([MAIN, seg(200, 399, "sideline")]);
    expect(edit.startMoved).toEqual({ from: 300, to: 200, camera_view: "sideline" });
    expect(edit.message).toMatch(/Stopped at the next Play Segment/);
  });

  it("moves an end later, up to the next segment", () => {
    expect(moveEdge(SEGMENTS, null, 100, "end", 1000).segments).toEqual([seg(100, 299), SIDE]);
  });

  it("never lets a segment end before it starts", () => {
    const edit = moveEdge(SEGMENTS, null, 100, "start", 250);

    expect(edit.segments).toEqual([seg(199, 199), SIDE]);
    expect(edit.message).toMatch(/can't end before it starts/);
  });

  it("keeps the first segment from starting before frame 0", () => {
    expect(moveEdge(SEGMENTS, null, 100, "start", -40).segments[0]).toEqual(seg(0, 199));
  });

  it("keeps the pending segment", () => {
    const open = pending(600);

    expect(moveEdge(SEGMENTS, open, 100, "end", 120).pending).toBe(open);
  });
});

describe("setCameraView", () => {
  it("sets the pending segment's view first", () => {
    const edit = setCameraView(SEGMENTS, { start: 600, camera_view: "main" }, 150, "sideline");

    expect(edit.pending?.camera_view).toBe("sideline");
    expect(edit.segments).toBe(SEGMENTS);
  });

  it("sets the view of the segment under the playhead", () => {
    expect(setCameraView(SEGMENTS, null, 150, "sideline").segments).toEqual([
      seg(100, 199, "sideline"),
      SIDE,
    ]);
  });

  it("leaves the segments alone when the view is already set", () => {
    expect(setCameraView(SEGMENTS, null, 150, "main").segments).toBe(SEGMENTS);
  });
});

describe("removeAt", () => {
  it("removes the segment under the playhead only", () => {
    expect(removeAt(SEGMENTS, null, 350).segments).toEqual([MAIN]);
    expect(removeAt(SEGMENTS, null, 250).segments).toBe(SEGMENTS);
  });
});

describe("followStart", () => {
  it("moves a Calibration that began where its segment started", () => {
    const calibrations = [cal("main", 100), cal("sideline", 100), cal("main", 900)];

    expect(followStart(calibrations, { from: 100, to: 80, camera_view: "main" })).toEqual([
      { ...cal("main", 100), effective_from_frame: 80 },
      cal("sideline", 100),
      cal("main", 900),
    ]);
  });

  it("leaves it if another of its view already starts at the new frame", () => {
    const calibrations = [cal("main", 100), cal("main", 80)];

    expect(followStart(calibrations, { from: 100, to: 80, camera_view: "main" })).toBe(
      calibrations,
    );
  });
});
