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
  type AnnotateContext,
  type AnnotateEdit,
  addShot,
  clampSelection,
  cycleCertainty,
  deleteEntry,
  deleteGame,
  deleteRally,
  insertUnseenRally,
  markRallyDone,
  markRallyEnd,
  markRallyStart,
  moveContact,
  moveShotPosition,
  NO_SELECTION,
  nextRallySelection,
  nextShotSelection,
  parkedOnShot,
  RALLY_FIELDS,
  type RallyField,
  type Selection,
  SHOT_FIELDS,
  type ShotField,
  type Stash,
  selectedRally,
  selectedShot,
  selectRally,
  setContactKind,
  setError,
  setLanding,
  setRallyEdge,
  setRefereeCall,
  setShotClass,
  startNextGame,
  swapHitterToPartner,
  swapShotTeammates,
  switchHitterTeam,
  syncShotPositions,
  toggleFlag,
  toggleGap,
} from "../lib/annotate";
import { type CourtView, FIT_COURT } from "../lib/courtView";
import {
  type AnnotateAction,
  annotateKeyAction,
  type CalibrationAction,
  calibrationKeyAction,
  historyKeyAction,
  isPanelSwapKey,
  isTextEntry,
  keyAction,
  type PlayerAction,
  ruleIssueKeyAction,
  type SegmentAction,
  segmentKeyAction,
  zoomKeyAction,
} from "../lib/keymap";
import {
  clampSize,
  type CourtSlot,
  loadCourtLayout,
  loadSizes,
  type PanelSizes,
  saveCourtLayout,
  saveSizes,
} from "../lib/layout";
import {
  courtPointToImage,
  deletePlayerAnchor,
  deleteTeamEnd,
  imagePointToCourt,
  setPlayerAnchor,
  swapTeamEnds,
  swapTeamPartners,
} from "../lib/players";
import { isShot, positionsFromTracking, rosterOf, shotsOf } from "../lib/rallyLog";
import {
  checkMatch,
  countIssues,
  formatIssueHint,
  nextRuleIssue,
  type RuleIssue,
} from "../lib/ruleChecks";
import { markIn, markOut, moveEdge, removeAt, segmentAt, setCameraView } from "../lib/segments";
import {
  fitRange,
  type FrameRange,
  fullView,
  reconcileView,
  ZOOM_STEP,
  zoomView,
} from "../lib/timeline";
import type { Workspace as WorkspaceName } from "../lib/workspaces";
import { usePlayer } from "../player/usePlayer";
import { Monitor } from "./Monitor";
import type { PanelId } from "./Panel";
import { CalibrationOverlay } from "./CalibrationOverlay";
import { type CalibrateTab, CalibrationPanel } from "./CalibrationPanel";
import type { CourtNavigation } from "./CourtDiagram";
import { PlayerOverlay } from "./PlayerOverlay";
import { PlayersPanel } from "./PlayersPanel";
import { type InspectorForm, InspectorPanel, type InspectorTab } from "./Inspector";
import { RalliesPanel } from "./RalliesPanel";
import { CourtPanel } from "./SidePanels";
import { Splitter } from "./Splitter";
import { StatusBar } from "./StatusBar";
import { Timeline } from "./Timeline";
import { useCameraMotion } from "./useCameraMotion";
import { usePlayerTracking } from "./usePlayerTracking";
import { useActionQueue } from "./useActionQueue";
import { useRecording } from "./useRecording";

const MESSAGES: Record<WorkspaceName, string> = {
  calibrate:
    "Mark Play Segments with Shift+I and Shift+O, 1 / 2 for Main or Sideline; calibrate Landmarks, then track and anchor Players.",
  annotate:
    "⇧I at a Serve starts a Rally, M adds a Shot at each contact, Enter marks it Done; ? lists every key.",
  review: "Review needs pre-filled Rally Logs, which don't exist yet.",
};

/**
 * A Match open in one workspace: Monitor, Court and Inspector over Rallies and Timeline, with
 * resizable gutters. The player lives here so the Monitor and the Timeline share it.
 */
