// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampSize,
  COURT_LAYOUT_KEY,
  type CourtLayout,
  DEFAULT_SIZES,
  loadCourtLayout,
  parseSizes,
  saveCourtLayout,
} from "./layout";

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

describe("Court layout storage", () => {
  const defaults: CourtLayout = {
    swapped: false,
    orientation: { main: "horizontal", side: "vertical" },
  };
  const layout: CourtLayout = {
    swapped: true,
    orientation: { main: "vertical", side: "horizontal" },
  };

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it.each([null, "null", "not json", '{"swapped":"yes","orientation":{"main":"diagonal"}}'])(
    "uses the default layout for %j",
    (stored) => {
      if (stored !== null) localStorage.setItem(COURT_LAYOUT_KEY, stored);
      expect(loadCourtLayout()).toEqual(defaults);
    },
  );

  it("fills in preferences missing from a partial saved layout", () => {
    localStorage.setItem(COURT_LAYOUT_KEY, '{"swapped":true}');
    expect(loadCourtLayout()).toEqual({ ...defaults, swapped: true });
  });

  it("round-trips every preference", () => {
    saveCourtLayout(layout);
    expect(loadCourtLayout()).toEqual(layout);
  });

  it("handles denied storage reads and writes", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    expect(loadCourtLayout()).toEqual(defaults);
    expect(() => saveCourtLayout(layout)).not.toThrow();
  });
});
