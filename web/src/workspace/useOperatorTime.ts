import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getTabRallyLog,
  isRetryable,
  subscribeTabRallyLog,
  upsertOperatorSession,
  type Match,
  type MatchDetail,
  type OperatorTime,
} from "../api/client";
import {
  FLUSH_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  idleOperatorClock,
  operatorRatio,
  operatorSessionSnapshot,
  pauseOperatorClock,
  recordOperatorInput,
  tentativeOperatorMs,
  type OperatorClock,
} from "../lib/operatorTime";
import { backoffMs } from "../lib/saveQueue";
import { registerOperatorTimeFlush } from "../lib/unsavedChanges";
import type { Workspace } from "../lib/workspaces";

const INPUT_EVENTS = ["keydown", "pointerdown", "wheel", "input", "change"];
const MATCH_LIST = ["matches"] as const;

interface Session {
  id: string;
  workspace: Workspace;
  clock: OperatorClock;
  flushedMs: number;
}

interface OperatorTimeReading {
  time: OperatorTime;
  idle: boolean;
}

function newerTotals(a: OperatorTime, b: OperatorTime): OperatorTime {
  const calibrate_seconds = Math.max(a.calibrate_seconds, b.calibrate_seconds);
  const annotate_seconds = Math.max(a.annotate_seconds, b.annotate_seconds);
  const review_seconds = Math.max(a.review_seconds, b.review_seconds);
  return {
    calibrate_seconds,
    annotate_seconds,
    review_seconds,
    active_seconds: calibrate_seconds + annotate_seconds + review_seconds,
  };
}

function withTime<T extends Match>(match: T, time: OperatorTime): T {
  return {
    ...match,
    operator_time: time,
    operator_time_ratio: operatorRatio(time.active_seconds, match.broadcast_seconds),
  };
}