export function Workspace({ match, workspace }: { match: MatchDetail; workspace: WorkspaceName }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, controls] = usePlayer(videoRef);
  const { frame, previewFrame, totalFrames, playing, speed } = state;
  const { step, togglePlay, setSpeed } = controls;
  const [gotoOpen, setGotoOpen] = useState(false);
  const [view, setView] = useState<FrameRange>(() => fullView(totalFrames));
  const [previousPosition, setPreviousPosition] = useState({ frame, totalFrames });
  const [sizes, setSizes] = useState<PanelSizes>(loadSizes);
  const [focused, setFocused] = useState<PanelId>("monitor");
  const gridRef = useRef<HTMLDivElement>(null);
  const [recordingState, recording] = useRecording(match.id);
  const defaultMessage = MESSAGES[workspace];
  const { notify } = recording;
  useEffect(() => notify(defaultMessage), [defaultMessage, notify]);
  const [edgeDragHint, setEdgeDragHint] = useState<string | null>(null);
  const calibrating = workspace === "calibrate";
  const annotating = workspace === "annotate";
  const reviewing = workspace === "review";
  const showRuleChecks = annotating || reviewing;
  const [calibrateTab, setCalibrateTab] = useState<CalibrateTab>("landmarks");
  const [courtLayout, setCourtLayout] = useState(loadCourtLayout);
  const [courtView, setCourtView] = useState<CourtView>(FIT_COURT);
  const spaceKey = useRef<"up" | "held" | "used">("up");
  const swapped = !calibrating && courtLayout.swapped;
  const courtSlot: CourtSlot = swapped ? "main" : "side";
  const courtNavigation: CourtNavigation = {
    orientation: courtLayout.orientation[courtSlot],
    view: courtView,
    setView: setCourtView,
    consumeSpaceForPan: () => {
      if (spaceKey.current === "up") return false;
      spaceKey.current = "used";
      return true;
    },
    toggleOrientation: () =>
      setCourtLayout((layout) => ({
        ...layout,
        orientation: {
          ...layout.orientation,
          [courtSlot]: layout.orientation[courtSlot] === "vertical" ? "horizontal" : "vertical",
        },
      })),
  };
  const swapPanels = () => setCourtLayout((layout) => ({ ...layout, swapped: !layout.swapped }));
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

  // Rally and Shot entry (#12): what is selected, the Inspector's tab, field cursor and form.
  const roster = useMemo(() => rosterOf(match), [match]);
  const games = useMemo(() => recordingState.recording?.games ?? [], [recordingState.recording]);
  const [rallySelection, setRallySelection] = useState<Selection>(NO_SELECTION);
  const current = clampSelection(games, rallySelection);
  const currentRally = selectedRally(games, current);
  const currentShot = selectedShot(games, current);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("shot");
  const [cursor, setCursor] = useState<Record<InspectorTab, number>>({ shot: 0, rally: 0 });
  const [form, setForm] = useState<InspectorForm>(null);
  const stashRef = useRef<Stash>(new Map());
  const lastJumpedIssueIdRef = useRef<string | null>(null);

  // Live non-blocking rule checks (#13) across all Games in Annotate and Review.
  const ruleIssues = useMemo(
    () => (showRuleChecks ? checkMatch(games, roster) : []),
    [showRuleChecks, games, roster],
  );
  const issueCounts = useMemo(() => countIssues(ruleIssues), [ruleIssues]);

  const segments = recordingState.recording?.segments ?? null;
  const segment = (segments && segmentAt(segments, frame)) || undefined;
  const monitorSegment =
    previewFrame !== null && segments ? segmentAt(segments, previewFrame) : segment;

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
    if (annotating && parkedOnShot(games, current, frame)) {
      // Parked on the selected Shot's contact: swap those teammates on the Shot too, as one step.
      const teamId = team === "a" ? match.team_a_id : match.team_b_id;
      return recording.editRecording((rec) => {
        const players = swapTeamPartners(
          rec.anchors,
          rec.teamEnds,
          match,
          team,
          frame,
          playerTracking.frameData,
        );
        const shot = swapShotTeammates(
          { games: rec.games, selection: current, roster, frame },
          teamId,
        );
        return {
          recording: {
            ...rec,
            anchors: players.anchors,
            teamEnds: players.teamEnds,
            games: shot.games,
          },
          message: `${players.message}; ${shot.message.toLowerCase()}`,
        };
      });
    }
    recording.editPlayers((curAnchors, curEnds) =>
      swapTeamPartners(curAnchors, curEnds, match, team, frame, playerTracking.frameData),
    );
  };

  const swapEnds = () => {
    recording.editPlayers((curAnchors, curEnds) =>
      swapTeamEnds(curAnchors, curEnds, match, frame, playerTracking.frameData?.near_team_id),
    );
  };
  /** Runs a Rally Log edit (`lib/annotate`) and follows its selection. */
  const annotateEdit = (
    edit: (ctx: AnnotateContext) => AnnotateEdit,
    at: { frame?: number; selection?: Selection } = {},
  ): AnnotateEdit | null => {
    const result = recording.editGames((list) =>
      edit({
        games: list,
        selection: clampSelection(list, at.selection ?? rallySelection),
        roster,
        frame: at.frame ?? frame,
      }),
    );
    if (result) setRallySelection(result.selection);
    return result;
  };

  /** Moves the field cursor to a field, on the Inspector tab that owns it. */
  const focusField = (tab: InspectorTab, field: ShotField | RallyField) => {
    setInspectorTab(tab);
    const index =
      tab === "shot"
        ? SHOT_FIELDS.indexOf(field as ShotField)
        : RALLY_FIELDS.indexOf(field as RallyField);
    if (index >= 0) setCursor((c) => ({ ...c, [tab]: index }));
  };

  /** Fits the Timeline to a Rally (8% padding); false for an Unseen Rally. */
  const fitRally = (rally = currentRally): boolean => {
    if (!rally || rally.start_frame === null) return false;
    const last = shotsOf(rally).at(-1)?.contact_frame.value ?? rally.start_frame;
    const end = rally.end_frame ?? Math.max(rally.start_frame, last);
    setView(fitRange(rally.start_frame, end, totalFrames));
    return true;
  };

  /** Selects a Rally (its first Shot), fits the Timeline to it and seeks to its start. */
  const goToRally = (next: Selection) => {
    setRallySelection(next);
    setForm(null);
    const rally = selectedRally(games, next);
    if (!rally) return;
    fitRally(rally);
    const shot = next.entry === null ? undefined : rally.entries[next.entry];
    const target = isShot(shot) ? shot.contact_frame.value : rally.start_frame;
    if (target !== null) controls.seek(target);
  };

  /** Selects a Shot or Observation Gap and seeks to a Shot's contact. */
  const goToEntry = (next: Selection) => {
    setRallySelection(next);
    const entry = selectedRally(games, next)?.entries[next.entry ?? -1];
    if (isShot(entry) && entry.contact_frame.value !== null)
      controls.seek(entry.contact_frame.value);
  };

  /** Navigates straight to a rule issue's Game, Rally, Shot, Inspector tab, and field cursor. */
  const jumpToIssue = (issue: RuleIssue) => {
    const index = ruleIssues.findIndex((i) => i.id === issue.id);
    lastJumpedIssueIdRef.current = issue.id;
    setForm(null);
    if (issue.entryIndex !== null) {
      setRallySelection({
        game: issue.gameIndex,
        rally: issue.rallyIndex,
        entry: issue.entryIndex,
      });
      if (issue.shotFrame !== null) controls.seek(issue.shotFrame);
      focusField("shot", issue.field as ShotField);
    } else {
      const sameRally = current.game === issue.gameIndex && current.rally === issue.rallyIndex;
      setRallySelection(
        sameRally ? current : selectRally(games, issue.gameIndex, issue.rallyIndex),
      );
      const rally = games[issue.gameIndex]?.rallies[issue.rallyIndex];
      if (rally && rally.start_frame !== null) {
        fitRally(rally);
        controls.seek(rally.start_frame);
      }
      focusField("rally", issue.field as RallyField);
    }
    if (ruleIssues.length > 0) {
      recording.notify(formatIssueHint(issue, index >= 0 ? index : 0, ruleIssues.length));
    }
  };

  /** Cycles chronologically to the next (`1`) or previous (`-1`) rule issue in the Match. */
  const cycleRuleIssue = (direction: 1 | -1) => {
    if (ruleIssues.length === 0) {
      recording.notify("No rule issues in this Match");
      return;
    }
    const focusedField =
      inspectorTab === "shot" ? SHOT_FIELDS[cursor.shot] : RALLY_FIELDS[cursor.rally];
    const next = nextRuleIssue(
      ruleIssues,
      {
        selection: current,
        inspectorTab,
        focusedField,
        lastIssueId: lastJumpedIssueIdRef.current,
      },
      direction,
    );
    if (next) jumpToIssue(next.issue);
  };

  const snapshotAt = async (at: number) => {
    const cached = playerTracking.cachedAt(at);
    return positionsFromTracking(
      roster,
      cached === undefined ? await playerTracking.trackingAt(at) : (cached ?? undefined),
    );
  };

  /** Adds a Shot at `at`; returns a promise while it waits for Player Tracking. */
  const addShotAt = (at: number): Promise<void> | undefined => {
    const cached = playerTracking.cachedAt(at);
    const add = (tracking: Parameters<typeof positionsFromTracking>[1]) => {
      const result = annotateEdit((c) => addShot(c, positionsFromTracking(roster, tracking)), {
        frame: at,
      });
      if (result && result.games !== games) focusField("shot", "hitter_id");
    };
    if (cached !== undefined) {
      add(cached ?? undefined);
      return undefined;
    }
    return playerTracking.trackingAt(at).then(add);
  };

  const syncFromTracking = async () => {
    const at = currentShot?.contact_frame.value;
    if (at === undefined || at === null) return recording.notify("Select a Shot first");
    const snapshot = await snapshotAt(at);
    annotateEdit((c) => syncShotPositions(c, snapshot));
  };

  // Annotate's Space: at the selected Rally's end, replay it (or play on once it is Done).
  const togglePlayAnnotate = () => {
    const rally = currentRally;
    if (
      !playing &&
      rally &&
      rally.end_frame !== null &&
      rally.start_frame !== null &&
      frame === rally.end_frame &&
      rally.status !== "done"
    ) {
      controls.seek(rally.start_frame);
      controls.play();
      return;
    }
    togglePlay();
  };

  /** One Annotate action, at the frame its key was pressed on. */
  const executeAnnotate = ({ action, frame: at }: { action: AnnotateAction; frame: number }) => {
    switch (action.type) {
      case "rallyStart":
        focusField("rally", "frames");
        return annotateEdit(markRallyStart, { frame: at });
      case "rallyEnd":
        focusField("rally", "frames");
        return annotateEdit(markRallyEnd, { frame: at });
      case "refereeCall":
        focusField("rally", "referee_call");
        return annotateEdit((c) => setRefereeCall(c, action.call));
      case "rallyForm":
        if (!currentRally) return recording.notify("Select a Rally first");
        focusField("rally", "score");
        return setForm("details");
      case "challengeForm":
        if (!currentRally) return recording.notify("Select a Rally first");
        focusField("rally", "challenge");
        return setForm("challenge");
      case "unseenRally":
        focusField("rally", "score");
        return annotateEdit(insertUnseenRally);
      case "deleteRally":
        return annotateEdit(deleteRally);
      case "done": {
        const result = annotateEdit(markRallyDone);
        if (result && result.selection.rally !== current.rally) goToRally(result.selection);
        return;
      }
      case "nextGame":
        return annotateEdit(startNextGame);
      case "addShot":
        return addShotAt(at);
      case "shotClass":
        focusField("shot", "shot_class");
        return annotateEdit((c) => setShotClass(c, action.value));
      case "contactKind":
        focusField("shot", "contact_kind");
        return annotateEdit((c) => setContactKind(c, action.value));
      case "swapPartner":
        focusField("shot", "hitter_id");
        return annotateEdit(swapHitterToPartner);
      case "switchTeam":
        focusField("shot", "hitter_id");
        return annotateEdit(switchHitterTeam);
      case "flag":
        focusField("shot", action.flag);
        return annotateEdit((c) => toggleFlag(c, action.flag));
      case "error":
        focusField("shot", "error");
        return annotateEdit((c) => setError(c, action.kind));
      case "gap":
        setInspectorTab("shot");
        return annotateEdit((c) => toggleGap(c, action.parity));
      case "deleteEntry":
        return annotateEdit(deleteEntry);
      case "cycleCertainty": {
        const field =
          inspectorTab === "shot" ? SHOT_FIELDS[cursor.shot] : RALLY_FIELDS[cursor.rally];
        if (!field) return;
        let nextStash = stashRef.current;
        annotateEdit((c) => {
          const result = cycleCertainty(c, inspectorTab, field, stashRef.current);
          nextStash = result.stash;
          return result.edit;
        });
        stashRef.current = nextStash;
        return;
      }
      case "shot": {
        const next = nextShotSelection(games, current, action.direction);
        if (!next) return recording.notify(action.direction === 1 ? "Last Shot" : "First Shot");
        setInspectorTab("shot");
        return goToEntry(next);
      }
      case "rally": {
        const next = nextRallySelection(games, current, action.direction);
        if (!next) return recording.notify(action.direction === 1 ? "Last Rally" : "First Rally");
        return goToRally(next);
      }
      case "cursor": {
        const length = inspectorTab === "shot" ? SHOT_FIELDS.length : RALLY_FIELDS.length;
        return setCursor((c) => ({
          ...c,
          [inspectorTab]: (c[inspectorTab] + action.direction + length) % length,
        }));
      }
      case "escape":
        return setForm(null);
    }
  };

  // While `M` waits for Player Tracking, later Annotate keys queue (with the frame they were
  // pressed at) so they act on the new Shot, in order.
  const queueAnnotate = useActionQueue(executeAnnotate);
  const runAnnotate = (action: AnnotateAction, at = frame) => queueAnnotate({ action, frame: at });

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
  useEffect(() => saveCourtLayout(courtLayout), [courtLayout]);

  // Annotate pauses at the selected Rally's end frame, unless the Rally is Done or playback
  // started after it (docs/annotation-ui.md, "Monitor").
  const [playStart, setPlayStart] = useState<{ playing: boolean; frame: number | null }>({
    playing,
    frame: null,
  });
  if (playStart.playing !== playing) {
    setPlayStart({ playing, frame: playing ? frame : null });
  }
  const pauseAtEnd = useEffectEvent((shown: number) => {
    const rally = currentRally;
    const start = playStart.frame;
    if (!annotating || !playing || !rally || rally.end_frame === null) return;
    if (rally.status === "done" || start === null || start > rally.end_frame) return;
    if (shown >= rally.end_frame) {
      controls.pause();
      controls.seek(rally.end_frame);
      recording.notify("End of Rally: Space replays it, Enter marks it Done");
    }
  });
  useEffect(() => {
    if (playing) pauseAtEnd(frame);
  }, [frame, playing]);

  const zoom = useCallback(
    (direction: "in" | "out") =>
      setView((v) =>
        zoomView(v, direction === "in" ? 1 / ZOOM_STEP : ZOOM_STEP, frame, totalFrames),
      ),
    [frame, totalFrames],
  );

  // An Effect Event reads the latest frame, speed and controls, so the window listener is added
  // once instead of again on every frame during playback.
  const playPause = () => (annotating ? togglePlayAnnotate() : togglePlay());
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const run = (action: PlayerAction) => {
      switch (action.type) {
        case "togglePlay":
          return playPause();
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
          return recording.editSegments((list, pending) => markIn(list, pending, frame));
        case "markOut":
          return recording.editSegments((list, pending) => markOut(list, pending, frame));
        case "setView":
          return recording.editSegments((list, pending) =>
            setCameraView(list, pending, frame, action.view),
          );
        case "remove":
          return recording.editSegments((list, pending) => removeAt(list, pending, frame));
        case "cancel":
          return recording.cancelPending();
      }
    };
    if (event.defaultPrevented || isTextEntry(event.target)) return;
    if (
      (event.key === " " || event.key === "Enter") &&
      event.target instanceof Element &&
      event.target.closest("button[data-court-control]")
    )
      return;
    if (!calibrating && isPanelSwapKey(event)) {
      event.preventDefault();
      if (!event.repeat) swapPanels();
      return;
    }
    if (showRuleChecks && recordingState.recording) {
      const issueDirection = ruleIssueKeyAction(event);
      if (issueDirection !== null) {
        event.preventDefault();
        if (!event.repeat) cycleRuleIssue(issueDirection);
        return;
      }
    }
    if (totalFrames > 0) {
      const historyAction = historyKeyAction(event);
      if (historyAction) {
        event.preventDefault();
        if (!event.repeat) recording[historyAction]();
        return;
      }
    }
    if (annotating && recordingState.recording) {
      const annotateAction = annotateKeyAction(event);
      if (annotateAction) {
        event.preventDefault();
        if (event.repeat && annotateAction.type !== "shot" && annotateAction.type !== "cursor") {
          return;
        }
        runAnnotate(annotateAction);
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
    if (action.type === "togglePlay" && (!calibrating || calibrateTab === "players")) {
      // Wait to see whether the operator uses Space for a Court pan.
      spaceKey.current = "held";
      return;
    }
    run(action);
  });

  const onKeyUp = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== " " && event.code !== "Space") return;
    const previous = spaceKey.current;
    spaceKey.current = "up";
    if (previous === "held" && !event.defaultPrevented && !isTextEntry(event.target)) {
      playPause();
    }
  });
  useEffect(() => {
    const down = (event: KeyboardEvent) => onKeyDown(event);
    const up = (event: KeyboardEvent) => onKeyUp(event);
    const blur = () => {
      spaceKey.current = "up";
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
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

  const swapButton = !calibrating && (
    <button
      type="button"
      className="icon-button panel-swap"
      data-court-control
      aria-label="Swap Court and Monitor"
      aria-pressed={swapped}
      title={"Swap Court and Monitor (`)"}
      onClick={swapPanels}
    >
      ⇄
    </button>
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
        <div className={`workspace-top ${calibrating ? "calibrating" : ""}`}>
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
            controls={annotating ? { ...controls, togglePlay: togglePlayAnnotate } : controls}
            annotate={
              annotating
                ? {
                    onRallyStart: () => runAnnotate({ type: "rallyStart" }),
                    onRallyEnd: () => runAnnotate({ type: "rallyEnd" }),
                    onAddShot: () => runAnnotate({ type: "addShot" }),
                    onRally: (direction) => runAnnotate({ type: "rally", direction }),
                    onShot: (direction) => runAnnotate({ type: "shot", direction }),
                    rallyRange:
                      currentRally && currentRally.start_frame !== null
                        ? `R${currentRally.number} ${currentRally.start_frame}–${currentRally.end_frame ?? "…"}`
                        : null,
                  }
                : undefined
            }
            gotoOpen={gotoOpen}
            onCloseGoto={() => setGotoOpen(false)}
            focused={focused === "monitor"}
            compact={swapped}
            swapButton={swapButton}
            cameraView={segments ? (monitorSegment?.camera_view ?? "none") : null}
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
              ) : (calibrating && calibrateTab === "players") ||
                (annotating && showPlayerOverlay) ? (
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
                  onBackgroundClick={annotating ? togglePlayAnnotate : undefined}
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
                  courtNavigation={courtNavigation}
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
                slot={courtSlot}
                navigation={courtNavigation}
                swapButton={swapButton}
                frame={frame}
                frameData={playerTracking.frameData}
                teamEnds={teamEnds}
                selectedPlayerId={selectedPlayerId}
                onSelectPlayer={setSelectedPlayerId}
                onMovePlayer={movePlayerOnCourt}
                onPlaceOnCourt={placeSelectedOnCourt}
                roster={roster}
                shot={currentShot}
                previousShot={
                  currentRally && current.entry !== null
                    ? shotsOf(currentRally).findLast(
                        (s) => currentRally.entries.indexOf(s) < current.entry!,
                      )
                    : undefined
                }
                onSetLanding={(point) => {
                  focusField("shot", "landing");
                  annotateEdit((c) => setLanding(c, point));
                }}
                onMoveShotPlayer={(playerId, point) =>
                  annotateEdit((c) => moveShotPosition(c, playerId, point))
                }
              />
              <InspectorPanel
                focused={focused === "inspector"}
                tab={inspectorTab}
                onTabChange={setInspectorTab}
                games={games}
                selection={current}
                roster={roster}
                frame={frame}
                cursor={cursor}
                onCursor={(tab, index) => setCursor((c) => ({ ...c, [tab]: index }))}
                form={form}
                onOpenForm={setForm}
                onCloseForm={() => setForm(null)}
                onEdit={(edit) => annotateEdit(edit)}
                onMoveContactHere={() => {
                  if (current.entry === null) return;
                  annotateEdit((c) => moveContact(c, current.entry!, frame));
                }}
                onSyncFromTracking={() => void syncFromTracking()}
                onDeleteRally={() => runAnnotate({ type: "deleteRally" })}
                issues={showRuleChecks ? ruleIssues : undefined}
                onSelectIssue={jumpToIssue}
              />
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
        <RalliesPanel
          focused={focused === "rallies"}
          games={games}
          selection={current}
          roster={roster}
          issues={showRuleChecks ? ruleIssues : undefined}
          onSelectRally={(gi, ri) => goToRally(selectRally(games, gi, ri))}
          onSelectGame={(gi) => setRallySelection({ game: gi, rally: null, entry: null })}
          onAddUnseen={() => runAnnotate({ type: "unseenRally" })}
          onAddGame={() => runAnnotate({ type: "nextGame" })}
          onDeleteGame={(gi) => annotateEdit((c) => deleteGame(c, gi))}
        />
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
          onMoveEdge={(segmentStart, edge, to) =>
            recording.editSegments((list, pending) =>
              moveEdge(list, pending, segmentStart, edge, to),
            )
          }
          onPreviewEdge={(target, reason) => {
            controls.preview(target);
            setEdgeDragHint(reason);
          }}
          rallyLog={
            showRuleChecks
              ? {
                  games,
                  selection: current,
                  roster,
                  issues: ruleIssues,
                  onSelectRally: (gi, ri, mode) => {
                    const next = selectRally(games, gi, ri);
                    if (mode === "edge-drag") {
                      setRallySelection(next);
                      setInspectorTab("rally");
                      setForm(null);
                    } else {
                      goToRally(next);
                    }
                  },
                  onMoveRallyEdge: (gi, ri, edge, to) =>
                    recording.editGames((list) =>
                      setRallyEdge(
                        {
                          games: list,
                          selection: { game: gi, rally: ri, entry: null },
                          roster,
                          frame,
                        },
                        edge,
                        to,
                      ),
                    ),
                  onSelectEntry: (gi, ri, ei) => {
                    setInspectorTab("shot");
                    goToEntry({ game: gi, rally: ri, entry: ei });
                  },
                  onMoveContact: (gi, ri, ei, to) =>
                    annotateEdit((c) => moveContact(c, ei, to), {
                      selection: { game: gi, rally: ri, entry: ei },
                    }),
                  onSelectIssue: jumpToIssue,
                  onFitRally: () => {
                    if (!fitRally()) setView(fullView(totalFrames));
                  },
                }
              : undefined
          }
        />
      </div>
      <StatusBar
        message={edgeDragHint || recordingState.message || defaultMessage}
        saveStatus={recordingState.saveStatus}
        match={match}
        workspace={workspace}
        issueCounts={showRuleChecks ? issueCounts : undefined}
        onNextIssue={() => cycleRuleIssue(1)}
      />
    </div>
  );
}
