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