/** One clock per workspace visit, with a shared writer and persisted totals for the Match. */
function trackOperatorTime(
  matchId: string,
  rallyLog: string,
  queryClient: QueryClient,
  initialTime: OperatorTime,
  onReading: (reading: OperatorTimeReading) => void,
) {
  let persisted = initialTime;
  let current: Session | null = null;
  const sessions = new Set<Session>();
  let pending = new Set<Session>();
  let draining: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;
  let refused = false;

  const ownsCache = () => getTabRallyLog() === rallyLog;
  const isActive = () => current?.clock.lastInputMs != null;

  function totals(now?: number): OperatorTime {
    const time = { ...persisted };
    for (const session of sessions) {
      const tentative =
        now !== undefined && current === session ? tentativeOperatorMs(session.clock, now) : 0;
      const seconds = (session.clock.committedMs - session.flushedMs + tentative) / 1000;
      time[`${session.workspace}_seconds`] += seconds;
      time.active_seconds += seconds;
    }
    return time;
  }

  function publish() {
    if (!closed) onReading({ time: totals(Date.now()), idle: !isActive() });
  }

  function cacheList(time: OperatorTime) {
    queryClient.setQueryData<Match[]>(MATCH_LIST, (matches) =>
      matches?.map((match) => (match.id === matchId ? withTime(match, time) : match)),
    );
  }

  function invalidateList() {
    if (ownsCache()) void queryClient.invalidateQueries({ queryKey: MATCH_LIST, exact: true });
  }

  function stopRetryTimer() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  async function sendPending() {
    while (pending.size > 0) {
      const session = pending.values().next().value!;
      pending.delete(session);
      const sentMs = session.clock.committedMs;
      if (sentMs <= session.flushedMs) continue;
      const body = operatorSessionSnapshot(session.clock, session.workspace);
      if (!body) continue;
      const final = closed;
      try {
        // Every in-flight write can finish across pagehide. Later snapshots wait their turn.
        const time = await upsertOperatorSession(matchId, session.id, body, {
          rallyLog,
          keepalive: true,
        });
        session.flushedMs = sentMs;
        if (session !== current && session.flushedMs === session.clock.committedMs) {
          sessions.delete(session);
        }
        persisted = newerTotals(persisted, time);
        attempt = 0;
        if (ownsCache()) {
          queryClient.setQueryData<MatchDetail>(
            ["matches", matchId],
            (match) => match && withTime(match, newerTotals(match.operator_time, time)),
          );
          cacheList(closed ? totals() : persisted);
          if (!closed) invalidateList();
        }
        publish();
      } catch (error) {
        if (!isRetryable(error)) {
          refused = true;
          current = null;
          sessions.clear();
          pending.clear();
          clearTimeout(idleTimer);
          publish();
          return;
        }
        if (final) {
          sessions.delete(session);
          continue;
        }
        // An uncertain write may already be in the aggregate. Acknowledge it before
        // sending a different session so the display counts its seconds only once.
        pending = new Set([session, ...pending]);
        if (closed) continue;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void drain();
        }, backoffMs(++attempt));
        return;
      }
    }
  }

  function drain(): Promise<void> {
    if (draining !== null) return draining;
    if (retryTimer !== undefined || pending.size === 0) return Promise.resolve();
    draining = sendPending().finally(() => {
      draining = null;
      return drain();
    });
    return draining;
  }

  function flushCurrent() {
    if (current && current.clock.committedMs > current.flushedMs) pending.add(current);
    return drain();
  }

  function pause() {
    clearTimeout(idleTimer);
    if (current) current.clock = pauseOperatorClock(current.clock);
    publish();
    return flushCurrent();
  }

  function startSession(workspace: Workspace): Session {
    if (current) {
      void pause();
      if (current.clock.committedMs === current.flushedMs) sessions.delete(current);
    }
    const session = { id: crypto.randomUUID(), workspace, clock: idleOperatorClock, flushedMs: 0 };
    current = session;
    sessions.add(session);
    return session;
  }

  function onInput() {
    if (!current || document.hidden || !document.hasFocus() || !ownsCache()) return;
    const now = Date.now();
    const { lastInputMs, lastCommittedWallAt, startedAt } = current.clock;
    const previous = lastInputMs ?? lastCommittedWallAt ?? startedAt;
    // A wall-clock rollback starts a new session so each snapshot fits its UTC window.
    const session = previous !== null && now < previous ? startSession(current.workspace) : current;
    session.clock = recordOperatorInput(session.clock, now);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(pause, IDLE_TIMEOUT_MS);
    publish();
  }

  function onVisibility() {
    if (document.hidden) void pause();
  }

  function flushNow() {
    stopRetryTimer();
    return pause();
  }

  for (const event of INPUT_EVENTS) window.addEventListener(event, onInput, true);
  window.addEventListener("blur", pause);
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", onVisibility);
  const tick = setInterval(() => {
    if (isActive()) publish();
  }, 1000);
  const periodic = setInterval(() => {
    if (isActive()) void flushCurrent();
  }, FLUSH_INTERVAL_MS);
  const unregister = registerOperatorTimeFlush(flushNow);

  return {
    setWorkspace(workspace: Workspace) {
      if (refused || current?.workspace === workspace) return;
      startSession(workspace);
      publish();
    },
    syncPersisted(time: OperatorTime) {
      // A concurrent read could already include an unacknowledged write.
      if (draining !== null || attempt > 0 || refused) return;
      persisted = newerTotals(persisted, time);
      publish();
    },
    close() {
      closed = true;
      clearInterval(tick);
      clearInterval(periodic);
      unregister();
      for (const event of INPUT_EVENTS) window.removeEventListener(event, onInput, true);
      window.removeEventListener("blur", pause);
      window.removeEventListener("pagehide", flushNow);
      document.removeEventListener("visibilitychange", onVisibility);
      // Seed Home with the committed time on navigation while the closing write lands.
      if (ownsCache() && [...sessions].some((s) => s.clock.committedMs > s.flushedMs)) {
        void queryClient.cancelQueries({ queryKey: MATCH_LIST, exact: true });
        cacheList(totals());
      }
      void flushNow().then(invalidateList);
    },
  };
}

export function useOperatorTime(
  match: Pick<MatchDetail, "id" | "video_status" | "operator_time">,
  workspace: Workspace,
): OperatorTimeReading {
  const queryClient = useQueryClient();
  const { id, video_status, operator_time } = match;
  const rallyLog = useSyncExternalStore(subscribeTabRallyLog, getTabRallyLog);
  const [originalLog, setOriginalLog] = useState(rallyLog);
  if (originalLog === null && rallyLog !== null) setOriginalLog(rallyLog);
  const trackingLog = video_status === "ready" && rallyLog === originalLog ? rallyLog : null;
  const tracker = useRef<ReturnType<typeof trackOperatorTime> | null>(null);
  const [reading, setReading] = useState<OperatorTimeReading>();
  const initial = useEffectEvent(() => ({ time: operator_time, workspace }));

  useLayoutEffect(() => {
    if (trackingLog === null) return;
    const start = initial();
    const timer = trackOperatorTime(id, trackingLog, queryClient, start.time, setReading);
    tracker.current = timer;
    timer.setWorkspace(start.workspace);
    return () => {
      tracker.current = null;
      timer.close();
    };
  }, [id, trackingLog, queryClient]);

  useLayoutEffect(() => {
    tracker.current?.setWorkspace(workspace);
  }, [workspace]);

  useLayoutEffect(() => {
    tracker.current?.syncPersisted(operator_time);
  }, [operator_time]);

  if (trackingLog !== null && reading) return reading;
  return { time: operator_time, idle: true };
}
