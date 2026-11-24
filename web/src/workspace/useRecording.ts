import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type Calibration,
  type CameraView,
  getCalibrations,
  getPlaySegments,
  type PlaySegment,
  replaceCalibrations,
  replacePlaySegments,
} from "../api/client";
import { commit, type History, redo, startHistory, undo } from "../lib/history";
import { combineStatus, createSaveQueue, type SaveQueue, type SaveStatus } from "../lib/saveQueue";
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
}

export interface RecordingControls {
  /** Applies a segment edit from `lib/segments` to the current segments and pending segment. */
  editSegments(
    edit: (segments: PlaySegment[], pending: PendingSegment | null) => SegmentEdit,
  ): void;
  cancelPending(): void;
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
  // Key handlers run outside render, so they read the latest state from refs.
  const historyRef = useRef<History<Recording> | null>(null);
  const pendingRef = useRef<PendingSegment | null>(null);
  const queuesRef = useRef<Queues | null>(null);

  useEffect(() => {
    let cancelled = false;
    const statuses = new Map<string, SaveStatus>();
    const options = (key: string) => ({
      retryable,
      onStatus: (status: SaveStatus) => {
        statuses.set(key, status);
        if (!cancelled) setSaveStatus(combineStatus([...statuses.values()]));
      },
    });
    const queue = <T>(key: string, save: (value: T) => Promise<unknown>) =>
      createSaveQueue(save, options(key));
    const queues: Queues = {
      segments: queue("segments", (segments: PlaySegment[]) =>
        replacePlaySegments(matchId, segments),
      ),
      calibrations: {
        main: queue("main", (list: Calibration[]) => replaceCalibrations(matchId, "main", list)),
        sideline: queue("sideline", (list: Calibration[]) =>
          replaceCalibrations(matchId, "sideline", list),
        ),
      },
    };
    queuesRef.current = queues;

    // The Rally Log answers 503 while another request holds the file; that passes, so retry.
    withRetries(() => Promise.all([getPlaySegments(matchId), getCalibrations(matchId)])).then(
      ([segments, calibrations]) => {
        if (cancelled) return;
        const start = startHistory<Recording>({
          segments,
          calibrations: calibrations.map(
            ({ camera_view, effective_from_frame, reference_frame, landmarks }) => ({
              camera_view,
              effective_from_frame,
              reference_frame,
              landmarks,
            }),
          ),
        });
        historyRef.current = start;
        setHistory(start);
      },
      (error: unknown) => {
        if (!cancelled) setMessage(`Couldn't load Play Segments: ${errorMessage(error)}`);
      },
    );
    return () => {
      cancelled = true;
      queues.segments.close();
      for (const view of VIEWS) queues.calibrations[view].close();
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
    cancelPending,
    undo: undoEdit,
    redo: redoEdit,
  };

  return [{ recording: history?.present ?? null, pending, message, saveStatus }, controls];
}

async function withRetries<T>(load: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

function ofView(calibrations: Calibration[], view: CameraView): Calibration[] {
  return calibrations.filter((c) => c.camera_view === view);
}

/** Client errors (a 422 for invalid data, a 404 for a deleted Match) won't succeed on retry. */
function retryable(error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
