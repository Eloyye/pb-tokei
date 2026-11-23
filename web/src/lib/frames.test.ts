import { describe, expect, it } from "vitest";
import {
  clampFrame,
  formatFrameTime,
  formatLength,
  formatTimecode,
  frameCount,
  frameToSeekTime,
  mediaTimeToFrame,
  timeToFrame,
} from "./frames";
import { parseGoto } from "./goto";

function everyFrameInAnHour(): number[] {
  return Array.from({ length: 60 * 60 * 60 }, (_, n) => n);
}

describe("midpoint rule", () => {
  it("seeks to the middle of the frame", () => {
    expect(frameToSeekTime(0)).toBeCloseTo(0.5 / 60, 12);
    expect(frameToSeekTime(59)).toBeCloseTo(59.5 / 60, 12);
  });

  it("lands back on the same frame for every frame in an hour", () => {
    expect(everyFrameInAnHour().filter((n) => timeToFrame(frameToSeekTime(n)) !== n)).toEqual([]);
  });

  it("reads frame start times as that frame", () => {
    expect(timeToFrame(0)).toBe(0);
    expect(timeToFrame(1 / 60)).toBe(1);
    expect(mediaTimeToFrame(1234 / 60)).toBe(1234);
    expect(mediaTimeToFrame(1234 / 60 - 1e-7)).toBe(1234);
  });
});

describe("frameCount", () => {
  it("counts frames in a constant 60 fps video", () => {
    expect(frameCount(10)).toBe(600);
    expect(frameCount(601 / 60)).toBe(601);
    expect(frameCount(1 / 60)).toBe(1);
  });

  it("is 0 before the duration is known", () => {
    expect(frameCount(Number.NaN)).toBe(0);
    expect(frameCount(0)).toBe(0);
  });
});

describe("clampFrame", () => {
  it("stays within the first and last frame", () => {
    expect(clampFrame(-5, 600)).toBe(0);
    expect(clampFrame(600, 600)).toBe(599);
    expect(clampFrame(42, 600)).toBe(42);
    expect(clampFrame(10, 0)).toBe(0);
  });
});

describe("formatFrameTime", () => {
  it("formats as h:mm:ss.sss", () => {
    expect(formatFrameTime(0)).toBe("0:00:00.000");
    expect(formatFrameTime(1)).toBe("0:00:00.017");
    expect(formatFrameTime(60)).toBe("0:00:01.000");
    expect(formatFrameTime(60 * 60 * 75 + 30)).toBe("1:15:00.500");
  });

  it("round-trips through the go-to box for every frame in an hour", () => {
    expect(everyFrameInAnHour().filter((n) => parseGoto(formatFrameTime(n)) !== n)).toEqual([]);
  });
});

describe("formatTimecode", () => {
  it("counts frames within the second", () => {
    expect(formatTimecode(0)).toBe("00:00:00:00");
    expect(formatTimecode(59)).toBe("00:00:00:59");
    expect(formatTimecode(60)).toBe("00:00:01:00");
  });

  it("carries into minutes and hours", () => {
    expect(formatTimecode(60 * 60 * 60 + 61 * 60 + 7)).toBe("01:01:01:07");
  });

  it("shows negative or fractional frames as the whole frame they start", () => {
    expect(formatTimecode(-5)).toBe("00:00:00:00");
    expect(formatTimecode(61.9)).toBe("00:00:01:01");
  });
});

describe("formatLength", () => {
  it("shows minutes and seconds under an hour", () => {
    expect(formatLength(0)).toBe("0:00");
    expect(formatLength(61 * 60)).toBe("1:01");
    expect(formatLength(59 * 60 * 60 + 59 * 60)).toBe("59:59");
  });

  it("adds hours from an hour", () => {
    expect(formatLength(60 * 60 * 60)).toBe("1:00:00");
    expect(formatLength((85 * 60 + 7) * 60)).toBe("1:25:07");
  });

  it("rounds to the nearest second", () => {
    expect(formatLength(29)).toBe("0:00");
    expect(formatLength(30)).toBe("0:01");
  });
});
