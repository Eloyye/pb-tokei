import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { type MatchDetail, matchVideoUrl } from "../api/client";
import {
  historyKeyAction,
  isTextEntry,
  keyAction,
  type PlayerAction,
  type SegmentAction,
  segmentKeyAction,
  zoomKeyAction,
} from "../lib/keymap";
import { clampSize, loadSizes, type PanelSizes, saveSizes } from "../lib/layout";
import { markIn, markOut, moveEdge, removeAt, segmentAt, setCameraView } from "../lib/segments";
import { followFrame, type FrameRange, fullView, zoomView } from "../lib/timeline";
import type { Workspace as WorkspaceName } from "../lib/workspaces";
import { usePlayer } from "../player/usePlayer";
import { Monitor } from "./Monitor";
import type { PanelId } from "./Panel";
import { CalibrationPanel, CourtPanel, InspectorPanel, RalliesPanel } from "./SidePanels";
import { Splitter } from "./Splitter";
import { StatusBar } from "./StatusBar";
import { Timeline } from "./Timeline";
import { useRecording } from "./useRecording";

const ZOOM_STEP = 1.5;

const MESSAGES: Record<WorkspaceName, string> = {
  calibrate:
    "Mark Play Segments: Shift+I and Shift+O at the first and last frame, 1 / 2 for Main or Sideline. Calibration isn't built yet.",
  annotate: "Rally and Shot entry isn't built yet. Playback and the Timeline work.",
  review: "Review needs pre-filled Rally Logs, which don't exist yet.",
};

/**
 * A Match open in one workspace: Monitor and right column over Rallies and Timeline, with
 * resizable gutters. The player lives here so the Monitor and the Timeline share it.
 */
