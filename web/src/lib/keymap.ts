import { FPS } from "./frames";

/**
 * The player's keys. Playback uses only Space, the arrow keys, `[`, `]`, `\`, `/` and modifier
 * combinations: plain letters and digits are kept for recording Shots.
 */

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export type PlayerAction =
  | { type: "togglePlay" }
  /** Move by whole frames. A single-frame step pauses playback first. */
  | { type: "step"; frames: number; pause: boolean }
  | { type: "setSpeed"; speed: Speed }
  | { type: "openGoto" };

export interface KeyInput {
  key: string;
  /** The physical key (`KeyI`, `Digit2`...), for Shift combinations whose `key` varies. */
  code?: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** The action for a key press at the current playback speed, or `null` if the key isn't ours. */
export function keyAction(event: KeyInput, speed: Speed): PlayerAction | null {
  // Ctrl and Cmd combinations belong to the browser (Cmd+← is Back, Cmd+[ too).
  if (event.ctrlKey || event.metaKey) return null;
  const { key, shiftKey: shift, altKey: alt } = event;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (shift && alt) return null;
    const direction = key === "ArrowLeft" ? -1 : 1;
    if (alt) return { type: "step", frames: direction * 10 * FPS, pause: false };
    if (shift) return { type: "step", frames: direction * FPS, pause: false };
    return { type: "step", frames: direction, pause: true };
  }
  if (shift || alt) return null;

  switch (key) {
    case " ":
      return { type: "togglePlay" };
    case "[":
      return { type: "setSpeed", speed: changeSpeed(speed, -1) };
    case "]":
      return { type: "setSpeed", speed: changeSpeed(speed, 1) };
    case "\\":
      return { type: "setSpeed", speed: 1 };
    case "/":
      return { type: "openGoto" };
    default:
      return null;
  }
}

/** The next slower (-1) or faster (+1) speed, staying put at either end of the list. */
export function changeSpeed(speed: Speed, direction: -1 | 1): Speed {
  const index = SPEEDS.indexOf(speed);
  const next = Math.min(SPEEDS.length - 1, Math.max(0, index + direction));
  return SPEEDS[next] ?? speed;
}

/** Whether keys typed into `target` are text, so playback keys must leave them alone. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  const nonText = ["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"];
  return !nonText.includes(target.type);
}

/** `-` zooms the Timeline out and `=` zooms it in (no modifiers); `null` for anything else. */
export function zoomKeyAction(event: KeyInput): "in" | "out" | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.key === "-") return "out";
  if (event.key === "=") return "in";
  return null;
}

/** Backtick swaps the Court and Monitor in workspaces that offer the swap. */
export function isPanelSwapKey(event: KeyInput): boolean {
  return event.key === "`" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export type SegmentAction =
  | { type: "markIn" }
  | { type: "markOut" }
  | { type: "split" }
  | { type: "setView"; view: "main" | "sideline" }
  | { type: "remove" }
  | { type: "cancel" };

/**
 * Calibrate's Play Segment keys. `Shift+I`/`Shift+O` set a segment's bounds, `⌘K` or `Ctrl+K`
 * splits at the playhead, `1`/`2` set its Camera View, and `Backspace` removes it. `Esc` drops a
 * pending segment.
 */
export function segmentKeyAction(event: KeyInput): SegmentAction | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.metaKey || event.ctrlKey) {
    return !event.shiftKey && event.metaKey !== event.ctrlKey && key === "k"
      ? { type: "split" }
      : null;
  }
  if (event.shiftKey) {
    if (key === "i") return { type: "markIn" };
    if (key === "o") return { type: "markOut" };
    return null;
  }
  switch (event.key) {
    case "1":
      return { type: "setView", view: "main" };
    case "2":
      return { type: "setView", view: "sideline" };
    case "Backspace":
      return { type: "remove" };
    case "Escape":
      return { type: "cancel" };
    default:
      return null;
  }
}

/** `F8` jumps to the next rule issue and `Shift+F8` to the previous one; `null` for anything else. */
export function ruleIssueKeyAction(event: KeyInput): 1 | -1 | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key !== "F8") return null;
  return event.shiftKey ? -1 : 1;
}

/** `⌘Z` (`Ctrl+Z`) undoes and `⇧⌘Z` (`Ctrl+Shift+Z`, `Ctrl+Y`) redoes; `null` for anything else. */
export function historyKeyAction(event: KeyInput): "undo" | "redo" | null {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.shiftKey) return "redo";
  return null;
}

export type CalibrationAction = "new" | "skip" | "clear" | "notVisible" | "confirm";

/**
 * Calibrate's Landmark keys: `N` starts a new Calibration from the Play Segment under the
 * playhead, `Tab` skips to the next Landmark, `V` marks the selected Landmark not visible,
 * `C` confirms a carried-over Landmark on the current frame, and `X` clears the selected one.
 */
