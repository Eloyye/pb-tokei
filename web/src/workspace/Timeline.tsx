import {
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Game, PlaySegment, Rally, UnmappedRangeOut } from "../api/client";
import { moveRallyEdge, type RallyEdge, type Selection, withRallyEdge } from "../lib/annotate";
import { formatScore, type Roster, teamKey, teamOf } from "../lib/rallyLog";
import { type RuleIssue, timelineIssueMarkers } from "../lib/ruleChecks";
import { clampFrame, formatTimecode } from "../lib/frames";
import { describe, moveEdge, type PendingSegment, VIEW_LABELS } from "../lib/segments";
import {
  centreOn,
  type FrameRange,
  frameAt,
  fullView,
  panView,
  rulerTicks,
  toPercent,
  type WheelAxisLock,
  wheelToView,
} from "../lib/timeline";
import type { OpenContextMenu } from "./contextMenuItems";
import { Icon } from "./icons";
import { Panel, PanelTitle } from "./Panel";

const TRACKS = [
  { id: "segments", label: "Segments", empty: "No Play Segments marked" },
  { id: "rallies", label: "Rallies", empty: "No Rallies yet" },
  { id: "shots", label: "Shots", empty: "No Shots yet" },
  { id: "issues", label: "Issues", empty: "" },
] as const;

const DRAG_THRESHOLD_PX = 3;
const MIDDLE_BUTTON = 1;
const MIDDLE_BUTTON_MASK = 4;

type EdgeTarget =
  | { kind: "segment"; start: number }
  | { kind: "rally"; game: number; rally: number };

interface EdgeDrag {
  kind: "edge";
  target: EdgeTarget;
  /** Replacing the list can change what the captured handle refers to. */
  source: readonly (Game | PlaySegment)[];
  edge: RallyEdge;
  frame: number;
  originX: number;
  originView: FrameRange;
  /** The frame under the pointer, or null until the drag starts. */
  pointerFrame: number | null;
}

interface PinDrag {
  game: number;
  rally: number;
  entry: number;
  from: number;
  frame: number;
  startX: number;
  moved: boolean;
}

type TimelineDrag = { pointerId: number; clientX: number } & (
  | { kind: "scrub"; frame: number | null }
  | { kind: "pan"; overview: boolean }
  | EdgeDrag
  | ({ kind: "pin" } & PinDrag)
);

const STATUS_MARK = { empty: "○", in_progress: "●", done: "✓" } as const;

function preventMiddleDefault(event: MouseEvent<HTMLElement>) {
  if (event.button === MIDDLE_BUTTON) event.preventDefault();
}

/** Rally Log content for the Rallies, Shots, and Issues tracks (Annotate and Review). */
export interface TimelineRallies {
  games: readonly Game[];
  selection: Selection;
  roster: Roster;
  issues?: readonly RuleIssue[];
  onSelectRally: (game: number, rally: number, mode?: "edge-drag") => void;
  onMoveRallyEdge: (game: number, rally: number, edge: RallyEdge, frame: number) => void;
  onSelectEntry: (game: number, rally: number, entry: number) => void;
  onMoveContact: (game: number, rally: number, entry: number, frame: number) => void;
  onSelectIssue?: (issue: RuleIssue) => void;
  /** Fits the view to the selected Rally (or the whole video without one). */
  onFitRally: () => void;
}

/**
 * The Timeline: an overview of the whole video, a ruler with the playhead, and one lane per
 * track. Left dragging on the ruler or lanes scrubs, and middle dragging pans the view.
 */
