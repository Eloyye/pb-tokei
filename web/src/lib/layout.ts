/**
 * The workspace's resizable panel sizes, in CSS pixels, and how they are kept per browser.
 * Splitters change them; anything stored that is missing or out of range falls back to the
 * default or is clamped.
 */

export interface PanelSizes {
  /** Width of the right column (Court and Inspector). */
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
