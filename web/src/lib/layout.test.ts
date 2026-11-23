import { describe, expect, it } from "vitest";
import { clampSize, DEFAULT_SIZES, parseSizes } from "./layout";

describe("clampSize", () => {
  it("keeps each panel within its limits", () => {
    expect(clampSize("side", 100)).toBe(300);
    expect(clampSize("side", 9999)).toBe(560);
    expect(clampSize("bottom", 300.4)).toBe(300);
  });
});

describe("parseSizes", () => {
  it("uses the defaults when nothing is stored or it isn't JSON", () => {
    expect(parseSizes(null)).toEqual(DEFAULT_SIZES);
    expect(parseSizes("not json")).toEqual(DEFAULT_SIZES);
    expect(parseSizes("[1, 2]")).toEqual(DEFAULT_SIZES);
  });

  it("keeps stored sizes, clamped, and defaults the rest", () => {
    expect(parseSizes(JSON.stringify({ side: 420, bottom: 9999, rallies: "wide" }))).toEqual({
      side: 420,
      bottom: 440,
      rallies: DEFAULT_SIZES.rallies,
    });
  });
});