export function calibrationKeyAction(event: KeyInput): CalibrationAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case "n":
    case "N":
      return "new";
    case "Tab":
      return "skip";
    case "x":
    case "X":
      return "clear";
    case "v":
    case "V":
      return "notVisible";
    case "c":
    case "C":
      return "confirm";
    default:
      return null;
  }
}

export type AnnotateAction =
  | { type: "rallyStart" }
  | { type: "rallyEnd" }
  | { type: "splitRally" }
  | { type: "refereeCall"; call: "point" | "second_server" | "side_out" }
  | { type: "rallyForm" }
  | { type: "challengeForm" }
  | { type: "unseenRally" }
  | { type: "deleteRally" }
  | { type: "done" }
  | { type: "nextGame" }
  | { type: "addShot" }
  | { type: "shotClass"; value: "soft" | "hard" | "lob" | "overhead" }
  | { type: "contactKind"; value: "volley" | "bounce" }
  | { type: "swapPartner" }
  | { type: "switchTeam" }
  | { type: "flag"; flag: "erne" | "atp" }
  | {
      type: "error";
      kind: "net" | "out" | "kitchen_fault" | "double_hit" | "body_hit" | null;
    }
  | { type: "gap"; parity: "odd" | "even" }
  | { type: "deleteEntry" }
  | { type: "cycleCertainty" }
  | { type: "shot"; direction: 1 | -1 }
  | { type: "rally"; direction: 1 | -1 }
  | { type: "cursor"; direction: 1 | -1 }
  | { type: "escape" };

const ERROR_KEYS = {
  "1": "net",
  "2": "out",
  "3": "kitchen_fault",
  "4": "double_hit",
  "5": "body_hit",
} as const;

/**
 * Annotate's Rally and Shot keys (#12; docs/annotation-ui.md, "Keymap"). Shift combinations are
 * matched by `event.code` so `Shift+2` works whatever the layout prints. `null` for anything
 * else, including playback keys.
 */
export function annotateKeyAction(event: KeyInput): AnnotateAction | null {
  if (event.altKey) return null;
  if (event.metaKey || event.ctrlKey) {
    return !event.shiftKey && event.metaKey !== event.ctrlKey && event.key.toLowerCase() === "k"
      ? { type: "splitRally" }
      : null;
  }
  const code = event.code ?? "";
  const key = event.key;
  if (event.shiftKey) {
    switch (code) {
      case "KeyI":
        return { type: "rallyStart" };
      case "KeyO":
        return { type: "rallyEnd" };
      case "KeyP":
        return { type: "refereeCall", call: "point" };
      case "Digit2":
        return { type: "refereeCall", call: "second_server" };
      case "KeyX":
        return { type: "refereeCall", call: "side_out" };
      case "KeyS":
        return { type: "rallyForm" };
      case "KeyC":
        return { type: "challengeForm" };
      case "KeyU":
        return { type: "unseenRally" };
      case "KeyH":
        return { type: "switchTeam" };
      case "KeyG":
        return { type: "gap", parity: "even" };
      case "Backspace":
        return { type: "deleteRally" };
      case "Enter":
        return { type: "nextGame" };
      case "Tab":
        return { type: "cursor", direction: -1 };
    }
    if (key === "Tab") return { type: "cursor", direction: -1 };
    return null;
  }
  if (key in ERROR_KEYS) return { type: "error", kind: ERROR_KEYS[key as keyof typeof ERROR_KEYS] };
  switch (key.toLowerCase()) {
    case "0":
      return { type: "error", kind: null };
    case "m":
      return { type: "addShot" };
    case "s":
      return { type: "shotClass", value: "soft" };
    case "h":
      return { type: "shotClass", value: "hard" };
    case "l":
      return { type: "shotClass", value: "lob" };
    case "o":
      return { type: "shotClass", value: "overhead" };
    case "v":
      return { type: "contactKind", value: "volley" };
    case "b":
      return { type: "contactKind", value: "bounce" };
    case "x":
      return { type: "swapPartner" };
    case "e":
      return { type: "flag", flag: "erne" };
    case "t":
      return { type: "flag", flag: "atp" };
    case "g":
      return { type: "gap", parity: "odd" };
    case "c":
      return { type: "cycleCertainty" };
    case "backspace":
      return { type: "deleteEntry" };
    case "enter":
      return { type: "done" };
    case "arrowup":
      return { type: "shot", direction: -1 };
    case "arrowdown":
      return { type: "shot", direction: 1 };
    case "pageup":
      return { type: "rally", direction: -1 };
    case "pagedown":
      return { type: "rally", direction: 1 };
    case "tab":
      return { type: "cursor", direction: 1 };
    case "escape":
      return { type: "escape" };
    default:
      return null;
  }
}