export function Timeline({
  view,
  onViewChange,
  onPanningChange,
  frame,
  totalFrames,
  playing,
  onSeek,
  onZoom,
  focused,
  segments,
  selectedSegment,
  onSelectSegment,
  onContextMenu,
  unmappedRanges,
  pending,
  onMoveEdge,
  onPreviewEdge,
  rallyLog,
}: {
  view: FrameRange;
  onViewChange: (view: FrameRange) => void;
  onPanningChange?: (panning: boolean) => void;
  frame: number;
  totalFrames: number;
  playing: boolean;
  onSeek: (frame: number) => void;
  onZoom: (direction: "in" | "out") => void;
  focused: boolean;
  /** The Match's Play Segments in frame order; null until loaded. */
  segments: PlaySegment[] | null;
  selectedSegment?: PlaySegment | null;
  onSelectSegment?: (segment: PlaySegment | null) => void;
  onContextMenu?: OpenContextMenu;
  /** Stretches inside Play Segments where Camera Motion failed registration. */
  unmappedRanges?: readonly UnmappedRangeOut[];
  /** A segment begun and not yet ended: drawn from its start to the playhead. */
  pending: PendingSegment | null;
  onMoveEdge: (segmentStart: number, edge: RallyEdge, frame: number) => void;
  /** Shows the pointer frame in the Monitor and any Rally clamp reason in the status bar. */
  onPreviewEdge: (frame: number | null, reason: string | null) => void;
  /** The Rally Log's Rallies and Shots, in Annotate and Review. */
  rallyLog?: TimelineRallies;
}) {
  const whole = fullView(totalFrames);
  const ticks = rulerTicks(view);
  const hasVideo = totalFrames > 0;
  const games = rallyLog?.games;

  const bodyRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const wheelLock = useRef<WheelAxisLock | undefined>(undefined);
  const queuedView = useRef<{ from: FrameRange; to: FrameRange } | null>(null);
  const activeDrag = useRef<TimelineDrag | null>(null);
  const [edgePreview, setEdgePreview] = useState<EdgeDrag>();
  const [pinPreview, setPinPreview] = useState<PinDrag>();
  const edgeTarget = edgePreview?.target;
  const shownSegments =
    segments && edgePreview && edgeTarget?.kind === "segment"
      ? moveEdge(segments, null, edgeTarget.start, edgePreview.edge, edgePreview.frame).segments
      : segments;

  // Several drag or wheel events can arrive before React commits the view.
  const currentView = () => {
    const queued = queuedView.current;
    return queued?.from === view ? queued.to : view;
  };

  const queueViewChange = (previous: FrameRange, next: FrameRange) => {
    if (next.start === previous.start && next.end === previous.end) return false;
    queuedView.current = { from: view, to: next };
    onViewChange(next);
    return true;
  };

  const applyDrag = (clientX: number, nextView: FrameRange, rect: DOMRect, fromWheel = false) => {
    const drag = activeDrag.current;
    if (!drag || drag.kind === "pan" || rect.width <= 0) return;
    const target = clampFrame(frameAt(nextView, (clientX - rect.left) / rect.width), totalFrames);
    if (drag.kind === "edge") {
      activeDrag.current = { ...drag, clientX };
      const starting = drag.pointerFrame === null;
      if (
        target === drag.pointerFrame ||
        (starting &&
          Math.abs(clientX - drag.originX) < DRAG_THRESHOLD_PX &&
          nextView === drag.originView)
      )
        return;

      let reached = target;
      let reason: string | null = null;
      if (drag.target.kind === "rally") {
        if (!rallyLog) return;
        const { game, rally } = drag.target;
        const result = moveRallyEdge(
          rallyLog.games,
          { game, rally, entry: null },
          drag.edge,
          target,
        );
        if (result.frame === null) return;
        reached = result.frame;
        reason = result.reason;
        if (starting && (game !== rallyLog.selection.game || rally !== rallyLog.selection.rally)) {
          rallyLog.onSelectRally(game, rally, "edge-drag");
        }
      }
      const next = { ...drag, clientX, frame: reached, pointerFrame: target };
      activeDrag.current = next;
      if (starting || reached !== drag.frame) setEdgePreview(next);
      onPreviewEdge(target, reason);
      return;
    }

    if (drag.kind === "pin") {
      const moved =
        drag.moved ||
        Math.abs(clientX - drag.startX) >= DRAG_THRESHOLD_PX ||
        (fromWheel && target !== drag.from);
      if (!moved) {
        activeDrag.current = { ...drag, clientX };
        return;
      }
      const next = { ...drag, clientX, frame: target, moved: true };
      activeDrag.current = next;
      if (target !== drag.frame || !drag.moved) setPinPreview(next);
      return;
    }

    const next = { ...drag, clientX, frame: target };
    activeDrag.current = next;
    if (target !== drag.frame || (playing && target !== frame)) {
      // Playback can advance while the scrub still points to the same frame.
      onSeek(target);
    }
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = activeDrag.current;
    if (drag?.pointerId !== event.pointerId) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (drag.kind === "pan") {
      // With another mouse button held, a middle release arrives as a pointermove.
      if (!(event.buttons & MIDDLE_BUTTON_MASK)) {
        finishDrag(event);
        event.currentTarget.releasePointerCapture(event.pointerId);
        return;
      }
      const deltaX = event.clientX - drag.clientX;
      if (deltaX === 0) return;
      drag.clientX = event.clientX;
      const surface = drag.overview ? event.currentTarget : rulerRef.current;
      const width = surface?.getBoundingClientRect().width ?? 0;
      if (width <= 0) return;
      const previous = currentView();
      // The lanes move with the cursor. The Overview moves the window over the full video.
      const framesAcross = drag.overview ? whole.end : previous.start - previous.end;
      queueViewChange(previous, panView(previous, (deltaX / width) * framesAcross, totalFrames));
      return;
    }
    const rect = rulerRef.current?.getBoundingClientRect();
    if (rect) applyDrag(event.clientX, currentView(), rect);
  };

  const startPinDrag = (
    event: PointerEvent<HTMLElement>,
    pin: Omit<PinDrag, "startX" | "moved">,
  ) => {
    if (event.button !== 0 || event.ctrlKey || activeDrag.current) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    activeDrag.current = {
      kind: "pin",
      pointerId: event.pointerId,
      clientX: event.clientX,
      startX: event.clientX,
      moved: false,
      ...pin,
    };
  };

  const clearEdgePreview = (drag: EdgeDrag) => {
    setEdgePreview(undefined);
    if (drag.pointerFrame !== null) onPreviewEdge(null, null);
  };

  const finishDrag = (event: PointerEvent<HTMLElement>, commit = false) => {
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    activeDrag.current = null;
    if (drag.kind === "pan") {
      onPanningChange?.(false);
      return;
    }
    if (drag.kind === "edge") {
      clearEdgePreview(drag);
      if (!commit) return;
      if (drag.target.kind === "segment") {
        onMoveEdge(drag.target.start, drag.edge, drag.frame);
      } else if (drag.pointerFrame === null) {
        rallyLog?.onSelectRally(drag.target.game, drag.target.rally);
      } else {
        rallyLog?.onMoveRallyEdge(drag.target.game, drag.target.rally, drag.edge, drag.frame);
      }
    }
    if (drag.kind === "pin") {
      setPinPreview(undefined);
      if (!commit) return;
      if (drag.moved) {
        if (drag.frame !== drag.from) {
          rallyLog?.onMoveContact(drag.game, drag.rally, drag.entry, drag.frame);
        }
      } else {
        rallyLog?.onSelectEntry(drag.game, drag.rally, drag.entry);
      }
    }
  };

  const startPan = (event: PointerEvent<HTMLElement>, overview = false) => {
    if (event.button !== MIDDLE_BUTTON) return;
    event.preventDefault();
    event.stopPropagation();
    if (!hasVideo || activeDrag.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activeDrag.current = {
      kind: "pan",
      pointerId: event.pointerId,
      clientX: event.clientX,
      overview,
    };
    onPanningChange?.(true);
  };

  const startScrub = (event: PointerEvent<HTMLElement>, selected: PlaySegment | null = null) => {
    if (event.button !== 0 || event.ctrlKey || activeDrag.current) return;
    onSelectSegment?.(selected);
    if (!hasVideo) return;
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
  };
  const dragHandlers = {
    onPointerMove: moveDrag,
    onPointerUp: finishDrag,
    onPointerCancel: finishDrag,
    onLostPointerCapture: finishDrag,
  };
  const scrubHandlers = { ...dragHandlers, onPointerDown: startScrub };
  const surfaceHandlers = { ...scrubHandlers, onPointerDownCapture: startPan };
  const openLaneMenu = (event: MouseEvent<HTMLElement>) => {
    // Issue markers keep their own click behavior and aren't empty space.
    if (event.target instanceof Element && event.target.closest("button")) return;
    onContextMenu?.(event, { kind: "lane" });
  };

  const edgeHandle = (target: EdgeTarget, edge: RallyEdge, edgeFrame: number) =>
    hasVideo && (
      <span
        key={edge}
        className={`seg-handle ${edge}`}
        aria-hidden
        onPointerDown={(event) => {
          const source = target.kind === "segment" ? segments : games;
          if (!source || event.button !== 0 || event.ctrlKey || activeDrag.current) return;
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          activeDrag.current = {
            kind: "edge",
            target,
            source,
            edge,
            frame: edgeFrame,
            pointerId: event.pointerId,
            clientX: event.clientX,
            originX: event.clientX,
            originView: currentView(),
            pointerFrame: null,
          };
        }}
        onPointerMove={moveDrag}
        onPointerUp={(event) => finishDrag(event, true)}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
        onClick={(event) => event.stopPropagation()}
      />
    );

  const onWheel = useEffectEvent((event: WheelEvent, pageHeight: number) => {
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
        pageHeight,
        pointerFraction,
        playing,
        frame,
        totalFrames,
        overview,
      },
      wheelLock.current,
    );
    wheelLock.current = lock;
    if (!queueViewChange(previous, next)) return;
    const drag = activeDrag.current;
    if (drag) applyDrag(drag.clientX, next, rect, true);
  });

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const listener = (event: WheelEvent) => onWheel(event, body.clientHeight);
    body.addEventListener("wheel", listener, { passive: false });
    return () => body.removeEventListener("wheel", listener);
  }, []);

  const syncEdgeDrag = useEffectEvent(
    (
      nextView: FrameRange,
      currentGames: readonly Game[] | undefined,
      currentSegments: PlaySegment[] | null,
    ) => {
      const drag = activeDrag.current;
      if (drag?.kind !== "edge") return;
      const source = drag.target.kind === "segment" ? currentSegments : currentGames;
      if (drag.source !== source) {
        activeDrag.current = null;
        clearEdgePreview(drag);
        return;
      }
      // Toolbar and keyboard zooms change the view without going through the wheel handler.
      const rect = rulerRef.current?.getBoundingClientRect();
      if (rect) applyDrag(drag.clientX, nextView, rect);
    },
  );
  useLayoutEffect(() => syncEdgeDrag(view, games, segments), [view, games, segments]);

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
      <div
        ref={bodyRef}
        className="timeline-body"
        onMouseDownCapture={preventMiddleDefault}
        onAuxClickCapture={preventMiddleDefault}
      >
        <div className="timeline-timecode">{formatTimecode(frame)}</div>
        <div
          className="overview"
          onPointerDownCapture={(event) => startPan(event, true)}
          {...dragHandlers}
        >
          <div
            className="overview-window"
            style={{
              left: `${toPercent(whole, view.start)}%`,
              width: `${((view.end - view.start) / whole.end) * 100}%`,
            }}
          />
          {rallyLog?.games.flatMap((game, gi) =>
            game.rallies.map((original, ri) => {
              const rally = rallyWithPreview(original, gi, ri, edgePreview);
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
        <div ref={rulerRef} className="ruler" title="Drag to scrub" {...surfaceHandlers}>
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
            </div>
            <div
              className={`lane ${track.id}`}
              style={{ gridRow: i + 3 }}
              title="Drag to scrub"
              {...surfaceHandlers}
              onContextMenu={openLaneMenu}
            >
              {track.id === "segments" && shownSegments?.length ? (
                // Keyed by position, which an edge drag never changes (segments can't pass each
                // other), so the dragged handle keeps its pointer capture.
                shownSegments.map((segment, index) => {
                  const original = segments![index]!;
                  const on = original === selectedSegment;
                  return (
                    <button
                      key={index}
                      type="button"
                      aria-pressed={on}
                      aria-label={describe(segment)}
                      className={`seg ${segment.camera_view} ${hasVideo ? "editable" : ""} ${on ? "on" : ""}`}
                      style={{
                        left: `${toPercent(view, segment.start_frame)}%`,
                        width: `${toPercent(view, segment.end_frame + 1) - toPercent(view, segment.start_frame)}%`,
                      }}
                      title={describe(segment)}
                      {...scrubHandlers}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        startScrub(event, original);
                      }}
                      onClick={(event) => {
                        if (event.detail === 0) onSelectSegment?.(original);
                      }}
                      onContextMenu={(event) =>
                        onContextMenu?.(event, { kind: "segment", segment: original })
                      }
                    >
                      {VIEW_LABELS[segment.camera_view].toUpperCase()}
                      {(["start", "end"] as const).map((edge) =>
                        edgeHandle(
                          { kind: "segment", start: original.start_frame },
                          edge,
                          edge === "start" ? segment.start_frame : segment.end_frame,
                        ),
                      )}
                    </button>
                  );
                })
              ) : track.id === "rallies" && rallyLog && hasFramedRallies(rallyLog.games) ? (
                rallyClips(rallyLog, view, edgePreview, edgeHandle, onContextMenu)
              ) : track.id === "shots" && rallyLog && hasShots(rallyLog.games) ? (
                <ShotMarks
                  rallyLog={rallyLog}
                  view={view}
                  preview={pinPreview}
                  onPinDown={startPinDrag}
                  onMove={moveDrag}
                  onUp={finishDrag}
                  onContextMenu={onContextMenu}
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
                (rallyLog ? (
                  <IssueMarks rallyLog={rallyLog} view={view} />
                ) : (
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
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => onSeek(range.start_frame)}
                    />
                  ))
                ))}
            </div>
          </div>
        ))}
        <div className="track-head" style={{ gridRow: 7 }} />
        <div
          className="timeline-fill"
          style={{ gridRow: 7 }}
          title="Drag to scrub"
          {...surfaceHandlers}
          onContextMenu={openLaneMenu}
        />
        <div className="playhead-layer" aria-hidden>
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

