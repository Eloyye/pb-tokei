import type { CourtOrientation } from "./courtView";

/**
 * The workspace's resizable panel sizes, in CSS pixels, and how they are kept per browser.
 * Splitters change them; anything stored that is missing or out of range falls back to the
 * default or is clamped.
 */

export interface PanelSizes {
  /** Width of the right column. */
  side: number;
  /** Height of the bottom row (Rallies and Timeline). */
  bottom: number;
  /** Width of the Rallies panel. */
  rallies: number;
}

export const DEFAULT_SIZES: PanelSizes = { side: 380, bottom: 250, rallies: 220 };

const LIMITS: Record<keyof PanelSizes, [number, number]> = {
  side: [300, 560],
  bottom: [170, 440],
  rallies: [170, 360],
};

export const STORAGE_KEY = "pb-tokei:panel-sizes";

/** `value` for panel `key`, rounded and kept within that panel's limits. */
export function clampSize(key: keyof PanelSizes, value: number): number {
  const [min, max] = LIMITS[key];
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** Sizes read back from storage; anything unusable becomes the default. */
export function parseSizes(stored: string | null): PanelSizes {
  let raw: unknown = null;
  try {
    raw = stored === null ? null : JSON.parse(stored);
  } catch {
    raw = null;
  }
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = (key: keyof PanelSizes) => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value)
      ? clampSize(key, value)
      : DEFAULT_SIZES[key];
  };
  return { side: pick("side"), bottom: pick("bottom"), rallies: pick("rallies") };
}

export function loadSizes(): PanelSizes {
  try {
    return parseSizes(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_SIZES;
  }
}

export function saveSizes(sizes: PanelSizes): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // Storage can be unavailable (private window, blocked site data); sizes then last a session.
  }
}

export type CourtSlot = "main" | "side";

export interface CourtLayout {
  swapped: boolean;
  orientation: Record<CourtSlot, CourtOrientation>;
}

const COURT_LAYOUT_KEY = "pb-tokei:court-layout";
const DEFAULT_COURT_LAYOUT: CourtLayout = {
  swapped: false,
  orientation: { main: "horizontal", side: "vertical" },
};

export function loadCourtLayout(): CourtLayout {
  try {
    const stored = window.localStorage.getItem(COURT_LAYOUT_KEY);
    const saved = stored ? (JSON.parse(stored) as Partial<CourtLayout> | null) : null;
    return {
      swapped: saved?.swapped === true,
      orientation: {
        main: saved?.orientation?.main === "vertical" ? "vertical" : "horizontal",
        side: saved?.orientation?.side === "horizontal" ? "horizontal" : "vertical",
      },
    };
  } catch {
    return DEFAULT_COURT_LAYOUT;
  }
}

export function saveCourtLayout(layout: CourtLayout): void {
  try {
    window.localStorage.setItem(COURT_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // The preference still applies while this Match is open.
  }
}
