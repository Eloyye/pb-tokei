import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Calibration,
  type CameraMotionFramesOut,
  type CameraMotionOut,
  getCameraMotion,
  getCameraMotionFrames,
  type Lens,
  type PlaySegment,
  trackCameraMotion,
} from "../api/client";
import { unmappedRangeAt } from "../lib/calibrations";
import type { SaveStatus } from "../lib/saveQueue";

const POLL_MS = 1200;
export const WINDOW_SIZE = 4000;

export interface CameraMotionState {
  motion: CameraMotionOut | null;
  /**
   * The tracked `court_to_image` matrix for the playhead frame:
   * - `number[][]` when the frame is tracked and mapped
   * - `null` when the frame is inside a tracked span and failed registration (unmapped)
   * - `undefined` when Camera Motion has not been loaded/tracked for this frame yet
   */
  frameMatrix: number[][] | null | undefined;
  /**
   * The lens that bends `frameMatrix`'s image into the frame (ADR 0011), or null when it maps
   * straight into the frame (no lens, or no tracked matrix).
   */
  frameLens: Lens | null;
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
  autoTrack = true,
): CameraMotionState {
  const [motionState, setMotionState] = useState<{
    scope: string;
    data: CameraMotionOut;
  } | null>(null);
  const [windows, setWindows] = useState<Map<string, CameraMotionFramesOut>>(() => new Map());
  const windowsRef = useRef<Map<string, CameraMotionFramesOut>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  const scope = useMemo(
    () => (segments ? `${matchId}:${JSON.stringify({ segments, calibrations })}` : null),
    [matchId, segments, calibrations],
  );
  const scopeRef = useRef<string | null>(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
        if (autoTrack && next.status === "idle") {
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
  }, [matchId, enabled, saved, scope, autoTrack]);

  // Poll while background tracking is in progress; re-trigger if tracking settles back to idle.
  const tracking = motion?.status === "tracking";
  useEffect(() => {
    if (!enabled || !tracking || scope === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      timer = setTimeout(async () => {
        try {
          let next = await getCameraMotion(matchId);
          if (cancelled) return;
          if (autoTrack && next.status === "idle") {
            next = await trackCameraMotion(matchId);
            if (cancelled) return;
          }
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
  }, [matchId, enabled, tracking, scope, autoTrack]);

  // Compute primitive window bounds so moving `frame` within the same window never re-triggers
  // or cancels an in-flight frame-window fetch.
  const activeSpan = motion?.spans.find(
    (s) => s.tracked && frame >= s.start_frame && frame <= s.end_frame,
  );
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  if (activeSpan) {
    const spanLen = activeSpan.end_frame - activeSpan.start_frame + 1;
    if (spanLen <= WINDOW_SIZE) {
      windowStart = activeSpan.start_frame;
      windowEnd = activeSpan.end_frame;
    } else {
      const chunk = Math.floor((frame - activeSpan.start_frame) / WINDOW_SIZE);
      windowStart = activeSpan.start_frame + chunk * WINDOW_SIZE;
      windowEnd = Math.min(activeSpan.end_frame, windowStart + WINDOW_SIZE - 1);
    }
  }
  const windowKey =
    windowStart !== null && windowEnd !== null && scope
      ? `${scope}:${windowStart}-${windowEnd}`
      : null;

  useEffect(() => {
    if (!enabled || windowStart === null || windowEnd === null || !windowKey || !scope) return;
    if (windowsRef.current.has(windowKey) || inFlight.current.has(windowKey)) return;
    inFlight.current.add(windowKey);

    getCameraMotionFrames(matchId, windowStart, windowEnd)
      .then((data) => {
        if (!mountedRef.current || scopeRef.current !== scope) return;
        const prefix = `${scope}:`;
        setWindows((prev) => {
          const next = new Map<string, CameraMotionFramesOut>();
          for (const [k, v] of prev) {
            if (k.startsWith(prefix)) next.set(k, v);
          }
          next.set(windowKey, data);
          windowsRef.current = next;
          return next;
        });
      })
      .catch(() => {
        // Leave uncached so a later seek or refresh can retry.
      })
      .finally(() => {
        inFlight.current.delete(windowKey);
      });
  }, [enabled, matchId, scope, windowStart, windowEnd, windowKey]);

  const retrack = useCallback(() => {
    if (!enabled || scope === null) return;
    trackCameraMotion(matchId)
      .then((next) => setMotionState({ scope, data: next }))
      .catch(() => {});
  }, [enabled, matchId, scope]);

  const loadedWindow = windowKey ? windows.get(windowKey) : undefined;
  const unmappedFromSummary = Boolean(motion && unmappedRangeAt(motion.unmapped_ranges, frame));

  let frameMatrix: number[][] | null | undefined;
  let frameLens: Lens | null = null;
  let frameUnmapped = unmappedFromSummary;
  if (loadedWindow && frame >= loadedWindow.start_frame && frame <= loadedWindow.end_frame) {
    const idx = frame - loadedWindow.start_frame;
    if (loadedWindow.unmapped[idx]) {
      frameMatrix = null;
      frameUnmapped = true;
    } else if (loadedWindow.court_to_image[idx]) {
      frameMatrix = loadedWindow.court_to_image[idx];
      frameLens = loadedWindow.lens[idx] ?? null;
      frameUnmapped = false;
    }
  } else if (unmappedFromSummary) {
    frameMatrix = null;
  }

  return { motion, frameMatrix, frameLens, frameUnmapped, retrack };
}
