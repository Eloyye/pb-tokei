import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { clampFrame, frameCount, frameToSeekTime, mediaTimeToFrame } from "../lib/frames";
import type { Speed } from "../lib/keymap";

export interface PlayerState {
  /** The frame on screen: the canonical position. */
  frame: number;
  totalFrames: number;
  playing: boolean;
  speed: Speed;
}

export interface PlayerControls {
  seek(frame: number): void;
  step(frames: number, pause: boolean): void;
  togglePlay(): void;
  setSpeed(speed: Speed): void;
}

/**
 * Drives a `<video>` by frame number. Every seek goes to a frame's midpoint; while playing, the
 * frame on screen comes from `requestVideoFrameCallback`.
 */
export function usePlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
): [PlayerState, PlayerControls] {
  const [frame, setFrame] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState<Speed>(1);
  // The latest frame shown or asked for. Seeks start from it, so a held arrow key moves on
  // from the last step even while the browser is still seeking.
  const frameRef = useRef(0);
  const totalRef = useRef(0);

  const seek = useCallback(
    (n: number) => {
      const video = videoRef.current;
      if (!video || totalRef.current === 0) return;
      const target = clampFrame(n, totalRef.current);
      frameRef.current = target;
      setFrame(target);
      video.currentTime = frameToSeekTime(target);
    },
    [videoRef],
  );

  const step = useCallback(
    (frames: number, pause: boolean) => {
      const video = videoRef.current;
      if (!video) return;
      if (pause && !video.paused) video.pause();
      seek(frameRef.current + frames);
    },
    [videoRef, seek],
  );

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || totalRef.current === 0) return;
    if (!video.paused) {
      video.pause();
    } else if (frameRef.current < totalRef.current - 1) {
      // Rejected only when interrupted by a pause or a new source; the state follows events.
      video.play().catch(() => {});
    }
  }, [videoRef]);

  const setSpeed = useCallback(
    (next: Speed) => {
      const video = videoRef.current;
      if (video) {
        video.defaultPlaybackRate = next;
        video.playbackRate = next;
      }
      setSpeedState(next);
    },
    [videoRef],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoadedMetadata = () => {
      totalRef.current = frameCount(video.duration);
      setTotalFrames(totalRef.current);
      seek(0);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      // Settle on the frame last shown, at its midpoint, so stepping on from here is exact.
      if (Math.abs(video.currentTime - frameToSeekTime(frameRef.current)) > 1e-6) {
        seek(frameRef.current);
      }
    };

    let callbackId = 0;
    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      const shown = clampFrame(mediaTimeToFrame(metadata.mediaTime), totalRef.current);
      if (!video.paused) {
        frameRef.current = shown;
        setFrame(shown);
      } else if (
        !video.seeking &&
        frameRef.current === totalRef.current - 1 &&
        shown < frameRef.current
      ) {
        // The duration counted from the container (often set by a longer audio track) ran
        // past the last video frame; the one on screen after seeking to the end is the last.
        totalRef.current = shown + 1;
        setTotalFrames(shown + 1);
        frameRef.current = shown;
        setFrame(shown);
      }
      // Otherwise, when paused, the frame is whatever was last asked for: a callback from an
      // earlier seek must not move it back.
      callbackId = video.requestVideoFrameCallback(onFrame);
    };
    callbackId = video.requestVideoFrameCallback(onFrame);

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onLoadedMetadata();
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.cancelVideoFrameCallback(callbackId);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [videoRef, seek]);

  return [
    { frame, totalFrames, playing, speed },
    { seek, step, togglePlay, setSpeed },
  ];
}
