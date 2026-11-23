import { FPS } from "./frames";

/**
 * Parses what was typed in the go-to box into a frame number, or `null` if it isn't one.
 *
 * - `1234`: frame 1234
 * - `m:ss` (optionally `m:ss.sss`): the frame on screen at that time
 * - `h:mm:ss.sss` (the fraction is optional): the frame on screen at that time
 *
 * The frame is not clamped to the video's length; the player does that.
 */
export function parseGoto(input: string): number | null {
  const text = input.trim();
  if (/^\d+$/.test(text)) return Number(text);

  const match = /^(?:(\d+):)?(\d+):(\d{2})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return null;
  const [, hoursText, minutesText = "0", secondsText = "0", fraction = ""] = match;
  const hours = hoursText === undefined ? 0 : Number(hoursText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (seconds >= 60) return null;
  if (hoursText !== undefined && (minutes >= 60 || minutesText.length !== 2)) return null;

  // Whole milliseconds keep the arithmetic exact: frame = floor(ms * 60 / 1000).
  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(fraction.padEnd(3, "0"));
  return Math.floor((ms * FPS) / 1000);
}
