import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Calibration,
  type CalibrationOut,
  type CameraView,
  type Game,
  getCalibrations,
  getGames,
  getPlayerAnchors,
  getPlaySegments,
  getTeamEnds,
  isRetryable,
  type PlayerAnchor,
  type PlaySegment,
  replaceCalibrations,
  replaceGames,
  replacePlayerAnchors,
  replacePlaySegments,
  replaceTeamEnds,
  type TeamEnd,
  toCalibration,
} from "../api/client";
import { commit, type History, redo, startHistory, undo } from "../lib/history";
import type { PlayerEdit } from "../lib/players";
import { withRetries } from "../lib/retry";
import { combineStatus, createSaveQueue, type SaveQueue, type SaveStatus } from "../lib/saveQueue";
import { reportSaveStatus } from "../lib/unsavedChanges";
import { type CalibrationEdit, fitKey } from "../lib/calibrations";
import { followStart, type PendingSegment, type SegmentEdit } from "../lib/segments";

/**
 * A Match's Play Segments, Calibrations, Player anchors, Team ends, and Games (Rallies, Shots,
 * Observation Gaps): editable with one undo history.
 */
export interface Recording {
  segments: PlaySegment[];
  calibrations: Calibration[];
  anchors: PlayerAnchor[];
  teamEnds: TeamEnd[];
  games: Game[];
}

export interface RecordingState {
  /** Null until loaded. */
  recording: Recording | null;
  pending: PendingSegment | null;
  /** The last edit's hint, or a load error. */
  message: string | null;
  saveStatus: SaveStatus;
  /** Save state for the inputs to Camera Motion and Player Tracking. */
  trackingSaveStatus: SaveStatus;
  /**
   * Server fits keyed by `fitKey`. A segment edit hides off-reference fits until they are
   * refreshed. `currentFit` also checks that the fitted Landmarks match the edit.
   */
  fits: Map<string, CalibrationOut>;
  fitRefreshError: string | null;
}

export interface RecordingControls {
  /** Applies a segment edit from `lib/segments` to the current segments and pending segment. */
  editSegments(
    edit: (segments: PlaySegment[], pending: PendingSegment | null) => SegmentEdit,
  ): void;
  /** Applies a Calibration edit from `lib/calibrations` to the current Calibrations. */
  editCalibrations(edit: (calibrations: Calibration[]) => CalibrationEdit): void;
  /** Applies a Player anchor / `team_ends` edit from `lib/players`. */
  editPlayers(
    edit: (anchors: PlayerAnchor[], teamEnds: TeamEnd[]) => PlayerEdit,
  ): PlayerEdit | null;
  /**
   * Applies a Rally Log edit (`lib/annotate`) to the Games, returning its result. Edits that
   * leave the Games as they were record nothing.
   */
  editGames<R extends { games: Game[]; message: string }>(edit: (games: Game[]) => R): R | null;
  /** Applies one edit across the whole Recording as a single undo step. */
  editRecording(edit: (recording: Recording) => { recording: Recording; message: string }): void;
  cancelPending(): void;
  /** Shows a hint in the status bar. */
  notify(message: string): void;
  retryCalibrationFits(): void;
  undo(): void;
  redo(): void;
}

const VIEWS: CameraView[] = ["main", "sideline"];

function hasOffReferenceLandmarks(calibration: Calibration): boolean {
  return Object.values(calibration.landmarks).some(
    (point) => point.frame !== calibration.reference_frame,
  );
}

interface Queues {
  segments: SaveQueue<PlaySegment[]>;
  calibrations: Record<CameraView, SaveQueue<Calibration[]>>;
  anchors: SaveQueue<PlayerAnchor[]>;
  teamEnds: SaveQueue<TeamEnd[]>;
  games: SaveQueue<Game[]>;
}

/**
 * Loads a Match's Play Segments and Calibrations and keeps them editable: every change is
 * recorded for undo and autosaved, each list in its own queue so saves never land out of order.
 */
