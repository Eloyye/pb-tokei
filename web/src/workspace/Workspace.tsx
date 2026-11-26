import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  type FrameDetectionOut,
  type Landmark,
  type MatchDetail,
  matchVideoUrl,
} from "../api/client";
import {
  calibrationAt,
  calibrationKeyFor,
  clearLandmark,
  confirmAllLandmarks,
  confirmLandmark,
  currentFit,
  deleteCalibration,
  fitKey,
  landmarkLabel,
  markNotVisible,
  newCalibration,
  nextLandmark,
  placeLandmark,
  type Point,
  reanchorCalibration,
  reuseCalibration,
  skipLandmark,
  unmappedRangeAt,
} from "../lib/calibrations";
import {
  type CalibrationAction,
  calibrationKeyAction,
  historyKeyAction,
  isTextEntry,
  keyAction,
  type PlayerAction,
  type SegmentAction,
  segmentKeyAction,
  zoomKeyAction,
} from "../lib/keymap";
import { clampSize, loadSizes, type PanelSizes, saveSizes } from "../lib/layout";
import {
  courtPointToImage,
  deletePlayerAnchor,
  deleteTeamEnd,
  imagePointToCourt,
  setPlayerAnchor,
  swapTeamEnds,
  swapTeamPartners,
} from "../lib/players";
import { markIn, markOut, moveEdge, removeAt, segmentAt, setCameraView } from "../lib/segments";
import { type FrameRange, fullView, reconcileView, ZOOM_STEP, zoomView } from "../lib/timeline";
import type { Workspace as WorkspaceName } from "../lib/workspaces";
import { usePlayer } from "../player/usePlayer";
import { Monitor } from "./Monitor";
import type { PanelId } from "./Panel";
import { CalibrationOverlay } from "./CalibrationOverlay";
import { type CalibrateTab, CalibrationPanel } from "./CalibrationPanel";
import { PlayerOverlay } from "./PlayerOverlay";
import { PlayersPanel } from "./PlayersPanel";
import { CourtPanel, InspectorPanel, RalliesPanel } from "./SidePanels";
import { Splitter } from "./Splitter";
import { StatusBar } from "./StatusBar";
import { Timeline } from "./Timeline";
import { useCameraMotion } from "./useCameraMotion";
import { usePlayerTracking } from "./usePlayerTracking";
import { useRecording } from "./useRecording";

const MESSAGES: Record<WorkspaceName, string> = {
  calibrate:
    "Mark Play Segments with Shift+I and Shift+O, 1 / 2 for Main or Sideline; calibrate Landmarks, then track and anchor Players.",
  annotate:
    "Live tracked Players show on the Monitor and Court diagram; click a box or drag a dot to fix.",
  review: "Review needs pre-filled Rally Logs, which don't exist yet.",
};

/**
 * A Match open in one workspace: Monitor and right column over Rallies and Timeline, with
 * resizable gutters. The player lives here so the Monitor and the Timeline share it.
 */