function rallyWithPreview(
  rally: Rally,
  game: number,
  index: number,
  preview: EdgeDrag | undefined,
): Rally {
  const target = preview?.target;
  return preview && target?.kind === "rally" && target.game === game && target.rally === index
    ? withRallyEdge(rally, preview.edge, preview.frame)
    : rally;
}

function rallyClips(
  rallyLog: TimelineRallies,
  view: FrameRange,
  preview: EdgeDrag | undefined,
  edgeHandle: (target: EdgeTarget, edge: RallyEdge, frame: number) => React.ReactNode,
  onContextMenu?: OpenContextMenu,
) {
  const { games, selection, roster } = rallyLog;
  return games.flatMap((game, gi) =>
    game.rallies.map((original, ri) => {
      const rally = rallyWithPreview(original, gi, ri, preview);
      if (rally.start_frame === null) return null;
      const end = rallyEnd(rally);
      const team = teamKey(roster, rally.serving_team_id.value);
      const on = gi === selection.game && ri === selection.rally;
      const target = { kind: "rally", game: gi, rally: ri } as const;
      return (
        <button
          key={`clip-${gi}-${ri}`}
          type="button"
          aria-pressed={on}
          className={`clip ${team ? `team-${team}` : ""} ${on ? "on" : ""} ${rally.end_frame === null ? "open" : ""}`}
          style={{
            left: `${toPercent(view, rally.start_frame)}%`,
            width: `${toPercent(view, end + 1) - toPercent(view, rally.start_frame)}%`,
          }}
          title={`Game ${game.number} Rally ${rally.number}: frames ${rally.start_frame}–${rally.end_frame ?? "open"}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => rallyLog.onSelectRally(gi, ri)}
          onContextMenu={(event) => onContextMenu?.(event, target)}
        >
          <span className="clip-label">
            {STATUS_MARK[rally.status]} R{rally.number}
            <span className="mono">{formatScore(rally.score)}</span>
          </span>
          {edgeHandle(target, "start", rally.start_frame)}
          {rally.end_frame !== null && edgeHandle(target, "end", rally.end_frame)}
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
  onContextMenu,
}: {
  rallyLog: TimelineRallies;
  view: FrameRange;
  preview: PinDrag | undefined;
  onPinDown: (event: PointerEvent<HTMLElement>, pin: Omit<PinDrag, "startX" | "moved">) => void;
  onMove: (event: PointerEvent<HTMLElement>) => void;
  onUp: (event: PointerEvent<HTMLElement>, commit?: boolean) => void;
  onContextMenu?: OpenContextMenu;
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
                  aria-pressed={on}
                  className={`gap-pill ${on ? "on" : ""}`}
                  style={{ left: `${toPercent(view, (a + b) / 2)}%` }}
                  title={`An ${entry.missing} number of Shots unseen (${on ? "click to deselect, " : "click, then "}⌫ deletes or G / ⇧G flips)`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => rallyLog.onSelectEntry(gi, ri, ei)}
                  onContextMenu={(event) =>
                    onContextMenu?.(event, { kind: "gap", game: gi, rally: ri, entry: ei })
                  }
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
                aria-pressed={on}
                className={`pin ${team ? `team-${team}` : ""} ${entry.hitter_id.certainty === "inferred" ? "inferred" : ""} ${on ? "on" : ""}`}
                style={{ left: `${toPercent(view, frame)}%` }}
                title={`Shot ${number ?? "?"} at frame ${frame} (${on ? "click to deselect, or " : ""}drag to move its contact)`}
                aria-label={`Shot ${number ?? "?"} at frame ${frame}`}
                onPointerDown={(event) =>
                  onPinDown(event, { game: gi, rally: ri, entry: ei, from: frame, frame })
                }
                onPointerMove={onMove}
                onPointerUp={(event) => onUp(event, true)}
                onPointerCancel={onUp}
                onLostPointerCapture={onUp}
                onContextMenu={(event) =>
                  onContextMenu?.(event, { kind: "shot", game: gi, rally: ri, entry: ei })
                }
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

function IssueMarks({ rallyLog, view }: { rallyLog: TimelineRallies; view: FrameRange }) {
  const issues = rallyLog.issues;
  if (!issues || issues.length === 0) return null;
  const { rallies, shots } = timelineIssueMarkers(rallyLog.games, issues);
  return (
    <>
      {rallies.map((marker) => (
        <button
          key={`issue-bar-${marker.key}`}
          type="button"
          className={`issue-bar ${marker.severity}`}
          style={{
            left: `${toPercent(view, marker.startFrame)}%`,
            width: `${toPercent(view, marker.endFrame + 1) - toPercent(view, marker.startFrame)}%`,
          }}
          title={marker.tooltip}
          aria-label={`Rally issue G${marker.gameNumber} R${marker.rallyNumber}: ${marker.tooltip}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => rallyLog.onSelectIssue?.(marker.primaryIssue)}
        />
      ))}
      {shots.map((marker) => (
        <button
          key={`issue-tri-${marker.key}`}
          type="button"
          className={`issue-tri ${marker.severity}`}
          style={{ left: `${toPercent(view, marker.shotFrame)}%` }}
          title={marker.tooltip}
          aria-label={`Shot issue at frame ${marker.shotFrame}: ${marker.tooltip}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => rallyLog.onSelectIssue?.(marker.primaryIssue)}
        />
      ))}
    </>
  );
}
