// @vitest-environment happy-dom
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Game, PlaySegment } from "../api/client";
import { NO_SELECTION, type Selection, toggleRally, toggleShot } from "../lib/annotate";
import { newRally, newShot, numberShots, observed } from "../lib/rallyLog";
import { ROSTER } from "../lib/testRoster";
import { wheelEvent } from "../test/wheelEvent";
import { Timeline, type TimelineRallies } from "./Timeline";

afterEach(cleanup);

const SEGMENTS: PlaySegment[] = [{ start_frame: 450, end_frame: 750, camera_view: "main" }];

type TimelineProps = Parameters<typeof Timeline>[0];
type Playback = Pick<TimelineProps, "frame" | "playing">;

function renderTimeline(
  playback: Playback = { frame: 800, playing: false },
  { rallyLog, totalFrames = 3000 }: Partial<Pick<TimelineProps, "rallyLog" | "totalFrames">> = {},
) {
  const onViewChange = vi.fn<TimelineProps["onViewChange"]>();
  const onPanningChange = vi.fn<NonNullable<TimelineProps["onPanningChange"]>>();
  const onSeek = vi.fn<TimelineProps["onSeek"]>();
  const onMoveEdge = vi.fn<TimelineProps["onMoveEdge"]>();
  const onPreviewEdge = vi.fn<TimelineProps["onPreviewEdge"]>();
  const onSelectSegment = vi.fn<NonNullable<TimelineProps["onSelectSegment"]>>();
  const onZoom = vi.fn<TimelineProps["onZoom"]>();

  function TimelineHarness({ frame, playing }: Playback) {
    const [view, setView] = useState({ start: 400, end: 1000 });
    return (
      <Timeline
        view={view}
        onViewChange={(next) => {
          onViewChange(next);
          setView(next);
        }}
        onPanningChange={onPanningChange}
        frame={frame}
        totalFrames={totalFrames}
        playing={playing}
        onSeek={onSeek}
        onZoom={onZoom}
        focused={false}
        segments={SEGMENTS}
        onSelectSegment={onSelectSegment}
        pending={null}
        onMoveEdge={onMoveEdge}
        onPreviewEdge={onPreviewEdge}
        rallyLog={rallyLog}
      />
    );
  }

  const { container, rerender } = render(<TimelineHarness {...playback} />);
  const ruler = container.querySelector<HTMLElement>(".ruler")!;
  const overview = container.querySelector<HTMLElement>(".overview")!;
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 100, width: 600, height: 22 }),
  );
  vi.spyOn(overview, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 300 }));
  return {
    container,
    ruler,
    overview,
    scrubLayer: ruler,
    endHandle: container.querySelector<HTMLElement>(".seg-handle.end")!,
    onViewChange,
    onPanningChange,
    onSeek,
    onMoveEdge,
    onPreviewEdge,
    onSelectSegment,
    rerenderPlayback: (next: Playback) => rerender(<TimelineHarness {...next} />),
  };
}

