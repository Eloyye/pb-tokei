import { describe, expect, it } from "vitest";
import {
  IDLE_TIMEOUT_MS,
  formatActiveTime,
  formatRatio,
  idleOperatorClock,
  operatorSessionSnapshot,
  pauseOperatorClock,
  recordOperatorInput,
  tentativeOperatorMs,
} from "./operatorTime";

describe("operator clock", () => {
  it("counts input intervals and rolls back the tentative display on pause", () => {
    expect(tentativeOperatorMs(idleOperatorClock, 5000)).toBe(0);
    const start = recordOperatorInput(idleOperatorClock, 5000);
    expect(operatorSessionSnapshot(start, "annotate")).toBeNull();
    expect(tentativeOperatorMs(start, 8000)).toBe(3000);

    const active = recordOperatorInput(start, 8000);
    expect(active.committedMs).toBe(3000);
    expect(tentativeOperatorMs(active, 9000)).toBe(1000);
    expect(tentativeOperatorMs(active, 8000 + IDLE_TIMEOUT_MS * 2)).toBe(IDLE_TIMEOUT_MS);
    const idle = pauseOperatorClock(active);
    expect(tentativeOperatorMs(idle, 10_000)).toBe(0);
    expect(operatorSessionSnapshot(idle, "annotate")).toEqual({
      workspace: "annotate",
      active_seconds: 3,
      started_at: new Date(5000).toISOString(),
      ended_at: new Date(8000).toISOString(),
    });
    expect(recordOperatorInput(idle, 11_000).committedMs).toBe(3000);
  });

  it("commits the exact idle boundary and restarts the interval after sleep or a clock jump", () => {
    const start = recordOperatorInput(idleOperatorClock, 10_000);
    const boundary = recordOperatorInput(start, 10_000 + IDLE_TIMEOUT_MS);
    expect(boundary.committedMs).toBe(IDLE_TIMEOUT_MS);

    const wake = recordOperatorInput(boundary, boundary.lastInputMs! + IDLE_TIMEOUT_MS + 1);
    expect(wake.committedMs).toBe(IDLE_TIMEOUT_MS);
    expect(wake.lastCommittedWallAt).toBe(boundary.lastInputMs);
    const backwards = recordOperatorInput(wake, 1000);
    expect(backwards.committedMs).toBe(IDLE_TIMEOUT_MS);
    expect(tentativeOperatorMs(wake, 1000)).toBe(0);
    const active = recordOperatorInput(backwards, 2000);
    expect(active.committedMs).toBe(IDLE_TIMEOUT_MS + 1000);
    const snapshot = operatorSessionSnapshot(active, "review");
    expect(snapshot?.ended_at).toBe(snapshot?.started_at);
  });

  it("formats time and ratios", () => {
    expect(formatActiveTime(0)).toBe("0:00");
    expect(formatActiveTime(872.9)).toBe("14:32");
    expect(formatActiveTime(3912)).toBe("1:05:12");
    expect(formatRatio(null)).toBe("—");
    expect(formatRatio(0)).toBe("0.00");
    expect(formatRatio(0.189)).toBe("0.19");
  });
});
