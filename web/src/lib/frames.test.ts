import { describe, expect, it } from "vitest";
import {
  clampFrame,
  formatFrameTime,
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
