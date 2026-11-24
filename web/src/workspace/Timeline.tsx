import { type PointerEvent, useState } from "react";
import type { PlaySegment } from "../api/client";
import { formatTimecode } from "../lib/frames";
import { describe, moveEdge, type PendingSegment, VIEW_LABELS } from "../lib/segments";
import {
  centreOn,
  type FrameRange,
  frameAt,
  fullView,
  rulerTicks,
  toPercent,
} from "../lib/timeline";
import { Icon } from "./icons";
import { Panel, PanelTitle } from "./Panel";

const TRACKS = [
  { id: "segments", label: "Segments", empty: "No Play Segments marked" },
  { id: "rallies", label: "Rallies", empty: "No Rallies yet" },
  { id: "shots", label: "Shots", empty: "No Shots yet" },
  { id: "issues", label: "Issues", empty: "" },
] as const;

/**
 * The Timeline: an overview of the whole video, a ruler with the playhead, and one lane per
 * track. Dragging on the ruler or the lanes scrubs; the overview moves the view.
 */
export function Timeline({
  view,
  onViewChange,
  frame,
  totalFrames,
  onSeek,
  onZoom,
  focused,
  segments,
  pending,
  editableSegments,
  onMoveEdge,
}: {
  view: FrameRange;
  onViewChange: (view: FrameRange) => void;
  frame: number;
  totalFrames: number;
  onSeek: (frame: number) => void;
  onZoom: (direction: "in" | "out") => void;
  focused: boolean;
  /** The Match's Play Segments in frame order; null until loaded. */
  segments: PlaySegment[] | null;
  /** A segment begun and not yet ended: drawn from its start to the playhead. */
  pending: PendingSegment | null;
  /** Calibrate marks Play Segments, so the Segments track is the one being edited there. */
  editableSegments: boolean;
  onMoveEdge: (segmentStart: number, edge: "start" | "end", frame: number) => void;
}) {
  const whole = fullView(totalFrames);
  const ticks = rulerTicks(view);
  const hasVideo = totalFrames > 0;

  const lastFrame = Math.max(0, totalFrames - 1);
  // An edge being dragged: drawn where it is going, committed once on release.
  const [drag, setDrag] = useState<{
    segmentStart: number;
    edge: "start" | "end";
    frame: number;
  }>();
  const shown =
    segments && drag
      ? moveEdge(segments, null, drag.segmentStart, drag.edge, drag.frame).segments
      : segments;
  const laneFrame = (event: PointerEvent<HTMLElement>) => {
    const lane = event.currentTarget.closest(".lane");
    if (!lane) return 0;
    const rect = lane.getBoundingClientRect();
    const at = frameAt(view, (event.clientX - rect.left) / rect.width);
    return Math.min(lastFrame, Math.max(0, at));
  };

  const scrub = (event: PointerEvent<HTMLDivElement>) => {
    if (!hasVideo) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onSeek(frameAt(view, (event.clientX - rect.left) / rect.width));
  };

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
            title="Zoom out (-)"
            aria-label="Zoom out"
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => onZoom("in")}
            title="Zoom in (=)"
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
      <div className="timeline-body">
        <div className="timeline-timecode">{formatTimecode(frame)}</div>
        <div className="overview">
          <div
            className="overview-window"
            style={{
              left: `${(Math.max(0, view.start) / whole.end) * 100}%`,
              width: `${((Math.min(whole.end, view.end) - Math.max(0, view.start)) / whole.end) * 100}%`,
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
              onViewChange(centreOn(view, ((event.clientX - rect.left) / rect.width) * whole.end));
            }}
          />
        </div>
        <div className="ruler">
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
                              if (!segments) return;
                              event.stopPropagation();
                              event.currentTarget.setPointerCapture(event.pointerId);
                              const original = segments.find(
                                (s) => s.start_frame === segment.start_frame,
                              );
                              if (!original) return;
                              setDrag({
                                segmentStart: original.start_frame,
                                edge,
                                frame: edge === "start" ? original.start_frame : original.end_frame,
                              });
                            }}
                            onPointerMove={(event) => {
                              if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId))
                                return;
                              setDrag({ ...drag, frame: laneFrame(event) });
                            }}
                            onPointerUp={() => {
                              if (drag) onMoveEdge(drag.segmentStart, drag.edge, drag.frame);
                              setDrag(undefined);
                            }}
                            onPointerCancel={() => setDrag(undefined)}
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
            event.currentTarget.setPointerCapture(event.pointerId);
            scrub(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) scrub(event);
          }}
        >
          {hasVideo && <div className="playhead" style={{ left: `${toPercent(view, frame)}%` }} />}
        </div>
      </div>
    </Panel>
  );
}
