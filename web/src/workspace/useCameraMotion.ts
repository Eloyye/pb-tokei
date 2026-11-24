import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Calibration,
  type CameraMotionFramesOut,
  type CameraMotionOut,
  getCameraMotion,
  getCameraMotionFrames,
  type PlaySegment,
  trackCameraMotion,
} from "../api/client";
import { unmappedRangeAt } from "../lib/calibrations";
import type { SaveStatus } from "../lib/saveQueue";

const POLL_MS = 1200;
const WINDOW_SIZE = 4000;

export interface CameraMotionState {
  motion: CameraMotionOut | null;
  /**
   * The tracked `court_to_image` matrix for the playhead frame:
   * - `number[][]` when the frame is tracked and mapped
   * - `null` when the frame is inside a tracked span and failed registration (unmapped)
   * - `undefined` when Camera Motion has not been loaded/tracked for this frame yet
   */
  frameMatrix: number[][] | null | undefined;
  /** True when the playhead frame is inside a tracked span and could not be registered. */
  frameUnmapped: boolean;
  /** Retries Camera Motion tracking (e.g. after an error). */
  retrack: () => void;
}

/**
 * Fetches Camera Motion status, triggers background tracking for any uncached Calibration spans,
 * and caches per-frame `court_to_image` matrices for the active tracked span so scrubbing stays
 * instant at 60 fps.
 */
export function useCameraMotion(
  matchId: string,
  enabled: boolean,
  saveStatus: SaveStatus,
  segments: PlaySegment[] | null,
  calibrations: Calibration[],
  frame: number,
): CameraMotionState {
  const [motionState, setMotionState] = useState<{
    scope: string;
    data: CameraMotionOut;
  } | null>(null);
  const [windows, setWindows] = useState<Map<string, CameraMotionFramesOut>>(() => new Map());
  const inFlight = useRef<Set<string>>(new Set());

  const scope = useMemo(
    () => (segments ? `${matchId}:${JSON.stringify({ segments, calibrations })}` : null),
    [matchId, segments, calibrations],
  );
  const saved = saveStatus.state === "saved";
  const motion = scope && motionState?.scope === scope ? motionState.data : null;

  // Fetch status whenever the saved recording changes, auto-triggering tracking when idle.
  useEffect(() => {
    if (!enabled || !saved || scope === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      try {
        let next = await getCameraMotion(matchId);
        if (cancelled) return;
        if (next.status === "idle") {
          next = await trackCameraMotion(matchId);
          if (cancelled) return;
        }
        setMotionState({ scope, data: next });
      } catch {
        if (!cancelled) {
          timer = setTimeout(() => {
            void load();
          }, POLL_MS);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [matchId, enabled, saved, scope]);

  // Poll while background tracking is in progress.
  const tracking = motion?.status === "tracking";
  useEffect(() => {
    if (!enabled || !tracking || scope === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      timer = setTimeout(async () => {
        try {
          const next = await getCameraMotion(matchId);
          if (cancelled) return;
          setMotionState({ scope, data: next });
          if (next.status === "tracking") poll();
        } catch {
          if (!cancelled) poll();
        }
      }, POLL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [matchId, enabled, tracking, scope]);

  // Find the tracked span containing the playhead and ensure its frame window is fetched.
  const activeSpan = useMemo(
    () =>
      motion?.spans.find((s) => s.tracked && frame >= s.start_frame && frame <= s.end_frame) ??
      null,
    [motion, frame],
  );

  const windowBounds = useMemo(() => {
    if (!activeSpan) return null;
    const spanLen = activeSpan.end_frame - activeSpan.start_frame + 1;
    if (spanLen <= WINDOW_SIZE) {
      return { start: activeSpan.start_frame, end: activeSpan.end_frame };
    }
    const chunk = Math.floor((frame - activeSpan.start_frame) / WINDOW_SIZE);
    const start = activeSpan.start_frame + chunk * WINDOW_SIZE;
    const end = Math.min(activeSpan.end_frame, start + WINDOW_SIZE - 1);
    return { start, end };
  }, [activeSpan, frame]);

  const windowKey =
    windowBounds && scope ? `${scope}:${windowBounds.start}-${windowBounds.end}` : null;

  useEffect(() => {
    if (!enabled || !windowBounds || !windowKey || !scope) return;
    if (windows.has(windowKey) || inFlight.current.has(windowKey)) return;
    let cancelled = false;
    inFlight.current.add(windowKey);

    getCameraMotionFrames(matchId, windowBounds.start, windowBounds.end)
      .then((data) => {
        if (cancelled) return;
        const prefix = `${scope}:`;
        setWindows((prev) => {
          const next = new Map<string, CameraMotionFramesOut>();
          for (const [k, v] of prev) {
            if (k.startsWith(prefix)) next.set(k, v);
          }
          next.set(windowKey, data);
          return next;
        });
      })
      .catch(() => {
        // Leave uncached so a later seek or refresh can retry.
      })
      .finally(() => {
        inFlight.current.delete(windowKey);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, matchId, scope, windowBounds, windowKey, windows]);

  const retrack = useCallback(() => {
    if (!enabled || scope === null) return;
    trackCameraMotion(matchId)
      .then((next) => setMotionState({ scope, data: next }))
      .catch(() => {});
  }, [enabled, matchId, scope]);

  const loadedWindow = windowKey ? windows.get(windowKey) : undefined;
  const unmappedFromSummary = Boolean(motion && unmappedRangeAt(motion.unmapped_ranges, frame));

  let frameMatrix: number[][] | null | undefined;
  let frameUnmapped = unmappedFromSummary;
  if (loadedWindow && frame >= loadedWindow.start_frame && frame <= loadedWindow.end_frame) {
    const idx = frame - loadedWindow.start_frame;
    if (loadedWindow.unmapped[idx]) {
      frameMatrix = null;
      frameUnmapped = true;
    } else if (loadedWindow.court_to_image[idx]) {
      frameMatrix = loadedWindow.court_to_image[idx];
      frameUnmapped = false;
    }
  } else if (unmappedFromSummary) {
    frameMatrix = null;
  }

  return { motion, frameMatrix, frameUnmapped, retrack };
}
