import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Calibration,
  type CalibrationOut,
  type CameraView,
  getCalibrations,
  getPlaySegments,
  isRetryable,
  type PlaySegment,
  replaceCalibrations,
  replacePlaySegments,
  toCalibration,
} from "../api/client";
import { commit, type History, redo, startHistory, undo } from "../lib/history";
import { withRetries } from "../lib/retry";
import { combineStatus, createSaveQueue, type SaveQueue, type SaveStatus } from "../lib/saveQueue";
import { reportSaveStatus } from "../lib/unsavedChanges";
import { type CalibrationEdit, fitKey } from "../lib/calibrations";
import { followStart, type PendingSegment, type SegmentEdit } from "../lib/segments";

/** A Match's Play Segments and Calibrations: what Calibrate edits, undoes and saves. */
export interface Recording {
  segments: PlaySegment[];
  calibrations: Calibration[];
}

export interface RecordingState {
  /** Null until loaded. */
  recording: Recording | null;
  pending: PendingSegment | null;
  /** The last edit's hint, or a load error. */
  message: string | null;
  saveStatus: SaveStatus;
  /**
   * Each Calibration's fit as the server last returned it, keyed by `fitKey`. It lags an edit
   * until that edit is saved; `currentFit` returns it only once it is current.
   */
  fits: Map<string, CalibrationOut>;
}

export interface RecordingControls {
  /** Applies a segment edit from `lib/segments` to the current segments and pending segment. */
  editSegments(
    edit: (segments: PlaySegment[], pending: PendingSegment | null) => SegmentEdit,
  ): void;
  /** Applies a Calibration edit from `lib/calibrations` to the current Calibrations. */
  editCalibrations(edit: (calibrations: Calibration[]) => CalibrationEdit): void;
  cancelPending(): void;
  /** Shows a hint in the status bar. */
  notify(message: string): void;
  undo(): void;
  redo(): void;
}

const VIEWS: CameraView[] = ["main", "sideline"];

interface Queues {
  segments: SaveQueue<PlaySegment[]>;
  calibrations: Record<CameraView, SaveQueue<Calibration[]>>;
}

/**
 * Loads a Match's Play Segments and Calibrations and keeps them editable: every change is
 * recorded for undo and autosaved, each list in its own queue so saves never land out of order.
 */
export function useRecording(matchId: string): [RecordingState, RecordingControls] {
  const [history, setHistory] = useState<History<Recording> | null>(null);
  const [pending, setPending] = useState<PendingSegment | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ state: "saved" });
  const [fits, setFits] = useState<Map<string, CalibrationOut>>(() => new Map());
  // Key handlers run outside render, so they read the latest state from refs.
  const historyRef = useRef<History<Recording> | null>(null);
  const pendingRef = useRef<PendingSegment | null>(null);
  const queuesRef = useRef<Queues | null>(null);

  useEffect(() => {
    let cancelled = false;
    const statuses = new Map<string, SaveStatus>();
    // This editor's saves, as seen by a Rally Log switch waiting for them (lib/unsavedChanges).
    const owner = {};
    const options = (key: string) => ({
      retryable: isRetryable,
      onStatus: (status: SaveStatus) => {
        statuses.set(key, status);
        const combined = combineStatus([...statuses.values()]);
        reportSaveStatus(owner, combined);
        if (!cancelled) setSaveStatus(combined);
      },
    });
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
    const queue = <T>(key: string, save: (value: T) => Promise<unknown>) =>
      createSaveQueue(save, options(key));
    const queues: Queues = {
      segments: queue("segments", (segments: PlaySegment[]) =>
        replacePlaySegments(matchId, segments),
      ),
      calibrations: {
        main: queue("main", (list: Calibration[]) => saveCalibrations("main", list)),
        sideline: queue("sideline", (list: Calibration[]) => saveCalibrations("sideline", list)),
      },
    };
    queuesRef.current = queues;

    // The Rally Log answers 503 while another request holds the file; that passes, so retry.
    withRetries(() => Promise.all([getPlaySegments(matchId), getCalibrations(matchId)]), {
      retryable: isRetryable,
    }).then(
      ([segments, calibrations]) => {
        if (cancelled) return;
        const start = startHistory<Recording>({
          segments,
          calibrations: calibrations.map(toCalibration),
        });
        historyRef.current = start;
        setHistory(start);
        setFits(new Map(calibrations.map((fit) => [fitKey(fit), fit])));
      },
      (error: unknown) => {
        if (!cancelled) setMessage(`Couldn't load Play Segments: ${errorMessage(error)}`);
      },
    );
    return () => {
      cancelled = true;
      const all = [queues.segments, ...VIEWS.map((view) => queues.calibrations[view])];
      for (const q of all) q.close();
      // A closing queue still sends its latest value; a switch waits for that too.
      if (all.some((q) => q.status().state !== "saved")) {
        reportSaveStatus(owner, { state: "saving" });
      }
      void Promise.all(all.map((q) => q.settled())).then(() => reportSaveStatus(owner, null));
    };
  }, [matchId]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (saveStatus.state === "saved") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveStatus.state]);

  const update = useCallback((next: History<Recording>) => {
    const previous = historyRef.current;
    historyRef.current = next;
    setHistory(next);
    const queues = queuesRef.current;
    if (!previous || !queues) return;
    const before = previous.present;
    const after = next.present;
    if (before.segments !== after.segments) queues.segments.push(after.segments);
    for (const view of VIEWS) {
      const list = ofView(after.calibrations, view);
      if (JSON.stringify(ofView(before.calibrations, view)) !== JSON.stringify(list)) {
        queues.calibrations[view].push(list);
      }
    }
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
    cancelPending,
    notify: setMessage,
    undo: undoEdit,
    redo: redoEdit,
  };

  return [{ recording: history?.present ?? null, pending, message, saveStatus, fits }, controls];
}

function ofView(calibrations: Calibration[], view: CameraView): Calibration[] {
  return calibrations.filter((c) => c.camera_view === view);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
