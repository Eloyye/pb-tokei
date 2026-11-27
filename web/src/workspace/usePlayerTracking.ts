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
  /**
   * Player Tracking at any frame: from a loaded window, or fetched on its own. Resolves to
   * undefined when it can't be had (no video, or the request failed).
   */
  trackingAt: (frame: number) => Promise<PlayerTrackingFrameOut | undefined>;
  /**
   * Player Tracking at a frame without waiting: the loaded frame, `null` when Tracking can't know
   * anything there (no video, or never run and nothing anchored), or `undefined` when it must be
   * fetched (including before the status has loaded).
   */
  cachedAt: (frame: number) => PlayerTrackingFrameOut | null | undefined;
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
    scope: string;
    value: PlayerTrackingOut;
  } | null>(null);
  const [windows, setWindows] = useState<Map<string, PlayerTrackingFramesOut>>(() => new Map());
  const windowsRef = useRef<Map<string, PlayerTrackingFramesOut>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const saved = saveStatus.state === "saved";
  const statusScope = useMemo(
    () => (enabled && saved && segments ? `${matchId}:${JSON.stringify(segments)}` : null),
    [matchId, enabled, saved, segments],
  );
  const status = statusScope && statusState?.scope === statusScope ? statusState.value : null;
  const statusScopeRef = useRef(statusScope);
  useEffect(() => {
    statusScopeRef.current = statusScope;
  }, [statusScope]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Refresh tracking status when segments change (never auto-triggers GPU tracking).
  useEffect(() => {
    if (statusScope === null) return;
    let cancelled = false;
    getPlayerTracking(matchId)
      .then((next) => {
        if (!cancelled) setStatusState({ scope: statusScope, value: next });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [matchId, statusScope]);

  // Poll while tracking is in progress.
  const tracking = status?.status === "tracking";
  useEffect(() => {
    if (!tracking || statusScope === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = () => {
      timer = setTimeout(async () => {
        try {
          const next = await getPlayerTracking(matchId);
          if (cancelled) return;
          setStatusState({ scope: statusScope, value: next });
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
  }, [matchId, statusScope, tracking]);

  const trackedSegments = status?.tracked_segments ?? 0;
  const scope = useMemo(
    () =>
      statusScope
        ? `${statusScope}:${trackedSegments}:${trackedMotionSpans}:${JSON.stringify({
            calibrations,
            anchors,
            teamEnds,
          })}`
        : null,
    [statusScope, trackedSegments, trackedMotionSpans, calibrations, anchors, teamEnds],
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
    if (windowStart === null || windowEnd === null || !windowKey || !scope) {
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
  }, [matchId, scope, windowStart, windowEnd, windowKey]);

  const startTracking = useCallback(
    (priorityFrame?: number) => {
      if (statusScope === null) return;
      trackPlayers(matchId, priorityFrame === undefined ? {} : { priority_frame: priorityFrame })
        .then((next) => {
          if (mountedRef.current && statusScopeRef.current === statusScope) {
            setStatusState({ scope: statusScope, value: next });
          }
        })
        .catch(() => {});
    },
    [matchId, statusScope],
  );

  const cancelTracking = useCallback(() => {
    if (statusScope === null) return;
    cancelPlayerTracking(matchId)
      .then((next) => {
        if (mountedRef.current && statusScopeRef.current === statusScope) {
          setStatusState({ scope: statusScope, value: next });
        }
      })
      .catch(() => {});
  }, [matchId, statusScope]);

  const loadedAt = useCallback((at: number): PlayerTrackingFrameOut | undefined => {
    if (scopeRef.current === null) return undefined;
    const prefix = `${scopeRef.current}:`;
    for (const [key, data] of windowsRef.current) {
      if (!key.startsWith(prefix)) continue;
      if (at >= data.start_frame && at <= data.end_frame) {
        return data.frames[at - data.start_frame];
      }
    }
    return undefined;
  }, []);

  // Until the status loads, whether anything is tracked isn't known: fetch rather than guess.
  const nothingTracked =
    !enabled ||
    (status !== null && trackedSegments === 0 && anchors.length === 0 && teamEnds.length === 0);
  const cachedAt = useCallback(
    (at: number) => loadedAt(at) ?? (nothingTracked ? null : undefined),
    [loadedAt, nothingTracked],
  );

  const trackingAt = useCallback(
    async (at: number): Promise<PlayerTrackingFrameOut | undefined> => {
      if (statusScope === null) return undefined;
      const loaded = loadedAt(at);
      if (loaded) return loaded;
      try {
        const data = await getPlayerTrackingFrames(matchId, at, at);
        return mountedRef.current && statusScopeRef.current === statusScope
          ? data.frames[0]
          : undefined;
      } catch {
        return undefined;
      }
    },
    [matchId, statusScope, loadedAt],
  );

  const loadedWindow = windowKey ? windows.get(windowKey) : undefined;
  const frameData =
    loadedWindow && frame >= loadedWindow.start_frame && frame <= loadedWindow.end_frame
      ? loadedWindow.frames[frame - loadedWindow.start_frame]
      : undefined;

  return { status, frameData, startTracking, cancelTracking, trackingAt, cachedAt };
}