describe("Timeline wheel input", () => {
  it("cancels a pinch on the Timeline body and preserves the playhead and focus", () => {
    const { ruler, onViewChange, onSeek } = renderTimeline();
    const toolbarButton = screen.getByRole("button", { name: "Zoom in" });
    toolbarButton.focus();

    const pinch = wheelEvent({ clientX: 250, deltaY: -100, ctrlKey: true });
    const preventDefault = vi.spyOn(pinch, "preventDefault");
    fireEvent(ruler, pinch);

    expect(preventDefault).toHaveBeenCalled();
    expect(pinch.defaultPrevented).toBe(true);
    expect(onViewChange).toHaveBeenCalledWith({ start: 450, end: 850 });
    expect(onSeek).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(toolbarButton);

    const outside = wheelEvent({ deltaY: 100 });
    fireEvent(toolbarButton, outside);
    expect(outside.defaultPrevented).toBe(false);
    expect(onViewChange).toHaveBeenCalledTimes(1);
  });

  it("accumulates wheel deltas received before the next render", () => {
    const { ruler, onViewChange } = renderTimeline();
    act(() => {
      fireEvent(ruler, wheelEvent({ clientX: 250, deltaX: 60 }));
      fireEvent(ruler, wheelEvent({ clientX: 250, deltaX: 60 }));
    });
    expect(onViewChange).toHaveBeenLastCalledWith({ start: 520, end: 1120 });
  });

  it("pans when scrolling on the Overview bar", () => {
    const { onViewChange } = renderTimeline();
    const overview = screen.getByRole("button", { name: "Centre the Timeline view here" });
    fireEvent(overview, wheelEvent({ clientX: 250, deltaY: -100 }));
    expect(onViewChange).toHaveBeenCalledWith({ start: 300, end: 900 });
  });

  it.each([
    { selector: ".track-head", playing: false },
    { selector: ".timeline-timecode", playing: false },
    { selector: ".ruler", playing: true },
  ])("zooms at the playhead on $selector (playing: $playing)", ({ selector, playing }) => {
    const { container, onViewChange } = renderTimeline({ frame: 800, playing });
    const target = container.querySelector<HTMLElement>(selector)!;
    // Use the same x for each target so this checks the event target and playback state.
    fireEvent(target, wheelEvent({ clientX: 250, deltaY: -100 }));
    expect(onViewChange).toHaveBeenCalledWith({
      start: expect.closeTo(533.333),
      end: expect.closeTo(933.333),
    });
  });

  it("locks a diagonal scroll to pan and still accepts a Ctrl pinch", () => {
    const { ruler, onViewChange } = renderTimeline();
    fireEvent(ruler, wheelEvent({ clientX: 250, deltaX: 20, deltaY: 4, timeStamp: 10 }));
    fireEvent(ruler, wheelEvent({ clientX: 250, deltaY: 20, timeStamp: 110 }));
    expect(onViewChange.mock.calls).toEqual([[{ start: 420, end: 1020 }]]);

    fireEvent(ruler, wheelEvent({ clientX: 250, deltaY: -100, ctrlKey: true, timeStamp: 135 }));
    expect(onViewChange).toHaveBeenNthCalledWith(2, { start: 470, end: 870 });
  });

  it("reapplies an active scrub to the panned view and stops on release", () => {
    const { scrubLayer, onSeek } = renderTimeline();
    fireEvent.pointerDown(scrubLayer, { pointerId: 1, clientX: 400 });
    expect(onSeek).toHaveBeenLastCalledWith(700);

    fireEvent(scrubLayer, wheelEvent({ clientX: 400, deltaX: 60 }));
    expect(onSeek).toHaveBeenLastCalledWith(760);

    fireEvent.pointerUp(scrubLayer, { pointerId: 1, clientX: 400 });
    fireEvent(scrubLayer, wheelEvent({ clientX: 400, deltaX: 60 }));
    expect(onSeek).toHaveBeenCalledTimes(2);
  });

  it("re-seeks to the scrub frame if playback has advanced", () => {
    const { scrubLayer, onSeek, rerenderPlayback } = renderTimeline({ frame: 700, playing: true });
    fireEvent.pointerDown(scrubLayer, { pointerId: 1, clientX: 400 });
    expect(onSeek).toHaveBeenCalledExactlyOnceWith(700);

    rerenderPlayback({ frame: 701, playing: true });
    // This pan changes the view by less than a frame, so the scrub target is still 700.
    fireEvent(scrubLayer, wheelEvent({ clientX: 400, deltaX: 0.5 }));
    expect(onSeek.mock.calls).toEqual([[700], [700]]);
  });

  it("commits the segment edge at the new pointer frame after a pan", () => {
    const { endHandle, onMoveEdge } = renderTimeline();
    fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 450 });

    act(() => {
      fireEvent(endHandle, wheelEvent({ clientX: 450, deltaX: 60 }));
      expect(onMoveEdge).not.toHaveBeenCalled();
      fireEvent.pointerUp(endHandle, { pointerId: 1, clientX: 450 });
    });
    expect(onMoveEdge).toHaveBeenCalledWith(450, "end", 810);
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "discards a segment edge preview on %s",
    (cancelEvent) => {
      const { endHandle, onMoveEdge } = renderTimeline();
      const segment = endHandle.closest<HTMLElement>(".seg")!;
      const originalWidth = Number.parseFloat(segment.style.width);
      fireEvent.pointerDown(endHandle, { pointerId: 1, clientX: 450 });
      fireEvent(endHandle, wheelEvent({ clientX: 450, deltaX: 60 }));
      expect(Number.parseFloat(segment.style.width)).toBeCloseTo(originalWidth + 10);

      fireEvent[cancelEvent](endHandle, { pointerId: 1 });
      expect(Number.parseFloat(segment.style.width)).toBeCloseTo(originalWidth);
      fireEvent.pointerUp(endHandle, { pointerId: 1, clientX: 450 });
      expect(onMoveEdge).not.toHaveBeenCalled();
    },
  );
});

