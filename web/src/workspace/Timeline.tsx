import { type PointerEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import type { PlaySegment, UnmappedRangeOut } from "../api/client";
import { clampFrame, formatTimecode } from "../lib/frames";
import { describe, moveEdge, type PendingSegment, VIEW_LABELS } from "../lib/segments";
import {
  centreOn,
  type FrameRange,
  frameAt,
  fullView,
  lockWheelAxis,
  rulerTicks,
  toPercent,
  type WheelAxisLock,
  wheelToView,
} from "../lib/timeline";
import { Icon } from "./icons";
import { Panel, PanelTitle } from "./Panel";

const TRACKS = [
  { id: "segments", label: "Segments", empty: "No Play Segments marked" },
  { id: "rallies", label: "Rallies", empty: "No Rallies yet" },
  { id: "shots", label: "Shots", empty: "No Shots yet" },
  { id: "issues", label: "Issues", empty: "" },
] as const;

interface EdgeDrag {
  segmentStart: number;
  edge: "start" | "end";
  frame: number;
}

type TimelineDrag = { pointerId: number; clientX: number } & (
  | { kind: "scrub"; frame: number | null }
  | ({ kind: "edge" } & EdgeDrag)
);

/**
 * The Timeline: an overview of the whole video, a ruler with the playhead, and one lane per
 * track. Dragging on the ruler or the lanes scrubs; the overview moves the view.
 */
export function Timeline({
  view,
  onViewChange,
  frame,
  totalFrames,
  playing,
  onSeek,
  onZoom,
  focused,
  segments,
  unmappedRanges,
  pending,
  editableSegments,
  onMoveEdge,
}: {
  view: FrameRange;
  onViewChange: (view: FrameRange) => void;
  frame: number;
  totalFrames: number;
  playing: boolean;
  onSeek: (frame: number) => void;
  onZoom: (direction: "in" | "out") => void;
  focused: boolean;
  /** The Match's Play Segments in frame order; null until loaded. */
  segments: PlaySegment[] | null;
  /** Stretches inside Play Segments where Camera Motion failed registration. */
  unmappedRanges?: readonly UnmappedRangeOut[];
  /** A segment begun and not yet ended: drawn from its start to the playhead. */
  pending: PendingSegment | null;
  /** Calibrate marks Play Segments, so the Segments track is the one being edited there. */
  editableSegments: boolean;
  onMoveEdge: (segmentStart: number, edge: "start" | "end", frame: number) => void;
}) {
  const whole = fullView(totalFrames);
  const ticks = rulerTicks(view);
  const hasVideo = totalFrames > 0;

  const bodyRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const wheelAxis = useRef<WheelAxisLock | undefined>(undefined);
  const queuedWheelView = useRef<{ from: FrameRange; to: FrameRange } | null>(null);
  const activeDrag = useRef<TimelineDrag | null>(null);
  const [edgePreview, setEdgePreview] = useState<EdgeDrag>();
  const shown =
    segments && edgePreview
      ? moveEdge(segments, null, edgePreview.segmentStart, edgePreview.edge, edgePreview.frame)
          .segments
      : segments;

  // Several wheel events can arrive before React commits the view.
  const currentView = () => {
    const queued = queuedWheelView.current;
    return queued?.from === view ? queued.to : view;
  };

  const applyDrag = (clientX: number, nextView: FrameRange, rect: DOMRect) => {
    const drag = activeDrag.current;
    if (!drag || rect.width <= 0) return;
    const target = clampFrame(frameAt(nextView, (clientX - rect.left) / rect.width), totalFrames);
    const next = { ...drag, clientX, frame: target };
    activeDrag.current = next;
    if (next.kind === "edge") {
      if (target !== drag.frame) setEdgePreview(next);
    } else if (target !== drag.frame || (playing && target !== frame)) {
      onSeek(target);
    }
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (activeDrag.current?.pointerId !== event.pointerId) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = rulerRef.current?.getBoundingClientRect();
    if (rect) applyDrag(event.clientX, currentView(), rect);
  };

  const finishDrag = (event: PointerEvent<HTMLElement>, commitEdge = false) => {
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    activeDrag.current = null;
    if (drag.kind === "edge") {
      setEdgePreview(undefined);
      if (commitEdge) onMoveEdge(drag.segmentStart, drag.edge, drag.frame);
    }
  };

  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const { deltaMode, deltaX, deltaY, timeStamp, shiftKey, ctrlKey, clientX } = event;
    const wheel = { deltaMode, deltaX, deltaY, timeStamp, shiftKey, ctrlKey };
    const target = event.target instanceof Element ? event.target : null;
    const overview = Boolean(target?.closest(".overview"));
    const overHeader = target?.closest(".track-head, .timeline-timecode");
    const dimensions = { laneWidth: rect.width, pageHeight: bodyRef.current?.clientHeight ?? 0 };
    const lock =
      overview || shiftKey || ctrlKey
        ? undefined
        : lockWheelAxis(wheelAxis.current, wheel, dimensions);
    wheelAxis.current = lock;

    const previous = currentView();
    const pointerFraction =
      overHeader || clientX < rect.left
        ? undefined
        : Math.min(1, (clientX - rect.left) / rect.width);
    const next = wheelToView(previous, wheel, {
      ...dimensions,
      pointerFraction,
      playing,
      frame,
      totalFrames,
      overview,
      axis: lock?.axis,
    });
    if (next.start === previous.start && next.end === previous.end) return;

    queuedWheelView.current = { from: view, to: next };
    onViewChange(next);
    const drag = activeDrag.current;
    if (drag) applyDrag(drag.clientX, next, rect);
  });

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const listener = (event: WheelEvent) => onWheel(event);
    body.addEventListener("wheel", listener, { passive: false });
    return () => body.removeEventListener("wheel", listener);
  }, []);

  return (
    <Panel
      id="timeline"
      focused={focused}
      className="area-timeline"
      tabs={<PanelTitle>Timeline</PanelTitle>}
      tools={
        <>
          <button
            type="button"
            className="icon-button"
            onClick={() => onZoom("out")}
            title="Zoom out (- or scroll down)"
            aria-label="Zoom out"
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => onZoom("in")}
            title="Zoom in (= or scroll up)"
            aria-label="Zoom in"
          >
            <Icon name="plus" />
          </button>
          <button type="button" className="icon-button" onClick={() => onViewChange(whole)}>
            Fit video
          </button>
        </>
      }
    >
      <div ref={bodyRef} className="timeline-body">
        <div className="timeline-timecode">{formatTimecode(frame)}</div>
        <div className="overview">
          <div
            className="overview-window"
            style={{
              left: `${toPercent(whole, view.start)}%`,
              width: `${((view.end - view.start) / whole.end) * 100}%`,
            }}
          />
          {hasVideo && (
            <div className="overview-playhead" style={{ left: `${(frame / whole.end) * 100}%` }} />
          )}
          <button
            type="button"
            aria-label="Centre the Timeline view here"
            style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const fraction = (event.clientX - rect.left) / rect.width;
              onViewChange(centreOn(view, fraction * whole.end, totalFrames));
            }}
          />
        </div>
        <div ref={rulerRef} className="ruler">
          {ticks.frames.map((f) => (
            <div key={f} className="tick" style={{ left: `${toPercent(view, f)}%` }}>
              <span>{formatTimecode(f)}</span>
            </div>
          ))}
          {ticks.step > 1 &&
            ticks.frames.map((f) => (
              <div
                key={`m${f}`}
                className="tick minor"
                style={{ left: `${toPercent(view, f + ticks.step / 2)}%` }}
              />
            ))}
        </div>
        {TRACKS.map((track, i) => (
          <div key={track.id} style={{ display: "contents" }}>
            <div className="track-head" style={{ gridRow: i + 3 }}>
              {track.label}
              {track.id === "segments" && editableSegments && (
                <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 9 }}>
                  EDIT
                </span>
              )}
            </div>
            <div className={`lane ${track.id}`} style={{ gridRow: i + 3 }}>
              {track.id === "segments" && shown?.length
                ? // Keyed by position, which an edge drag never changes (segments can't pass each
                  // other), so the dragged handle keeps its pointer capture.
                  shown.map((segment, index) => (
                    <div
                      key={index}
                      className={`seg ${segment.camera_view} ${editableSegments ? "editable" : ""}`}
                      style={{
                        left: `${toPercent(view, segment.start_frame)}%`,
                        width: `${toPercent(view, segment.end_frame + 1) - toPercent(view, segment.start_frame)}%`,
                      }}
                      title={describe(segment)}
                    >
                      {VIEW_LABELS[segment.camera_view].toUpperCase()}
                      {editableSegments &&
                        (["start", "end"] as const).map((edge) => (
                          <span
                            key={edge}
                            className={`seg-handle ${edge}`}
                            aria-hidden
                            onPointerDown={(event) => {
                              const original = segments?.[index];
                              if (!original || activeDrag.current) return;
                              event.stopPropagation();
                              event.currentTarget.setPointerCapture(event.pointerId);
                              const drag: TimelineDrag = {
                                kind: "edge",
                                pointerId: event.pointerId,
                                clientX: event.clientX,
                                segmentStart: original.start_frame,
                                edge,
                                frame: edge === "start" ? original.start_frame : original.end_frame,
                              };
                              activeDrag.current = drag;
                              setEdgePreview(drag);
                            }}
                            onPointerMove={moveDrag}
                            onPointerUp={(event) => finishDrag(event, true)}
                            onPointerCancel={finishDrag}
                            onLostPointerCapture={finishDrag}
                          />
                        ))}
                    </div>
                  ))
                : track.empty && <span className="lane-empty">{track.empty}</span>}
              {track.id === "segments" && pending && (
                <div
                  className={`seg pending ${pending.camera_view}`}
                  style={{
                    left: `${toPercent(view, Math.min(pending.start, frame))}%`,
                    width: `${toPercent(view, Math.max(pending.start, frame) + 1) - toPercent(view, Math.min(pending.start, frame))}%`,
                  }}
                />
              )}
              {track.id === "segments" &&
                unmappedRanges?.map((range) => (
                  <div
                    key={`seg-unmapped:${range.start_frame}-${range.end_frame}`}
                    className="seg-unmapped"
                    style={{
                      left: `${toPercent(view, range.start_frame)}%`,
                      width: `${toPercent(view, range.end_frame + 1) - toPercent(view, range.start_frame)}%`,
                    }}
                    title={`Unmapped frames ${range.start_frame}–${range.end_frame}: Camera Motion lost`}
                  />
                ))}
              {track.id === "issues" &&
                unmappedRanges?.map((range) => (
                  <button
                    key={`issue-unmapped:${range.start_frame}-${range.end_frame}`}
                    type="button"
                    className="issue-unmapped"
                    style={{
                      left: `${toPercent(view, range.start_frame)}%`,
                      width: `${toPercent(view, range.end_frame + 1) - toPercent(view, range.start_frame)}%`,
                    }}
                    title={`Unmapped frames ${range.start_frame}–${range.end_frame}: click to seek and re-anchor`}
                    aria-label={`Unmapped frames ${range.start_frame} to ${range.end_frame}`}
                    onClick={() => onSeek(range.start_frame)}
                  />
                ))}
            </div>
          </div>
        ))}
        <div
          className="timeline-fill"
          style={{ gridRow: 7, display: "grid", gridTemplateColumns: "100px 1fr" }}
        >
          <div className="track-head" />
        </div>
        <div
          className="playhead-layer"
          title="Drag to scrub"
          style={{
            pointerEvents: hasVideo ? "auto" : "none",
            cursor: "ew-resize",
            touchAction: "none",
          }}
          onPointerDown={(event) => {
            if (!hasVideo || activeDrag.current) return;
            const rect = rulerRef.current?.getBoundingClientRect();
            if (!rect) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            activeDrag.current = {
              kind: "scrub",
              pointerId: event.pointerId,
              clientX: event.clientX,
              frame: null,
            };
            applyDrag(event.clientX, currentView(), rect);
          }}
          onPointerMove={moveDrag}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onLostPointerCapture={finishDrag}
        >
          {hasVideo && <div className="playhead" style={{ left: `${toPercent(view, frame)}%` }} />}
        </div>
      </div>
    </Panel>
  );
}
