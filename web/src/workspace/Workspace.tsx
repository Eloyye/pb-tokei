import { useCallback, useEffect, useRef, useState } from "react";
import { type MatchDetail, matchVideoUrl } from "../api/client";
import { isTextEntry, keyAction, type PlayerAction, zoomKeyAction } from "../lib/keymap";
import { clampSize, loadSizes, type PanelSizes, saveSizes } from "../lib/layout";
import { followFrame, type FrameRange, fullView, zoomView } from "../lib/timeline";
import type { Workspace as WorkspaceName } from "../lib/workspaces";
import { usePlayer } from "../player/usePlayer";
import { Monitor } from "./Monitor";
import type { PanelId } from "./Panel";
import { CalibrationPanel, CourtPanel, InspectorPanel, RalliesPanel } from "./SidePanels";
import { Splitter } from "./Splitter";
import { StatusBar } from "./StatusBar";
import { Timeline } from "./Timeline";

const ZOOM_STEP = 1.5;

const MESSAGES: Record<WorkspaceName, string> = {
  calibrate: "Calibration and Play Segment marking aren't built yet.",
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
  const [sizes, setSizes] = useState<PanelSizes>(loadSizes);
  const [focused, setFocused] = useState<PanelId>("monitor");
  const gridRef = useRef<HTMLDivElement>(null);

  // Show the whole video once its length is known, then page the view to keep the playhead on
  // screen. Both adjust state while rendering, React's pattern for state that follows props.
  if (viewFor !== totalFrames) {
    setViewFor(totalFrames);
    setView(fullView(totalFrames));
  }
  const followed = followFrame(view, frame);
  if (followed !== view) setView(followed);
  useEffect(() => saveSizes(sizes), [sizes]);

  const zoom = useCallback(
    (direction: "in" | "out") =>
      setView((v) =>
        zoomView(v, direction === "in" ? 1 / ZOOM_STEP : ZOOM_STEP, frame, totalFrames),
      ),
    [frame, totalFrames],
  );

  useEffect(() => {
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;
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
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [speed, step, togglePlay, setSpeed, zoom]);

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
  const calibrating = workspace === "calibrate";

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
          editableSegments={calibrating}
        />
      </div>
      <StatusBar message={MESSAGES[workspace]} totalFrames={totalFrames} />
    </div>
  );
}
