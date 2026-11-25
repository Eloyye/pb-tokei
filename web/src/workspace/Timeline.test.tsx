// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaySegment } from "../api/client";
import { Timeline } from "./Timeline";

afterEach(cleanup);

const SEGMENTS: PlaySegment[] = [{ start_frame: 450, end_frame: 750, camera_view: "main" }];

type TimelineProps = Parameters<typeof Timeline>[0];
type Playback = Pick<TimelineProps, "frame" | "playing">;

function renderTimeline(playback: Playback = { frame: 800, playing: false }) {
  const onViewChange = vi.fn<TimelineProps["onViewChange"]>();
  const onSeek = vi.fn<TimelineProps["onSeek"]>();
  const onMoveEdge = vi.fn<TimelineProps["onMoveEdge"]>();
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
        frame={frame}
        totalFrames={3000}
        playing={playing}
        onSeek={onSeek}
        onZoom={onZoom}
        focused={false}
        segments={SEGMENTS}
        pending={null}
        editableSegments
        onMoveEdge={onMoveEdge}
      />
    );
  }

  const { container, rerender } = render(<TimelineHarness {...playback} />);
  const ruler = container.querySelector<HTMLElement>(".ruler")!;
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 100, width: 600, height: 22 }),
  );
  return {
    container,
    ruler,
    scrubLayer: container.querySelector<HTMLElement>(".playhead-layer")!,
    endHandle: container.querySelector<HTMLElement>(".seg-handle.end")!,
    onViewChange,
    onSeek,
    onMoveEdge,
    rerenderPlayback: (next: Playback) => rerender(<TimelineHarness {...next} />),
  };
}

function wheelEvent({ timeStamp, ...init }: WheelEventInit & { timeStamp?: number }) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent omits the MouseEvent fields.
  Object.defineProperties(event, {
    clientX: { value: init.clientX ?? 0 },
    ctrlKey: { value: init.ctrlKey ?? false },
    shiftKey: { value: init.shiftKey ?? false },
    timeStamp: { value: timeStamp ?? event.timeStamp },
  });
  return event;
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