function renderRallies(selection = NO_SELECTION) {
  const onSelectRally = vi.fn<TimelineRallies["onSelectRally"]>();
  const onMoveRallyEdge = vi.fn<TimelineRallies["onMoveRallyEdge"]>();
  const onSelectEntry = vi.fn<TimelineRallies["onSelectEntry"]>();
  const onMoveContact = vi.fn<TimelineRallies["onMoveContact"]>();
  const log: TimelineRallies = {
    roster: ROSTER,
    selection,
    games: [
      {
        number: 1,
        rallies: [
          numberShots({
            ...newRally(1, 450),
            end_frame: 600,
            entries: [newShot(480), newShot(550)],
          }),
          newRally(2, 700),
          newRally(3),
        ],
      },
    ],
    onSelectRally,
    onMoveRallyEdge,
    onSelectEntry,
    onMoveContact,
    onFitRally: vi.fn<TimelineRallies["onFitRally"]>(),
  };
  const timeline = renderTimeline(undefined, { rallyLog: log });
  const clip = screen.getByTitle("Game 1 Rally 1: frames 450–600");
  return { ...timeline, clip, onSelectRally, onMoveRallyEdge, onSelectEntry, onMoveContact };
}

describe("Timeline middle-button pan", () => {
  const press = { pointerId: 1, button: 1, buttons: 4, clientX: 200 };
  const move = { pointerId: 1, buttons: 4, clientX: 260 };
  const release = { pointerId: 1, button: 1, buttons: 0, clientX: 260 };

  it.each([
    ".ruler",
    ".lane.segments",
    ".lane.rallies",
    ".lane.shots",
    ".lane.issues",
    ".timeline-fill",
    ".seg",
    ".seg .seg-handle",
    ".clip",
    ".clip .seg-handle",
    ".pin",
  ])("grabs the Timeline from %s without scrubbing or editing", (selector) => {
    const timeline = renderRallies();
    const target = timeline.container.querySelector<HTMLElement>(selector)!;
    const surface = target.closest<HTMLElement>(".ruler, .lane, .timeline-fill")!;

    fireEvent.pointerDown(target, press);
    expect(surface.hasPointerCapture(press.pointerId)).toBe(true);
    expect(timeline.onViewChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(surface, move);
    fireEvent.pointerUp(surface, release);

    expect(timeline.onViewChange).toHaveBeenCalledExactlyOnceWith({ start: 340, end: 940 });
    expect(timeline.onSeek).not.toHaveBeenCalled();
    expect(timeline.onSelectSegment).not.toHaveBeenCalled();
    expect(timeline.onSelectRally).not.toHaveBeenCalled();
    expect(timeline.onSelectEntry).not.toHaveBeenCalled();
    expect(timeline.onPreviewEdge).not.toHaveBeenCalled();
    expect(timeline.onMoveEdge).not.toHaveBeenCalled();
    expect(timeline.onMoveRallyEdge).not.toHaveBeenCalled();
    expect(timeline.onMoveContact).not.toHaveBeenCalled();
  });

  it("moves the Overview window with the cursor at the full-video scale", () => {
    const { overview, onViewChange, onSeek } = renderTimeline();
    const button = screen.getByRole("button", { name: "Centre the Timeline view here" });

    fireEvent.pointerDown(button, press);
    expect(overview.hasPointerCapture(press.pointerId)).toBe(true);
    fireEvent.pointerMove(overview, move);
    fireEvent.pointerUp(overview, release);

    expect(onViewChange).toHaveBeenCalledExactlyOnceWith({ start: 1000, end: 1600 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("reveals later frames when dragging a lane to the left", () => {
    const { container, onViewChange } = renderTimeline();
    const lane = container.querySelector<HTMLElement>(".lane.segments")!;
    fireEvent.pointerDown(lane, press);
    fireEvent.pointerMove(lane, { ...move, clientX: 140 });
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith({ start: 460, end: 1060 });
  });

  it.each([
    { selector: ".lane.segments", pastStartX: 700, pastEndX: -2300 },
    { selector: ".overview", pastStartX: 100, pastEndX: 800 },
  ])("clamps a pan on $selector to both video bounds", ({ selector, pastStartX, pastEndX }) => {
    const { container, onViewChange } = renderTimeline();
    const surface = container.querySelector<HTMLElement>(selector)!;

    fireEvent.pointerDown(surface, press);
    fireEvent.pointerMove(surface, { ...move, clientX: pastStartX });
    expect(onViewChange).toHaveBeenLastCalledWith({ start: 0, end: 600 });
    fireEvent.pointerMove(surface, { ...move, clientX: pastEndX });
    expect(onViewChange).toHaveBeenLastCalledWith({ start: 2400, end: 3000 });
  });

  it("cancels middle-click defaults and leaves the view alone without horizontal motion", () => {
    const { ruler, onViewChange, onSeek, onSelectSegment } = renderTimeline();
    const pointerDown = createEvent.pointerDown(ruler, press);
    const mouseDown = createEvent.mouseDown(ruler, press);
    const auxClick = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });

    fireEvent(ruler, pointerDown);
    fireEvent(ruler, mouseDown);
    fireEvent.pointerMove(ruler, { ...move, clientX: press.clientX, clientY: 10 });
    fireEvent.pointerUp(ruler, { ...release, clientX: press.clientX });
    fireEvent(ruler, auxClick);

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(auxClick.defaultPrevented).toBe(true);
    expect(onViewChange).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
    expect(onSelectSegment).not.toHaveBeenCalled();
  });

  it("accumulates movement before React commits the next view", () => {
    const { ruler, onViewChange } = renderTimeline();
    fireEvent.pointerDown(ruler, press);
    act(() => {
      fireEvent.pointerMove(ruler, move);
      fireEvent.pointerMove(ruler, { ...move, clientX: 320 });
    });
    expect(onViewChange).toHaveBeenLastCalledWith({ start: 280, end: 880 });
  });

  it("preserves an active scrub when a second pointer presses the middle button", () => {
    const { ruler, onPanningChange, onSeek, onViewChange } = renderTimeline();
    fireEvent.pointerDown(ruler, { pointerId: 2, buttons: 1, clientX: 200 });

    const middleDown = createEvent.pointerDown(ruler, press);
    fireEvent(ruler, middleDown);
    fireEvent.pointerMove(ruler, move);
    expect(middleDown.defaultPrevented).toBe(true);
    expect(ruler.hasPointerCapture(press.pointerId)).toBe(false);
    expect(onPanningChange).not.toHaveBeenCalled();
    expect(onViewChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(ruler, { pointerId: 2, buttons: 1, clientX: 260 });
    expect(onSeek.mock.calls).toEqual([[500], [560]]);
  });

  it("prevents the middle-click default with no video loaded", () => {
    const { ruler, onPanningChange, onSeek, onViewChange } = renderTimeline(undefined, {
      totalFrames: 0,
    });
    const middleDown = createEvent.pointerDown(ruler, press);

    fireEvent(ruler, middleDown);
    fireEvent.pointerMove(ruler, move);
    expect(middleDown.defaultPrevented).toBe(true);
    expect(ruler.hasPointerCapture(press.pointerId)).toBe(false);
    expect(onPanningChange).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it.each(["pointerUp", "pointerCancel", "lostPointerCapture"] as const)(
    "ends the pan on %s for the captured pointer",
    (finishEvent) => {
      const { ruler, onPanningChange, onViewChange } = renderTimeline();
      fireEvent.pointerDown(ruler, press);
      fireEvent[finishEvent](ruler, { ...release, pointerId: 2 });
      expect(onPanningChange.mock.calls).toEqual([[true]]);

      fireEvent[finishEvent](ruler, release);
      fireEvent.pointerMove(ruler, move);
      expect(onPanningChange.mock.calls).toEqual([[true], [false]]);
      expect(onViewChange).not.toHaveBeenCalled();
    },
  );

  it("ends the pan when the middle button is released while the left is still held", () => {
    const { ruler, onPanningChange, onViewChange } = renderTimeline();
    fireEvent.pointerDown(ruler, press);
    fireEvent.pointerMove(ruler, { ...move, button: 1, buttons: 1 });
    expect(onPanningChange.mock.calls).toEqual([[true], [false]]);
    expect(ruler.hasPointerCapture(press.pointerId)).toBe(false);
    expect(onViewChange).not.toHaveBeenCalled();
  });
});

describe("Timeline Rally edge drags", () => {
  it("previews the clamped edge in both tracks and commits once without seeking", () => {
    const { clip, container, onMoveRallyEdge, onPreviewEdge, onSelectRally, onSeek } =
      renderRallies();
    const handle = clip.querySelector(".seg-handle.start")!;
    const overview = container.querySelector<HTMLElement>(".ov-block")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 210 });

    expect(Number.parseFloat(clip.style.left)).toBeCloseTo((80 / 600) * 100);
    expect(overview.style.left).toBe("16%");
    expect(onPreviewEdge).toHaveBeenLastCalledWith(510, "Stopped at Shot 1's contact (frame 480)");
    expect(onSelectRally).toHaveBeenCalledExactlyOnceWith(0, 0, "edge-drag");
    expect(onMoveRallyEdge).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 210 });
    fireEvent.click(handle);
    expect(onPreviewEdge).toHaveBeenLastCalledWith(null, null);
    expect(onMoveRallyEdge).toHaveBeenCalledExactlyOnceWith(0, 0, "start", 480);
    expect(onSelectRally).toHaveBeenCalledTimes(1);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("selects on a plain click at the clip's edge", () => {
    const { clip, onMoveRallyEdge, onPreviewEdge, onSelectRally } = renderRallies();
    const handle = clip.querySelector(".seg-handle.start")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 150 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 150 });
    fireEvent.click(handle);

    expect(onSelectRally).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(onMoveRallyEdge).not.toHaveBeenCalled();
    expect(onPreviewEdge).not.toHaveBeenCalled();
  });

  it("recalculates the frame after wheel pan and zoom without reselecting the Rally", () => {
    const { clip, onMoveRallyEdge, onPreviewEdge, onSelectRally } = renderRallies({
      game: 0,
      rally: 0,
      entry: 1,
    });
    const handle = clip.querySelector(".seg-handle.end")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 301 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 330 });

    fireEvent(handle, wheelEvent({ clientX: 330, deltaX: 30 }));
    expect(onPreviewEdge).toHaveBeenLastCalledWith(660, null);
    fireEvent(handle, wheelEvent({ clientX: 330, deltaY: -100, ctrlKey: true }));
    expect(onPreviewEdge).toHaveBeenLastCalledWith(660, null);

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 330 });
    expect(onMoveRallyEdge).toHaveBeenCalledExactlyOnceWith(0, 0, "end", 660);
    expect(onSelectRally).not.toHaveBeenCalled();
  });

  it("renders a start handle for an open-ended Rally and omits Unseen Rallies", () => {
    const { container } = renderRallies();
    const open = screen.getByTitle("Game 1 Rally 2: frames 700–open");
    expect(open.querySelector(".seg-handle.start")).toBeTruthy();
    expect(open.querySelector(".seg-handle.end")).toBeNull();
    expect(container.querySelectorAll(".clip")).toHaveLength(2);
  });
});