export function Workspace({ match, workspace }: { match: MatchDetail; workspace: WorkspaceName }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, controls] = usePlayer(videoRef);
  const { frame, totalFrames, playing, speed } = state;
  const { step, togglePlay, setSpeed } = controls;
  const [gotoOpen, setGotoOpen] = useState(false);
  const [view, setView] = useState<FrameRange>(() => fullView(totalFrames));
  const [previousPosition, setPreviousPosition] = useState({ frame, totalFrames });
  const [sizes, setSizes] = useState<PanelSizes>(loadSizes);
  const [focused, setFocused] = useState<PanelId>("monitor");
  const gridRef = useRef<HTMLDivElement>(null);
  const [recordingState, recording] = useRecording(match.id);
  const calibrating = workspace === "calibrate";
  const annotating = workspace === "annotate";
  const [calibrateTab, setCalibrateTab] = useState<CalibrateTab>("landmarks");
  const [calibrateSelectedPlayerId, setCalibrateSelectedPlayerId] = useState<string | null>(
    () => match.players[0]?.id ?? null,
  );
  // In Annotate, no Player is selected until the operator explicitly clicks one in CourtPanel or
  // the Monitor overlay, so clicking the video toggles play/pause instead of saving an anchor.
  const [annotateSelectedPlayerId, setAnnotateSelectedPlayerId] = useState<string | null>(null);
  const selectedPlayerId = calibrating ? calibrateSelectedPlayerId : annotateSelectedPlayerId;
  const setSelectedPlayerId = calibrating
    ? setCalibrateSelectedPlayerId
    : setAnnotateSelectedPlayerId;
  const [showPlayerOverlay, setShowPlayerOverlay] = useState(true);

  const segments = recordingState.recording?.segments ?? null;
  const segment = (segments && segmentAt(segments, frame)) || undefined;

  // Calibration at the playhead: the one in effect for its Play Segment's Camera View, and the
  // Landmark to place next. The selection belongs to one Calibration; on another, it restarts.
  const calibrations = recordingState.recording?.calibrations ?? [];
  const anchors = recordingState.recording?.anchors ?? [];
  const teamEnds = recordingState.recording?.teamEnds ?? [];
  const cameraMotion = useCameraMotion(
    match.id,
    (calibrating || annotating) && match.video_status === "ready",
    recordingState.saveStatus,
    segments,
    calibrations,
    frame,
    calibrating,
  );
  const playerTracking = usePlayerTracking(
    match.id,
    (calibrating || annotating) && match.video_status === "ready",
    recordingState.saveStatus,
    segments,
    calibrations,
    anchors,
    teamEnds,
    cameraMotion.motion?.tracked_spans ?? 0,
    frame,
  );
  const unmappedRanges = cameraMotion.motion?.unmapped_ranges ?? [];
  const unmappedHere = unmappedRangeAt(unmappedRanges, frame);
  const calibration = segment && calibrationAt(calibrations, segment.camera_view, frame);
  const calibrationKey = segment ? calibrationKeyFor(segment, calibration) : null;
  const activeFit = calibration ? currentFit(recordingState.fits, calibration) : undefined;
  const activeCourtToImage = cameraMotion.frameUnmapped
    ? null
    : cameraMotion.frameMatrix !== undefined
      ? cameraMotion.frameMatrix
      : (activeFit?.court_to_image ??
        (calibration ? recordingState.fits.get(fitKey(calibration))?.court_to_image : null) ??
        null);
  const activeLens =
    !cameraMotion.frameUnmapped && cameraMotion.frameMatrix !== undefined
      ? cameraMotion.frameLens
      : null;

  const oppositeEndFlipYFt = playerTracking.status?.opposite_end_flip_y_ft;

  const assignPlayerDetection = (playerId: string, point: Point, detection: FrameDetectionOut) => {
    const courtY =
      detection.court_y ??
      imagePointToCourt(
        { x: detection.foot_x, y: detection.foot_y },
        activeCourtToImage,
        activeLens,
      )?.y ??
      null;
    const result = recording.editPlayers((curAnchors, curEnds) =>
      setPlayerAnchor(
        curAnchors,
        curEnds,
        match,
        frame,
        playerId,
        "identity",
        point,
        courtY,
        oppositeEndFlipYFt,
      ),
    );
    if (calibrating) {
      if (result?.nextSelected) setCalibrateSelectedPlayerId(result.nextSelected);
    } else {
      setAnnotateSelectedPlayerId(null);
    }
  };

  const movePlayerOnMonitor = (playerId: string, point: Point) => {
    const courtY = imagePointToCourt(point, activeCourtToImage, activeLens)?.y ?? null;
    recording.editPlayers((curAnchors, curEnds) =>
      setPlayerAnchor(
        curAnchors,
        curEnds,
        match,
        frame,
        playerId,
        "position",
        point,
        courtY,
        oppositeEndFlipYFt,
      ),
    );
    if (!calibrating) setAnnotateSelectedPlayerId(null);
  };

  const movePlayerOnCourt = (playerId: string, courtPoint: Point) => {
    const imagePt = courtPointToImage(courtPoint, activeCourtToImage, activeLens);
    if (!imagePt) {
      recording.notify(
        segment
          ? "Calibrate this Camera View first (or point is outside the video frame)"
          : "Seek to a calibrated Play Segment to place Players",
      );
      return;
    }
    recording.editPlayers((curAnchors, curEnds) =>
      setPlayerAnchor(
        curAnchors,
        curEnds,
        match,
        frame,
        playerId,
        "position",
        imagePt,
        courtPoint.y,
        oppositeEndFlipYFt,
      ),
    );
    if (!calibrating) setAnnotateSelectedPlayerId(null);
  };

  const placeSelectedOnCourt = (courtPoint: Point) => {
    if (!selectedPlayerId) return recording.notify("Select a Player first");
    movePlayerOnCourt(selectedPlayerId, courtPoint);
  };

  const swapTeam = (team: "a" | "b") => {
    recording.editPlayers((curAnchors, curEnds) =>
      swapTeamPartners(curAnchors, curEnds, match, team, frame, playerTracking.frameData),
    );
  };

  const swapEnds = () => {
    recording.editPlayers((curAnchors, curEnds) =>
      swapTeamEnds(curAnchors, curEnds, match, frame, playerTracking.frameData?.near_team_id),
    );
  };
  const [selection, setSelection] = useState<{ key: string | null; landmark: Landmark | null }>({
    key: null,
    landmark: null,
  });
  const selected =
    selection.key === calibrationKey
      ? selection.landmark
      : nextLandmark(calibration?.landmarks ?? {}, null, calibration?.not_visible ?? []);
  const select = (landmark: Landmark | null) => setSelection({ key: calibrationKey, landmark });

  const place = (landmark: Landmark, point: Point, how: "click" | "drag") => {
    if (!segment) return;
    recording.editCalibrations((list) => {
      const edit = placeLandmark(list, segment, frame, landmark, point);
      // The first click creates the Calibration; the selection follows it either way.
      if (edit.edited) {
        const next =
          how === "drag"
            ? landmark
            : nextLandmark(edit.edited.landmarks, landmark, edit.edited.not_visible);
        setSelection({ key: fitKey(edit.edited), landmark: next });
      }
      return edit;
    });
  };

  const setNotVisible = (landmark: Landmark) => {
    if (!segment) return;
    recording.editCalibrations((list) => {
      const edit = markNotVisible(list, segment, frame, landmark);
      if (edit.edited) {
        const next = nextLandmark(edit.edited.landmarks, landmark, edit.edited.not_visible);
        setSelection({ key: fitKey(edit.edited), landmark: next });
      }
      return edit;
    });
  };

  const confirmOne = (landmark: Landmark) => {
    if (!segment) return;
    const resolved =
      calibration && frame === calibration.reference_frame
        ? activeFit?.resolved_landmarks[landmark]
        : undefined;
    recording.editCalibrations((list) =>
      confirmLandmark(list, segment.camera_view, frame, landmark, resolved),
    );
  };

  const confirmAllHere = () => {
    if (!segment) return;
    const resolved =
      calibration && frame === calibration.reference_frame
        ? activeFit?.resolved_landmarks
        : undefined;
    recording.editCalibrations((list) =>
      confirmAllLandmarks(list, segment.camera_view, frame, resolved),
    );
  };

  const calibrate = (action: CalibrationAction) => {
    if (!segment) return recording.notify("Go to a Play Segment to calibrate its Camera View");
    switch (action) {
      case "new":
        return recording.editCalibrations((list) => newCalibration(list, segment, frame));
      case "skip": {
        const next = skipLandmark(selected);
        select(next);
        return recording.notify(`Next: ${landmarkLabel(next)}`);
      }
      case "clear":
        if (!selected) return recording.notify("Pick a Landmark in the list first");
        return recording.editCalibrations((list) =>
          clearLandmark(list, segment.camera_view, frame, selected),
        );
      case "notVisible":
        if (!selected) return recording.notify("Pick a Landmark in the list first");
        return setNotVisible(selected);
      case "confirm":
        if (!selected) return recording.notify("Pick a Landmark in the list first");
        return confirmOne(selected);
    }
  };

  // Reconcile the Timeline while rendering so duration and playhead updates use one view.
  // Paging only on frame changes lets the overview pan while paused.
  if (previousPosition.totalFrames !== totalFrames || previousPosition.frame !== frame) {
    const position = { frame, totalFrames };
    const nextView = reconcileView(view, previousPosition, position);
    setPreviousPosition(position);
    if (nextView !== view) setView(nextView);
  }
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
          return recording.editSegments((current, pending) => markIn(current, pending, frame));
        case "markOut":
          return recording.editSegments((current, pending) => markOut(current, pending, frame));
        case "setView":
          return recording.editSegments((current, pending) =>
            setCameraView(current, pending, frame, action.view),
          );
        case "remove":
          return recording.editSegments((current, pending) => removeAt(current, pending, frame));
        case "cancel":
          return recording.cancelPending();
      }
    };
    if (isTextEntry(event.target)) return;
    if ((calibrating || annotating) && totalFrames > 0) {
      const historyAction = historyKeyAction(event);
      if (historyAction) {
        event.preventDefault();
        if (!event.repeat) recording[historyAction]();
        return;
      }
    }
    if (calibrating && totalFrames > 0) {
      const segmentAction = segmentKeyAction(event);
      if (segmentAction) {
        event.preventDefault();
        if (!event.repeat) edit(segmentAction);
        return;
      }
      if (calibrateTab === "landmarks") {
        const calibrationAction = calibrationKeyAction(event);
        if (calibrationAction) {
          event.preventDefault();
          if (!event.repeat) calibrate(calibrationAction);
          return;
        }
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

  // Fixed per Match: a URL that changed on a later render would reload the video.
  const src = useMemo(
    () => (match.video_status === "ready" ? matchVideoUrl(match.id) : null),
    [match.id, match.video_status],
  );

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
          title={
            calibrating
              ? calibrateTab === "players"
                ? "Program: Players"
                : "Program: Calibrate"
              : "Program"
          }
          videoRef={videoRef}
          state={state}
          controls={controls}
          gotoOpen={gotoOpen}
          onCloseGoto={() => setGotoOpen(false)}
          focused={focused === "monitor"}
          cameraView={segments ? (segment?.camera_view ?? "none") : null}
          headerTools={
            annotating &&
            src && (
              <div className="monitor-player-tools">
                <button
                  type="button"
                  className={`icon-button ${showPlayerOverlay ? "active" : ""}`}
                  aria-pressed={showPlayerOverlay}
                  title="Toggle Player overlay on the Monitor"
                  onClick={() => setShowPlayerOverlay((v) => !v)}
                >
                  Players
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Swap Team A partners from the playhead forward"
                  onClick={() => swapTeam("a")}
                >
                  Swap A
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Swap Team B partners from the playhead forward"
                  onClick={() => swapTeam("b")}
                >
                  Swap B
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Swap near and far Team ends from the playhead forward"
                  onClick={swapEnds}
                >
                  Swap ends
                </button>
              </div>
            )
          }
          overlay={
            calibrating && calibrateTab === "landmarks" && segments ? (
              <CalibrationOverlay
                videoRef={videoRef}
                frame={frame}
                calibration={calibration}
                fit={activeFit}
                lastFit={calibration && recordingState.fits.get(fitKey(calibration))}
                frameMatrix={cameraMotion.frameMatrix}
                frameLens={cameraMotion.frameLens}
                unmapped={cameraMotion.frameUnmapped}
                selected={selected}
                editable={Boolean(segment)}
                onPlace={place}
                onSelect={select}
                onBlocked={recording.notify}
              />
            ) : (calibrating && calibrateTab === "players") || (annotating && showPlayerOverlay) ? (
              <PlayerOverlay
                videoRef={videoRef}
                players={match.players}
                frameData={playerTracking.frameData}
                selectedPlayerId={selectedPlayerId}
                editable={Boolean(segment)}
                clickEmptyPlaces={calibrating && calibrateTab === "players"}
                onSelectPlayer={setSelectedPlayerId}
                onAssignDetection={assignPlayerDetection}
                onMovePlayer={movePlayerOnMonitor}
                onBackgroundClick={annotating ? controls.togglePlay : undefined}
              />
            ) : undefined
          }
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
            <CalibrationPanel
              focused={focused === "calibration"}
              frame={frame}
              segment={segment}
              calibration={calibration}
              calibrations={calibrations}
              fits={recordingState.fits}
              motion={cameraMotion.motion}
              unmappedRange={unmappedHere}
              selected={selected}
              onSelect={select}
              onSeek={controls.seek}
              onDelete={(cameraView, from) =>
                recording.editCalibrations((list) => deleteCalibration(list, cameraView, from))
              }
              onReuse={(source) => {
                if (!segment) return;
                recording.editCalibrations((list) =>
                  reuseCalibration(list, source, segment, frame),
                );
              }}
              onReanchor={() => {
                if (!segment) return;
                recording.editCalibrations((list) => reanchorCalibration(list, segment, frame));
              }}
              onMarkNotVisible={setNotVisible}
              onClearLandmark={(landmark) => {
                if (!segment) return;
                recording.editCalibrations((list) =>
                  clearLandmark(list, segment.camera_view, frame, landmark),
                );
              }}
              onConfirmLandmark={confirmOne}
              onConfirmAll={confirmAllHere}
              onRetrack={cameraMotion.retrack}
              activeTab={calibrateTab}
              onTabChange={setCalibrateTab}
              playersPanel={
                <PlayersPanel
                  match={match}
                  frame={frame}
                  tracking={playerTracking.status}
                  frameData={playerTracking.frameData}
                  anchors={anchors}
                  teamEnds={teamEnds}
                  selectedPlayerId={selectedPlayerId}
                  onSelectPlayer={setSelectedPlayerId}
                  onTrack={() => playerTracking.startTracking(frame)}
                  onCancelTrack={playerTracking.cancelTracking}
                  onSwapTeam={swapTeam}
                  onSwapEnds={swapEnds}
                  onMovePlayerOnCourt={movePlayerOnCourt}
                  onPlacePlayerOnCourt={placeSelectedOnCourt}
                  onSeek={controls.seek}
                  onDeleteAnchor={(anchorFrame, playerId) => {
                    const name = match.players.find((p) => p.id === playerId)?.name;
                    recording.editPlayers((curAnchors, curEnds) =>
                      deletePlayerAnchor(curAnchors, curEnds, anchorFrame, playerId, name),
                    );
                  }}
                  onDeleteTeamEnd={(effectiveFrom) =>
                    recording.editPlayers((curAnchors, curEnds) =>
                      deleteTeamEnd(curAnchors, curEnds, effectiveFrom),
                    )
                  }
                />
              }
            />
          ) : (
            <>
              <CourtPanel
                match={match}
                focused={focused === "court"}
                frame={frame}
                frameData={playerTracking.frameData}
                teamEnds={teamEnds}
                selectedPlayerId={selectedPlayerId}
                onSelectPlayer={setSelectedPlayerId}
                onMovePlayer={movePlayerOnCourt}
                onPlaceOnCourt={placeSelectedOnCourt}
              />
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
          playing={playing}
          onSeek={controls.seek}
          onZoom={zoom}
          focused={focused === "timeline"}
          segments={segments}
          unmappedRanges={calibrating ? unmappedRanges : undefined}
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
        message={((calibrating || annotating) && recordingState.message) || MESSAGES[workspace]}
        saveStatus={recordingState.saveStatus}
        totalFrames={totalFrames}
      />
    </div>
  );
}
