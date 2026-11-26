import type { OperatorSessionIn, OperatorTime } from "../api/client";
import { FPS, formatLength } from "./frames";
import { WORKSPACES, WORKSPACE_LABELS, type Workspace } from "./workspaces";

export const IDLE_TIMEOUT_MS = 120_000;
export const FLUSH_INTERVAL_MS = 15_000;
export const ASSISTED_RATIO_BUDGET = 0.25;

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
  workspace: Workspace,
): OperatorSessionIn | null {
  if (clock.startedAt === null || clock.lastCommittedWallAt === null) return null;
  return {
    workspace,
    active_seconds: clock.committedMs / 1000,
    started_at: new Date(clock.startedAt).toISOString(),
    ended_at: new Date(Math.max(clock.startedAt, clock.lastCommittedWallAt)).toISOString(),
  };
}

export function formatActiveTime(seconds: number): string {
  return formatLength(Math.floor(seconds) * FPS);
}

export function formatRatio(ratio: number | null): string {
  return ratio === null ? "—" : ratio.toFixed(2);
}

export function operatorRatio(activeSeconds: number, broadcastSeconds: number | null) {
  return broadcastSeconds === null ? null : activeSeconds / broadcastSeconds;
}

export function ratioClassName(ratio: number | null, budget: boolean): string {
  if (!budget || ratio === null) return "ratio";
  return ratio <= ASSISTED_RATIO_BUDGET ? "ratio within-budget" : "ratio over-budget";
}

export function operatorTimeTitle(time: OperatorTime): string {
  return WORKSPACES.map(
    (workspace) =>
      `${WORKSPACE_LABELS[workspace]} ${formatActiveTime(time[`${workspace}_seconds`])}`,
  ).join(" · ");
}