function sampleGames(): Game[] {
  return [
    {
      number: 1,
      rallies: [
        numberShots({
          ...newRally(1, 100),
          end_frame: 400,
          serving_team_id: observed("A"),
          entries: [
            { ...newShot(150), hitter_id: observed("a1") },
            { ...newShot(220), hitter_id: observed("b1") },
          ],
        }),
      ],
    },
  ];
}

function renderInteractiveTimeline(initialSelection: Selection = { game: 0, rally: 0, entry: 0 }) {
  const games = sampleGames();
  const onSelectEntry = vi.fn<TimelineRallies["onSelectEntry"]>();
  const onSelectRally = vi.fn<TimelineRallies["onSelectRally"]>();
  const onMoveContact = vi.fn<TimelineRallies["onMoveContact"]>();

  function Harness() {
    const [view, setView] = useState({ start: 0, end: 1000 });
    const [selection, setSelection] = useState<Selection>(initialSelection);
    return (
      <Timeline
        view={view}
        onViewChange={setView}
        frame={150}
        totalFrames={3000}
        playing={false}
        onSeek={vi.fn<() => void>()}
        onZoom={vi.fn<() => void>()}
        focused={false}
        segments={[]}
        pending={null}
        onMoveEdge={vi.fn<() => void>()}
        onPreviewEdge={vi.fn<() => void>()}
        rallyLog={{
          games,
          selection,
          roster: ROSTER,
          onSelectRally: (gi, ri, mode) => {
            onSelectRally(gi, ri, mode);
            setSelection((cur) => toggleRally(games, cur, gi, ri));
          },
          onMoveRallyEdge: vi.fn<TimelineRallies["onMoveRallyEdge"]>(),
          onSelectEntry: (gi, ri, ei) => {
            onSelectEntry(gi, ri, ei);
            setSelection((cur) => toggleShot(cur, gi, ri, ei));
          },
          onMoveContact,
          onFitRally: vi.fn<() => void>(),
        }}
      />
    );
  }

  const result = render(<Harness />);
  const ruler = result.container.querySelector<HTMLElement>(".ruler")!;
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, width: 1000, height: 22 }),
  );
  return { ...result, onSelectEntry, onSelectRally, onMoveContact };
}

