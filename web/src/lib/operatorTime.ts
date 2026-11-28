import type { OperatorSessionIn, OperatorTime } from "../api/client";
import { FPS, formatLength } from "./frames";
import { OPERATOR_WORKSPACES, WORKSPACE_LABELS, type OperatorWorkspace } from "./workspaces";

export const IDLE_TIMEOUT_MS = 120_000;
export const FLUSH_INTERVAL_MS = 15_000;

export interface OperatorClock {
  committedMs: number;
  lastInputMs: number | null;
  startedAt: number | null;
  lastCommittedWallAt: number | null;
}

export const idleOperatorClock: OperatorClock = {
  committedMs: 0,
  lastInputMs: null,
  startedAt: null,
  lastCommittedWallAt: null,
};

/** Active time is the interval between consecutive deliberate inputs. */
export function recordOperatorInput(clock: OperatorClock, now: number): OperatorClock {
  const delta = clock.lastInputMs === null ? 0 : now - clock.lastInputMs;
  const commit = delta > 0 && delta <= IDLE_TIMEOUT_MS;
  return {
    committedMs: clock.committedMs + (commit ? delta : 0),
    lastInputMs: now,
    startedAt: clock.startedAt ?? now,
    lastCommittedWallAt: commit ? now : clock.lastCommittedWallAt,
  };
}

export function pauseOperatorClock(clock: OperatorClock): OperatorClock {
  return { ...clock, lastInputMs: null };
}

export function tentativeOperatorMs(clock: OperatorClock, now: number): number {
  if (clock.lastInputMs === null) return 0;
  return Math.max(0, Math.min(now - clock.lastInputMs, IDLE_TIMEOUT_MS));
}

export function operatorSessionSnapshot(
  clock: OperatorClock,
  workspace: OperatorWorkspace,
): OperatorSessionIn | null {
  if (clock.startedAt === null || clock.lastCommittedWallAt === null) return null;
  return {
    workspace,
    active_seconds: clock.committedMs / 1000,
    started_at: new Date(clock.startedAt).toISOString(),
    ended_at: new Date(clock.lastCommittedWallAt).toISOString(),
  };
}

export function formatActiveTime(seconds: number): string {
  return formatLength(Math.floor(seconds) * FPS);
}

/** Human-readable active time for prose (e.g. "4 h 10 m", "15 m", "0 m"). */
export function formatOperatorDuration(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded === 0) return "0 m";
  if (rounded < 60) return `${rounded} s`;
  const totalMinutes = Math.round(rounded / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} h ${minutes} m`;
  if (hours > 0) return `${hours} h`;
  return `${minutes} m`;
}

export function formatRatio(ratio: number | null): string {
  return ratio === null ? "—" : ratio.toFixed(2);
}

/** The live equivalent of MatchSummary.operator_time_ratio. */
export function operatorRatio(activeSeconds: number, broadcastSeconds: number | null) {
  return broadcastSeconds === null ? null : activeSeconds / broadcastSeconds;
}

export function ratioClassName(ratio: number | null, budget: number | null): string {
  if (budget === null || ratio === null) return "ratio";
  return ratio <= budget ? "ratio within-budget" : "ratio over-budget";
}

export function operatorTimeTitle(time: OperatorTime): string {
  return OPERATOR_WORKSPACES.map(
    (workspace) =>
      `${WORKSPACE_LABELS[workspace]} ${formatActiveTime(time[`${workspace}_seconds`])}`,
  ).join(" · ");
}
