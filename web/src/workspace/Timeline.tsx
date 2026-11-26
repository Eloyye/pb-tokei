import { type PointerEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import type { Game, PlaySegment, UnmappedRangeOut } from "../api/client";
import type { Selection } from "../lib/annotate";
import { formatScore, type Roster, teamKey, teamOf } from "../lib/rallyLog";
import { clampFrame, formatTimecode } from "../lib/frames";
import { describe, moveEdge, type PendingSegment, VIEW_LABELS } from "../lib/segments";
import {
  centreOn,
  type FrameRange,
  frameAt,
  fullView,
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

interface PinDrag {
  game: number;
  rally: number;
  entry: number;
  from: number;
  frame: number;
}

type TimelineDrag = { pointerId: number; clientX: number } & (
  | { kind: "scrub"; frame: number | null }
  | ({ kind: "edge" } & EdgeDrag)
  | ({ kind: "pin" } & PinDrag)
);

const STATUS_MARK = { empty: "○", in_progress: "●", done: "✓" } as const;

/** Rally Log content for the Rallies and Shots tracks (Annotate). */
export interface TimelineRallies {
  games: readonly Game[];
  selection: Selection;
  roster: Roster;
  onSelectRally: (game: number, rally: number) => void;
  onSelectEntry: (game: number, rally: number, entry: number) => void;
  onMoveContact: (game: number, rally: number, entry: number, frame: number) => void;
  /** Fits the view to the selected Rally (or the whole video without one). */
  onFitRally: () => void;
}

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
  rallyLog,
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
  /** The Rally Log's Rallies and Shots, in Annotate; the tracks stay empty without it. */
  rallyLog?: TimelineRallies;
}) {
  const whole = fullView(totalFrames);
  const ticks = rulerTicks(view);
  const hasVideo = totalFrames > 0;

  const bodyRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const wheelLock = useRef<WheelAxisLock | undefined>(undefined);
  const queuedWheelView = useRef<{ from: FrameRange; to: FrameRange } | null>(null);
  const activeDrag = useRef<TimelineDrag | null>(null);
  const [edgePreview, setEdgePreview] = useState<EdgeDrag>();
  const [pinPreview, setPinPreview] = useState<PinDrag>();
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
    } else if (next.kind === "pin") {
      if (target !== drag.frame) setPinPreview(next);
    } else if (target !== drag.frame || (playing && target !== frame)) {
      // Playback can advance while the scrub still points to the same frame.
      onSeek(target);
    }
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (activeDrag.current?.pointerId !== event.pointerId) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = rulerRef.current?.getBoundingClientRect();
    if (rect) applyDrag(event.clientX, currentView(), rect);
  };

  const startPinDrag = (event: PointerEvent<HTMLElement>, pin: PinDrag) => {
    if (activeDrag.current) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    activeDrag.current = {
      kind: "pin",
      pointerId: event.pointerId,
      clientX: event.clientX,
      ...pin,
    };
  };

  const finishDrag = (event: PointerEvent<HTMLElement>, commitEdge = false) => {
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    activeDrag.current = null;
    if (drag.kind === "edge") {
      setEdgePreview(undefined);
      if (commitEdge) onMoveEdge(drag.segmentStart, drag.edge, drag.frame);
    }
    if (drag.kind === "pin") {
      setPinPreview(undefined);
      if (!commitEdge) return;
      if (drag.frame !== drag.from) {
        rallyLog?.onMoveContact(drag.game, drag.rally, drag.entry, drag.frame);
      } else {
        rallyLog?.onSelectEntry(drag.game, drag.rally, drag.entry);
      }
    }
  };

  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;

    const { clientX } = event;
    const target = event.target instanceof Element ? event.target : null;
    const overview = Boolean(target?.closest(".overview"));
    const overHeader = target?.closest(".track-head, .timeline-timecode");
    const previous = currentView();
    const pointerFraction =
      overHeader || clientX < rect.left
        ? undefined
        : Math.min(1, (clientX - rect.left) / rect.width);
    const { view: next, lock } = wheelToView(
      previous,
      event,
      {
        laneWidth: rect.width,
        pageHeight: bodyRef.current?.clientHeight ?? 0,
        pointerFraction,
        playing,
        frame,
        totalFrames,
        overview,
      },
      wheelLock.current,
    );
    wheelLock.current = lock;
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
          {rallyLog && (
            <button
              type="button"
              className="icon-button"
              title="Fit the selected Rally (8% padding)"
              onClick={rallyLog.onFitRally}
            >
              Fit Rally
            </button>
          )}
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
          {rallyLog?.games.flatMap((game) =>
            game.rallies.map((rally) => {
              if (rally.start_frame === null) return null;
              const end = rallyEnd(rally);
              const team = teamKey(rallyLog.roster, rally.serving_team_id.value);
              return (
                <div
                  key={`ov-${game.number}-${rally.number}`}
                  className={`ov-block ${team ? `team-${team}` : ""}`}
                  style={{
                    left: `${(rally.start_frame / whole.end) * 100}%`,
                    width: `${((end + 1 - rally.start_frame) / whole.end) * 100}%`,
                  }}
                />
              );
            }),
          )}
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
              {track.id === "segments" && shown?.length ? (
                // Keyed by position, which an edge drag never changes (segments can't pass each
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
              ) : track.id === "rallies" && rallyLog && hasFramedRallies(rallyLog.games) ? (
                rallyClips(rallyLog, view)
              ) : track.id === "shots" && rallyLog && hasShots(rallyLog.games) ? (
                <ShotMarks
                  rallyLog={rallyLog}
                  view={view}
                  preview={pinPreview}
                  onPinDown={startPinDrag}
                  onMove={moveDrag}
                  onUp={finishDrag}
                />
              ) : (
                track.empty && <span className="lane-empty">{track.empty}</span>
              )}
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