describe("Timeline Shot pin selection and drag", () => {
  it("deselects the selected Shot pin on click (and ignores tiny pointer jitter)", () => {
    const { container, onSelectEntry, onMoveContact } = renderInteractiveTimeline();
    const pin = screen.getByRole("button", { name: "Shot 1 at frame 150" });
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(pin.className).toContain("on");

    fireEvent.pointerDown(pin, { pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 152 });
    fireEvent.pointerUp(pin, { pointerId: 1, clientX: 152 });

    expect(onSelectEntry).toHaveBeenCalledExactlyOnceWith(0, 0, 0);
    expect(onMoveContact).not.toHaveBeenCalled();
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(pin.className).not.toContain("on");
    // Rally clip stays selected.
    expect(container.querySelector(".clip.on")).toBeTruthy();
  });

  it("fires only onMoveContact when dragging the selected Shot pin, without deselecting it", () => {
    const { onSelectEntry, onMoveContact } = renderInteractiveTimeline();
    const pin = screen.getByRole("button", { name: "Shot 1 at frame 150" });

    fireEvent.pointerDown(pin, { pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 190 });
    fireEvent.pointerUp(pin, { pointerId: 1, clientX: 190 });

    expect(onMoveContact).toHaveBeenCalledExactlyOnceWith(0, 0, 0, 190);
    expect(onSelectEntry).not.toHaveBeenCalled();
    expect(pin.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not deselect when dragging the selected pin away and back to its original frame", () => {
    const { onSelectEntry, onMoveContact } = renderInteractiveTimeline();
    const pin = screen.getByRole("button", { name: "Shot 1 at frame 150" });

    fireEvent.pointerDown(pin, { pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 190 });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 150 });
    fireEvent.pointerUp(pin, { pointerId: 1, clientX: 150 });

    expect(onMoveContact).not.toHaveBeenCalled();
    expect(onSelectEntry).not.toHaveBeenCalled();
    expect(pin.getAttribute("aria-pressed")).toBe("true");
  });

  it("deselects the selected Rally clip and its Shot when clicked again", () => {
    const { container, onSelectRally } = renderInteractiveTimeline();
    const clip = container.querySelector<HTMLButtonElement>(".clip.on")!;
    fireEvent.click(clip);

    expect(onSelectRally).toHaveBeenCalledExactlyOnceWith(0, 0, undefined);
    expect(container.querySelector(".clip.on")).toBeNull();
    expect(container.querySelector(".pin.on")).toBeNull();
  });

  it("moves contact without deselecting when wheel panning changes the frame under a held pin", () => {
    const { onSelectEntry, onMoveContact } = renderInteractiveTimeline();
    const pin = screen.getByRole("button", { name: "Shot 1 at frame 150" });

    fireEvent.pointerDown(pin, { pointerId: 1, clientX: 150 });
    act(() => {
      fireEvent(pin, wheelEvent({ clientX: 150, deltaX: 60 }));
      fireEvent.pointerUp(pin, { pointerId: 1, clientX: 150 });
    });

    expect(onMoveContact).toHaveBeenCalledExactlyOnceWith(0, 0, 0, 210);
    expect(onSelectEntry).not.toHaveBeenCalled();
    expect(pin.getAttribute("aria-pressed")).toBe("true");
  });

  it("still resolves as a click when a wheel event leaves the held pin on its original frame", () => {
    const { onSelectEntry, onMoveContact } = renderInteractiveTimeline();
    const pin = screen.getByRole("button", { name: "Shot 1 at frame 150" });

    fireEvent.pointerDown(pin, { pointerId: 1, clientX: 150 });
    act(() => {
      // Zooming centered on the pin's frame (x = 150 -> frame 150) keeps target === drag.from.
      fireEvent(pin, wheelEvent({ clientX: 150, deltaY: -100, ctrlKey: true }));
      fireEvent.pointerUp(pin, { pointerId: 1, clientX: 150 });
    });

    expect(onMoveContact).not.toHaveBeenCalled();
    expect(onSelectEntry).toHaveBeenCalledExactlyOnceWith(0, 0, 0);
    expect(pin.getAttribute("aria-pressed")).toBe("false");
  });
});
