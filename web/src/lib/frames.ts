/**
 * Frame numbers in the converted constant 60 fps video, as defined in `rally_log/model.py`:
 * frame `n` starts at `n / 60` s, and players seek to its midpoint `(n + 0.5) / 60` s so
 * floating-point rounding never lands on the previous frame.
 */

export const FPS = 60;

/** The time to seek to so the video shows frame `n`. */
export function frameToSeekTime(n: number): number {
  return (n + 0.5) / FPS;
}

/** The frame on screen at playback time `t` (e.g. `video.currentTime`). */
export function timeToFrame(t: number): number {
  return Math.floor(t * FPS);
}

/** The frame whose presentation timestamp is `mediaTime` (`requestVideoFrameCallback`). */
export function mediaTimeToFrame(mediaTime: number): number {
  return Math.round(mediaTime * FPS);
}

/** How many frames a video of `duration` seconds has. */
export function frameCount(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  // The epsilon absorbs float error in durations like 601 / 60.
  return Math.max(1, Math.floor(duration * FPS + 1e-6));
}

/** `n` moved into `[0, total - 1]` (0 when there are no frames). */
export function clampFrame(n: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, Math.trunc(n)));
}

/**
 * Frame `n`'s time as `h:mm:ss.sss`. The milliseconds are rounded up so the time shown always
 * falls inside the frame, and typing it into the go-to box lands back on frame `n`.
 */
export function formatFrameTime(n: number): string {
  const totalMs = Math.ceil((n * 1000) / FPS);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Frame `n` as an `HH:MM:SS:FF` timecode, Premiere style: `FF` counts frames within the second
 * (00 to 59 at 60 fps). Used on the Timeline ruler and under the Monitor's frame number.
 */
export function formatTimecode(n: number): string {
  const frame = Math.max(0, Math.trunc(n));
  const ff = frame % FPS;
  const totalSeconds = Math.floor(frame / FPS);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}:${pad(ff, 2)}`;
}

/** The length of a video of `totalFrames` frames, to the nearest second: `m:ss`, or `h:mm:ss`. */
export function formatLength(totalFrames: number): string {
  const totalSeconds = Math.round(Math.max(0, totalFrames) / FPS);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
}