/** Where a Rally's clip ends: its end frame, or while open its last Shot (or start). */
function rallyEnd(rally: Game["rallies"][number]): number {
  if (rally.end_frame !== null) return rally.end_frame;
  const frames = rally.entries.flatMap((e) =>
    e.type === "shot" && e.contact_frame.value !== null ? [e.contact_frame.value] : [],
  );
  return Math.max(rally.start_frame ?? 0, ...frames) + 30;
}

function hasFramedRallies(games: readonly Game[]): boolean {
  return games.some((g) => g.rallies.some((r) => r.start_frame !== null));
}

function hasShots(games: readonly Game[]): boolean {
  return games.some((g) => g.rallies.some((r) => r.entries.length > 0));
}

function rallyClips(rallyLog: TimelineRallies, view: FrameRange) {
  const { games, selection, roster } = rallyLog;
  return games.flatMap((game, gi) =>
    game.rallies.map((rally, ri) => {
      if (rally.start_frame === null) return null;
      const end = rallyEnd(rally);
      const team = teamKey(roster, rally.serving_team_id.value);
      const on = gi === selection.game && ri === selection.rally;
      return (
        <button
          key={`clip-${gi}-${ri}`}
          type="button"
          className={`clip ${team ? `team-${team}` : ""} ${on ? "on" : ""} ${rally.end_frame === null ? "open" : ""}`}
          style={{
            left: `${toPercent(view, rally.start_frame)}%`,
            width: `${toPercent(view, end + 1) - toPercent(view, rally.start_frame)}%`,
          }}
          title={`Game ${game.number} Rally ${rally.number}: frames ${rally.start_frame}–${rally.end_frame ?? "open"}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => rallyLog.onSelectRally(gi, ri)}
        >
          {STATUS_MARK[rally.status]} R{rally.number}
          <span className="mono">{formatScore(rally.score)}</span>
        </button>
      );
    }),
  );
}

function ShotMarks({
  rallyLog,
  view,
  preview,
  onPinDown,
  onMove,
  onUp,
}: {
  rallyLog: TimelineRallies;
  view: FrameRange;
  preview: PinDrag | undefined;
  onPinDown: (event: PointerEvent<HTMLElement>, pin: PinDrag) => void;
  onMove: (event: PointerEvent<HTMLElement>) => void;
  onUp: (event: PointerEvent<HTMLElement>, commit?: boolean) => void;
}) {
  const { games, selection, roster } = rallyLog;
  return (
    <>
      {games.flatMap((game, gi) =>
        game.rallies.flatMap((rally, ri) => {
          const frames = rally.entries.map((e, ei) => {
            if (e.type !== "shot") return null;
            const dragged =
              preview && preview.game === gi && preview.rally === ri && preview.entry === ei;
            return dragged ? preview.frame : e.contact_frame.value;
          });
          return rally.entries.map((entry, ei) => {
            const on = gi === selection.game && ri === selection.rally && ei === selection.entry;
            if (entry.type === "gap") {
              // Halfway between the Shots around it (or the Rally's start / end).
              const before = frames.slice(0, ei).findLast((f) => f !== null) ?? rally.start_frame;
              const after = frames.slice(ei + 1).find((f) => f !== null) ?? rally.end_frame;
              const a = before ?? after;
              const b = after ?? before;
              if (a === null || a === undefined || b === null || b === undefined) return null;
              return (
                <button
                  key={`gap-${gi}-${ri}-${ei}`}
                  type="button"
                  className={`gap-pill ${on ? "on" : ""}`}
                  style={{ left: `${toPercent(view, (a + b) / 2)}%` }}
                  title={`An ${entry.missing} number of Shots unseen (click, then ⌫ deletes or G / ⇧G flips)`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => rallyLog.onSelectEntry(gi, ri, ei)}
                >
                  {entry.missing} gap
                </button>
              );
            }
            const frame = frames[ei];
            if (frame === null || frame === undefined) return null;
            const hitter = entry.hitter_id.value;
            const team = hitter === null ? null : teamKey(roster, teamOf(roster, hitter));
            const number = entry.shot_number.value;
            return (
              <button
                key={`pin-${gi}-${ri}-${ei}`}
                type="button"
                className={`pin ${team ? `team-${team}` : ""} ${entry.hitter_id.certainty === "inferred" ? "inferred" : ""} ${on ? "on" : ""}`}
                style={{ left: `${toPercent(view, frame)}%` }}
                title={`Shot ${number ?? "?"} at frame ${frame} (drag to move its contact)`}
                aria-label={`Shot ${number ?? "?"} at frame ${frame}`}
                onPointerDown={(event) =>
                  onPinDown(event, { game: gi, rally: ri, entry: ei, from: frame, frame })
                }
                onPointerMove={onMove}
                onPointerUp={(event) => onUp(event, true)}
                onPointerCancel={onUp}
                onLostPointerCapture={onUp}
              >
                {number ?? "?"}
              </button>
            );
          });
        }),
      )}
    </>
  );
}
