// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaySegment } from "../api/client";
import { Timeline } from "./Timeline";

afterEach(cleanup);

const SEGMENTS: PlaySegment[] = [{ start_frame: 450, end_frame: 750, camera_view: "main" }];

type TimelineProps = Parameters<typeof Timeline>[0];

function renderTimeline() {
  const onViewChange = vi.fn<TimelineProps["onViewChange"]>();
  const onSeek = vi.fn<TimelineProps["onSeek"]>();
  const onMoveEdge = vi.fn<TimelineProps["onMoveEdge"]>();
  const onZoom = vi.fn<TimelineProps["onZoom"]>();

  function TimelineHarness() {
    const [view, setView] = useState({ start: 400, end: 1000 });
    return (
      <Timeline
        view={view}
        onViewChange={(next) => {
          onViewChange(next);
          setView(next);
        }}
        frame={800}
        totalFrames={3000}
        playing={false}
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

  const { container } = render(<TimelineHarness />);
  const ruler = container.querySelector<HTMLElement>(".ruler")!;
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 100, width: 600, height: 22 }),
  );
  return {
    ruler,
    scrubLayer: container.querySelector<HTMLElement>(".playhead-layer")!,
    endHandle: container.querySelector<HTMLElement>(".seg-handle.end")!,
    onViewChange,
    onSeek,
    onMoveEdge,
  };
}

function wheelEvent(init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  // happy-dom's WheelEvent omits the MouseEvent fields.
  Object.defineProperties(event, {
    clientX: { value: init.clientX ?? 0 },
    ctrlKey: { value: init.ctrlKey ?? false },
    shiftKey: { value: init.shiftKey ?? false },
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
});