export function Workspace({ match, workspace }: { match: MatchDetail; workspace: WorkspaceName }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, controls] = usePlayer(videoRef);
  const { frame, totalFrames, speed } = state;
  const { step, togglePlay, setSpeed } = controls;
  const [gotoOpen, setGotoOpen] = useState(false);
  const [view, setView] = useState<FrameRange>(() => fullView(totalFrames));
  const [viewFor, setViewFor] = useState(totalFrames);
  const [followedFrame, setFollowedFrame] = useState(frame);
  const [sizes, setSizes] = useState<PanelSizes>(loadSizes);
  const [focused, setFocused] = useState<PanelId>("monitor");
  const gridRef = useRef<HTMLDivElement>(null);
  const [recordingState, recording] = useRecording(match.id);
  const calibrating = workspace === "calibrate";

  // Show the whole video once its length is first known, then page the view whenever the
  // playhead moves off screen. Paging only when the frame changes leaves the view where the
  // overview put it while paused. Both adjust state while rendering, React's pattern for state
  // that follows props, and settle on one view so neither update overrides the other.
  let nextView = view;
  if (viewFor !== totalFrames) {
    setViewFor(totalFrames);
    // A later correction of the length (at the last frame) keeps the zoom.
    if (viewFor === 0) nextView = fullView(totalFrames);
  }
  if (followedFrame !== frame) {
    setFollowedFrame(frame);
    nextView = followFrame(nextView, frame);
  }
  if (nextView !== view) setView(nextView);
  useEffect(() => saveSizes(sizes), [sizes]);

  const zoom = useCallback(
    (direction: "in" | "out") =>
      setView((v) =>
        zoomView(v, direction === "in" ? 1 / ZOOM_STEP : ZOOM_STEP, frame, totalFrames),
      ),
    [frame, totalFrames],
  );

  // An Effect Event reads the latest frame, speed and controls, so the window listener is added
  // once instead of again on every frame during playback.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const run = (action: PlayerAction) => {
      switch (action.type) {
        case "togglePlay":
          return togglePlay();
        case "step":
          return step(action.frames, action.pause);
        case "setSpeed":
          return setSpeed(action.speed);
        case "openGoto":
          return setGotoOpen(true);
      }
    };
    const edit = (action: SegmentAction) => {
      switch (action.type) {
        case "markIn":
          return recording.editSegments((segments, pending) => markIn(segments, pending, frame));
        case "markOut":
          return recording.editSegments((segments, pending) => markOut(segments, pending, frame));
        case "setView":
          return recording.editSegments((segments, pending) =>
            setCameraView(segments, pending, frame, action.view),
          );
        case "remove":
          return recording.editSegments((segments, pending) => removeAt(segments, pending, frame));
        case "cancel":
          return recording.cancelPending();
      }
    };
    if (isTextEntry(event.target)) return;
    if (calibrating && totalFrames > 0) {
      const historyAction = historyKeyAction(event);
      if (historyAction) {
        event.preventDefault();
        if (!event.repeat) recording[historyAction]();
        return;
      }
      const segmentAction = segmentKeyAction(event);
      if (segmentAction) {
        event.preventDefault();
        if (!event.repeat) edit(segmentAction);
        return;
      }
    }
    const zoomDirection = zoomKeyAction(event);
    if (zoomDirection) {
      event.preventDefault();
      zoom(zoomDirection);
      return;
    }
    const action = keyAction(event, speed);
    if (!action) return;
    event.preventDefault();
    // Only frame stepping repeats while a key is held.
    if (event.repeat && action.type !== "step") return;
    run(action);
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // The panel last pressed gets the focus outline.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const onPointerDown = (event: PointerEvent) => {
      const panel = event.target instanceof Element ? event.target.closest("[data-panel]") : null;
      if (panel instanceof HTMLElement) setFocused(panel.dataset.panel as PanelId);
    };
    grid.addEventListener("pointerdown", onPointerDown);
    return () => grid.removeEventListener("pointerdown", onPointerDown);
  }, []);

  const resize = (key: keyof PanelSizes, value: number) =>
    setSizes((s) => ({ ...s, [key]: clampSize(key, value) }));
  const gridRect = () => gridRef.current?.getBoundingClientRect();

  const src = match.video_status === "ready" ? matchVideoUrl(match.id) : null;
  const segments = recordingState.recording?.segments ?? null;
  const segment = segments && segmentAt(segments, frame);

  return (
    <div className="match-frame">
      <div
        ref={gridRef}
        className="workspace"
        style={
          {
            "--w-side": `${sizes.side}px`,
            "--h-bottom": `${sizes.bottom}px`,
            "--w-rallies": `${sizes.rallies}px`,
          } as React.CSSProperties
        }
      >
        <Monitor
          match={match}
          src={src}
          title={calibrating ? "Program: Calibrate" : "Program"}
          videoRef={videoRef}
          state={state}
          controls={controls}
          gotoOpen={gotoOpen}
          onCloseGoto={() => setGotoOpen(false)}
          focused={focused === "monitor"}
          cameraView={segments ? (segment?.camera_view ?? "none") : null}
        />
        <Splitter
          className="splitter-side"
          orientation="vertical"
          label="Resize the right column"
          value={sizes.side}
          onDrag={(x) => {
            const rect = gridRect();
            if (rect) resize("side", rect.right - x);
          }}
          onNudge={(delta) => resize("side", sizes.side - delta)}
        />
        <div className={`side-column ${calibrating ? "single" : ""}`}>
          {calibrating ? (
            <CalibrationPanel focused={focused === "calibration"} />
          ) : (
            <>
              <CourtPanel match={match} focused={focused === "court"} />
              <InspectorPanel focused={focused === "inspector"} />
            </>
          )}
        </div>
        <Splitter
          className="splitter-bottom"
          orientation="horizontal"
          label="Resize the bottom row"
          value={sizes.bottom}
          onDrag={(_x, y) => {
            const rect = gridRect();
            if (rect) resize("bottom", rect.bottom - y);
          }}
          onNudge={(delta) => resize("bottom", sizes.bottom - delta)}
        />
        <RalliesPanel focused={focused === "rallies"} />
        <Splitter
          className="splitter-rallies"
          orientation="vertical"
          label="Resize the Rallies panel"
          value={sizes.rallies}
          onDrag={(x) => {
            const rect = gridRect();
            if (rect) resize("rallies", x - rect.left);
          }}
          onNudge={(delta) => resize("rallies", sizes.rallies + delta)}
        />
        <Timeline
          view={view}
          onViewChange={setView}
          frame={frame}
          totalFrames={totalFrames}
          onSeek={controls.seek}
          onZoom={zoom}
          focused={focused === "timeline"}
          segments={segments}
          pending={calibrating ? recordingState.pending : null}
          editableSegments={calibrating}
          onMoveEdge={(segmentStart, edge, to) =>
            recording.editSegments((current, pending) =>
              moveEdge(current, pending, segmentStart, edge, to),
            )
          }
        />
      </div>
      <StatusBar
        message={(calibrating && recordingState.message) || MESSAGES[workspace]}
        saveStatus={recordingState.saveStatus}
        totalFrames={totalFrames}
      />
    </div>
  );
}