export function useRecording(matchId: string): [RecordingState, RecordingControls] {
  const [history, setHistory] = useState<History<Recording> | null>(null);
  const [pending, setPending] = useState<PendingSegment | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [{ saveStatus, trackingSaveStatus }, setSaveStatuses] = useState<
    Pick<RecordingState, "saveStatus" | "trackingSaveStatus">
  >({ saveStatus: { state: "saved" }, trackingSaveStatus: { state: "saved" } });
  const [fits, setFits] = useState<Map<string, CalibrationOut>>(() => new Map());
  const [fitsMatchSegments, setFitsMatchSegments] = useState(true);
  const [fitRefreshError, setFitRefreshError] = useState<string | null>(null);
  // Key handlers run outside render, so they read the latest state from refs.
  const historyRef = useRef<History<Recording> | null>(null);
  const pendingRef = useRef<PendingSegment | null>(null);
  const queuesRef = useRef<Queues | null>(null);

  useEffect(() => {
    let cancelled = false;
    // This editor's saves, as seen by a Rally Log switch waiting for them (lib/unsavedChanges).
    const owner = {};
    const onStatus = () => {
      const trackingStatus = combineStatus(trackingQueues.map((q) => q.status()));
      const combined = combineStatus(allQueues.map((q) => q.status()));
      reportSaveStatus(owner, combined);
      if (!cancelled) setSaveStatuses({ saveStatus: combined, trackingSaveStatus: trackingStatus });
    };
    // A view's saved Calibrations come back fitted; their fits replace that view's.
    const saveCalibrations = async (view: CameraView, list: Calibration[]) => {
      const saved = await replaceCalibrations(matchId, view, list);
      if (cancelled) return;
      setFits((previous) => {
        const next = new Map([...previous].filter(([, fit]) => fit.camera_view !== view));
        for (const fit of saved) next.set(fitKey(fit), fit);
        return next;
      });
    };
    const queue = <T>(save: (value: T) => Promise<unknown>) =>
      createSaveQueue(save, { retryable: isRetryable, onStatus });
    const queues: Queues = {
      segments: queue((segments: PlaySegment[]) => replacePlaySegments(matchId, segments)),
      calibrations: {
        main: queue((list: Calibration[]) => saveCalibrations("main", list)),
        sideline: queue((list: Calibration[]) => saveCalibrations("sideline", list)),
      },
      anchors: queue((anchors: PlayerAnchor[]) => replacePlayerAnchors(matchId, anchors)),
      teamEnds: queue((teamEnds: TeamEnd[]) => replaceTeamEnds(matchId, teamEnds)),
      games: queue((games: Game[]) => replaceGames(matchId, games)),
    };
    const trackingQueues = [
      queues.segments,
      ...VIEWS.map((view) => queues.calibrations[view]),
      queues.anchors,
      queues.teamEnds,
    ];
    // Games save the Rally Log's manually recorded facts, including Shot snapshots.
    const allQueues = [...trackingQueues, queues.games];
    queuesRef.current = queues;

    // The Rally Log answers 503 while another request holds the file; that passes, so retry.
    withRetries(
      () =>
        Promise.all([
          getPlaySegments(matchId),
          getCalibrations(matchId),
          getPlayerAnchors(matchId),
          getTeamEnds(matchId),
          getGames(matchId),
        ]),
      { retryable: isRetryable },
    ).then(
      ([segments, calibrations, anchors, teamEnds, games]) => {
        if (cancelled) return;
        const start = startHistory<Recording>({
          segments,
          calibrations: calibrations.map(toCalibration),
          anchors,
          teamEnds,
          games,
        });
        historyRef.current = start;
        setHistory(start);
        setFits(new Map(calibrations.map((fit) => [fitKey(fit), fit])));
        setFitsMatchSegments(true);
        setFitRefreshError(null);
      },
      (error: unknown) => {
        if (!cancelled) setMessage(`Couldn't load the Rally Log: ${errorMessage(error)}`);
      },
    );
    return () => {
      cancelled = true;
      for (const q of allQueues) q.close();
      // A closing queue still sends its latest value; a switch waits for that too.
      if (allQueues.some((q) => q.status().state !== "saved")) {
        reportSaveStatus(owner, { state: "saving" });
      }
      void Promise.all(allQueues.map((q) => q.settled())).then(() => reportSaveStatus(owner, null));
    };
  }, [matchId]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (saveStatus.state === "saved") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveStatus.state]);

  const { segments: currentSegments, calibrations: currentCalibrations } = history?.present ?? {};
  // A segment boundary can change which off-reference Landmarks register to the reference frame.
  useEffect(() => {
    if (
      fitsMatchSegments ||
      fitRefreshError !== null ||
      trackingSaveStatus.state !== "saved" ||
      !currentCalibrations?.some(hasOffReferenceLandmarks)
    ) {
      return;
    }
    let cancelled = false;
    const isCurrent = () => {
      const current = historyRef.current?.present;
      return (
        !cancelled &&
        current?.segments === currentSegments &&
        current?.calibrations === currentCalibrations
      );
    };
    void withRetries(() => getCalibrations(matchId), { retryable: isRetryable }).then(
      (updated) => {
        if (!isCurrent()) return;
        setFits(new Map(updated.map((fit) => [fitKey(fit), fit])));
        setFitsMatchSegments(true);
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        const reason = `Couldn't refresh Calibration fits (${errorMessage(error)})`;
        setFitRefreshError(reason);
        setMessage(reason);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    matchId,
    currentSegments,
    currentCalibrations,
    fitsMatchSegments,
    fitRefreshError,
    trackingSaveStatus.state,
  ]);
  const currentFits = useMemo(
    () =>
      fitsMatchSegments
        ? fits
        : new Map([...fits].filter(([, fit]) => !hasOffReferenceLandmarks(fit))),
    [fits, fitsMatchSegments],
  );

  const update = useCallback((next: History<Recording>) => {
    const previous = historyRef.current;
    historyRef.current = next;
    setHistory(next);
    const queues = queuesRef.current;
    if (!previous || !queues) return;
    const before = previous.present;
    const after = next.present;
    const segmentsChanged = before.segments !== after.segments;
    if (segmentsChanged || before.calibrations !== after.calibrations) setFitRefreshError(null);
    if (segmentsChanged) {
      setFitsMatchSegments(false);
      queues.segments.push(after.segments);
    }
    for (const view of VIEWS) {
      const list = ofView(after.calibrations, view);
      if (JSON.stringify(ofView(before.calibrations, view)) !== JSON.stringify(list)) {
        queues.calibrations[view].push(list);
      }
    }
    if (before.anchors !== after.anchors) queues.anchors.push(after.anchors);
    if (before.teamEnds !== after.teamEnds) queues.teamEnds.push(after.teamEnds);
    if (before.games !== after.games) queues.games.push(after.games);
  }, []);

  const setPendingSegment = useCallback((next: PendingSegment | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const editSegments = useCallback<RecordingControls["editSegments"]>(
    (edit) => {
      const current = historyRef.current;
      if (!current) return;
      const result = edit(current.present.segments, pendingRef.current);
      setPendingSegment(result.pending);
      setMessage(result.message);
      if (result.segments === current.present.segments) return;
      const { calibrations } = current.present;
      update(
        commit(current, {
          ...current.present,
          segments: result.segments,
          calibrations: result.startMoved
            ? followStart(calibrations, result.startMoved)
            : calibrations,
        }),
      );
    },
    [update, setPendingSegment],
  );

  const editCalibrations = useCallback<RecordingControls["editCalibrations"]>(
    (edit) => {
      const current = historyRef.current;
      if (!current) return;
      const result = edit(current.present.calibrations);
      setMessage(result.message);
      if (result.calibrations === current.present.calibrations) return;
      update(commit(current, { ...current.present, calibrations: result.calibrations }));
    },
    [update],
  );

  const editPlayers = useCallback<RecordingControls["editPlayers"]>(
    (edit) => {
      const current = historyRef.current;
      if (!current) return null;
      const result = edit(current.present.anchors, current.present.teamEnds);
      setMessage(result.message);
      if (
        result.anchors === current.present.anchors &&
        result.teamEnds === current.present.teamEnds
      ) {
        return result;
      }
      update(
        commit(current, {
          ...current.present,
          anchors: result.anchors,
          teamEnds: result.teamEnds,
        }),
      );
      return result;
    },
    [update],
  );

  const editGames = useCallback(
    <R extends { games: Game[]; message: string }>(edit: (games: Game[]) => R): R | null => {
      const current = historyRef.current;
      if (!current) return null;
      const result = edit(current.present.games);
      setMessage(result.message);
      if (result.games !== current.present.games) {
        update(commit(current, { ...current.present, games: result.games }));
      }
      return result;
    },
    [update],
  );

  const editRecording = useCallback<RecordingControls["editRecording"]>(
    (edit) => {
      const current = historyRef.current;
      if (!current) return;
      const result = edit(current.present);
      setMessage(result.message);
      update(commit(current, result.recording));
    },
    [update],
  );

  const cancelPending = useCallback(() => {
    if (!pendingRef.current) return;
    setPendingSegment(null);
    setMessage("Pending Play Segment dropped");
  }, [setPendingSegment]);

  const undoEdit = useCallback(() => {
    const current = historyRef.current;
    if (!current) return;
    if (current.past.length === 0) return setMessage("Nothing to undo");
    update(undo(current));
    setMessage("Undone");
  }, [update]);

  const redoEdit = useCallback(() => {
    const current = historyRef.current;
    if (!current) return;
    if (current.future.length === 0) return setMessage("Nothing to redo");
    update(redo(current));
    setMessage("Redone");
  }, [update]);

  const controls: RecordingControls = {
    editSegments,
    editCalibrations,
    editPlayers,
    editGames,
    editRecording,
    cancelPending,
    notify: setMessage,
    retryCalibrationFits: () => {
      setFitRefreshError(null);
      setMessage((current) => (current === fitRefreshError ? null : current));
    },
    undo: undoEdit,
    redo: redoEdit,
  };

  return [
    {
      recording: history?.present ?? null,
      pending,
      message,
      saveStatus,
      trackingSaveStatus,
      fits: currentFits,
      fitRefreshError,
    },
    controls,
  ];
}

function ofView(calibrations: Calibration[], view: CameraView): Calibration[] {
  return calibrations.filter((c) => c.camera_view === view);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
