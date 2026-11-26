import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Calibration,
  cancelPlayerTracking,
  getPlayerTracking,
  getPlayerTrackingFrames,
  type PlayerAnchor,
  type PlayerTrackingFrameOut,
  type PlayerTrackingFramesOut,
  type PlayerTrackingOut,
  type PlaySegment,
  type TeamEnd,
  trackPlayers,
} from "../api/client";
import type { SaveStatus } from "../lib/saveQueue";

const POLL_MS = 1000;
export const PLAYER_WINDOW_SIZE = 300;

export interface PlayerTrackingState {
  status: PlayerTrackingOut | null;
  frameData: PlayerTrackingFrameOut | undefined;
  startTracking: (priorityFrame?: number) => void;
  cancelTracking: () => void;
}

/**
 * Loads Player Tracking status, polls progress while an explicit job is running (never auto-starts
 * Layer 1 GPU inference), and caches windowed per-frame detections and resolved Player positions,
 * Zones, and Settled facts around the playhead.
 */
export function usePlayerTracking(
  matchId: string,
  enabled: boolean,
  saveStatus: SaveStatus,
  segments: PlaySegment[] | null,
  calibrations: Calibration[],
  anchors: PlayerAnchor[],
  teamEnds: TeamEnd[],
  trackedMotionSpans: number,
  frame: number,
): PlayerTrackingState {
  const [statusState, setStatusState] = useState<{
    matchId: string;
    value: PlayerTrackingOut;
  } | null>(null);
  const status = statusState?.matchId === matchId ? statusState.value : null;
  const [windows, setWindows] = useState<Map<string, PlayerTrackingFramesOut>>(() => new Map());
  const windowsRef = useRef<Map<string, PlayerTrackingFramesOut>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const matchIdRef = useRef(matchId);
  useEffect(() => {
    matchIdRef.current = matchId;
  }, [matchId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const saved = saveStatus.state === "saved";

  // Refresh tracking status when segments change (never auto-triggers GPU tracking).
  const segmentSig = useMemo(() => (segments ? JSON.stringify(segments) : null), [segments]);
  useEffect(() => {
    if (!enabled || !saved || segmentSig === null) return;
    let cancelled = false;
    getPlayerTracking(matchId)
      .then((next) => {
        if (!cancelled && matchIdRef.current === matchId) {
          setStatusState({ matchId, value: next });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [matchId, enabled, saved, segmentSig]);

  // Poll while tracking is in progress.
  const tracking = status?.status === "tracking";
  useEffect(() => {
    if (!enabled || !tracking) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      timer = setTimeout(async () => {
        try {
          const next = await getPlayerTracking(matchId);
          if (cancelled || matchIdRef.current !== matchId) return;
          setStatusState({ matchId, value: next });
          if (next.status === "tracking") poll();
        } catch {
          if (!cancelled && matchIdRef.current === matchId) poll();
        }
      }, POLL_MS);
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [matchId, enabled, tracking]);

  const trackedSegments = status?.tracked_segments ?? 0;
  const scope = useMemo(
    () =>
      segments
        ? `${matchId}:${trackedSegments}:${trackedMotionSpans}:${JSON.stringify({
            segments,
            calibrations,
            anchors,
            teamEnds,
          })}`
        : null,
    [matchId, trackedSegments, trackedMotionSpans, segments, calibrations, anchors, teamEnds],
  );
  const scopeRef = useRef<string | null>(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  // Compute a stable frame window aligned to the active Play Segment.
  const activeSegment = segments?.find((s) => frame >= s.start_frame && frame <= s.end_frame);
  let windowStart: number | null = null;
  let windowEnd: number | null = null;
  if (activeSegment && (trackedSegments > 0 || anchors.length > 0 || teamEnds.length > 0)) {
    const len = activeSegment.end_frame - activeSegment.start_frame + 1;
    if (len <= PLAYER_WINDOW_SIZE) {
      windowStart = activeSegment.start_frame;
      windowEnd = activeSegment.end_frame;
    } else {
      const chunk = Math.floor((frame - activeSegment.start_frame) / PLAYER_WINDOW_SIZE);
      windowStart = activeSegment.start_frame + chunk * PLAYER_WINDOW_SIZE;
      windowEnd = Math.min(activeSegment.end_frame, windowStart + PLAYER_WINDOW_SIZE - 1);
    }
  }
  const windowKey =
    windowStart !== null && windowEnd !== null && scope
      ? `${scope}:${windowStart}-${windowEnd}`
      : null;

  useEffect(() => {
    if (!enabled || !saved || windowStart === null || windowEnd === null || !windowKey || !scope) {
      return;
    }
    if (windowsRef.current.has(windowKey) || inFlight.current.has(windowKey)) return;
    inFlight.current.add(windowKey);

    getPlayerTrackingFrames(matchId, windowStart, windowEnd)
      .then((data) => {
        if (!mountedRef.current || scopeRef.current !== scope) return;
        const prefix = `${scope}:`;
        setWindows((prev) => {
          const next = new Map<string, PlayerTrackingFramesOut>();
          for (const [k, v] of prev) {
            if (k.startsWith(prefix)) next.set(k, v);
          }
          next.set(windowKey, data);
          windowsRef.current = next;
          return next;
        });
      })
      .catch(() => {
        // Leave uncached so a later seek or save retries cleanly.
      })
      .finally(() => {
        inFlight.current.delete(windowKey);
      });
  }, [enabled, saved, matchId, scope, windowStart, windowEnd, windowKey]);

  const startTracking = useCallback(
    (priorityFrame?: number) => {
      const requestedMatch = matchId;
      trackPlayers(
        requestedMatch,
        priorityFrame === undefined ? {} : { priority_frame: priorityFrame },
      )
        .then((next) => {
          if (mountedRef.current && matchIdRef.current === requestedMatch) {
            setStatusState({ matchId: requestedMatch, value: next });
          }
        })
        .catch(() => {});
    },
    [matchId],
  );

  const cancelTracking = useCallback(() => {
    const requestedMatch = matchId;
    cancelPlayerTracking(requestedMatch)
      .then((next) => {
        if (mountedRef.current && matchIdRef.current === requestedMatch) {
          setStatusState({ matchId: requestedMatch, value: next });
        }
      })
      .catch(() => {});
  }, [matchId]);

  const loadedWindow = windowKey ? windows.get(windowKey) : undefined;
  const frameData =
    loadedWindow && frame >= loadedWindow.start_frame && frame <= loadedWindow.end_frame
      ? loadedWindow.frames[frame - loadedWindow.start_frame]
      : undefined;

  return { status, frameData, startTracking, cancelTracking };
}
