// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { frameToSeekTime } from "../lib/frames";
import { usePlayer } from "./usePlayer";

/** Just enough of a `<video>` for `usePlayer`: seeks and frame callbacks are driven by the test. */
class FakeVideo extends EventTarget {
  currentTime = 0;
  duration = 10; // 600 frames
  paused = true;
  seeking = false;
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  private frameCallback: VideoFrameRequestCallback | null = null;

  play = vi.fn<() => Promise<void>>(async () => {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  });

  pause = vi.fn<() => void>(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });

  requestVideoFrameCallback(callback: VideoFrameRequestCallback): number {
    this.frameCallback = callback;
    return 1;
  }

  cancelVideoFrameCallback(): void {
    this.frameCallback = null;
  }

  /** The browser puts `frame` on screen. */
  present(frame: number): void {
    const callback = this.frameCallback;
    act(() => callback?.(0, { mediaTime: frame / 60 } as VideoFrameCallbackMetadata));
  }

  loadMetadata(): void {
    this.readyState = 1;
    act(() => {
      this.dispatchEvent(new Event("loadedmetadata"));
    });
  }
}

let video: FakeVideo;

function renderPlayer() {
  const ref = { current: video as unknown as HTMLVideoElement };
  const { result } = renderHook(() => usePlayer(ref));
  video.loadMetadata();
  return {
    state: () => result.current[0],
    controls: () => result.current[1],
  };
}

beforeEach(() => {
  video = new FakeVideo();
});

describe("usePlayer", () => {
  it("opens paused on frame 0 once the duration is known", () => {
    const player = renderPlayer();

    expect(player.state()).toEqual({
      frame: 0,
      previewFrame: null,
      totalFrames: 600,
      playing: false,
      speed: 1,
    });
    expect(video.currentTime).toBe(frameToSeekTime(0));
  });

  it("adds up quick steps before any seek has finished", () => {
    const player = renderPlayer();

    act(() => {
      player.controls().step(1, true);
      player.controls().step(1, true);
    });

    expect(player.state().frame).toBe(2);
    expect(video.currentTime).toBe(frameToSeekTime(2));
  });

  it("keeps the frame asked for when a stale callback arrives while paused", () => {
    const player = renderPlayer();
    act(() => player.controls().seek(10));

    video.present(9);

    expect(player.state().frame).toBe(10);
  });

  it("follows the frame on screen while playing, and settles on it when paused", () => {
    const player = renderPlayer();
    act(() => player.controls().togglePlay());
    video.currentTime = 0.7123; // somewhere inside frame 42

    video.present(42);
    expect(player.state()).toMatchObject({ frame: 42, playing: true });

    act(() => player.controls().togglePlay());
    expect(player.state()).toMatchObject({ frame: 42, playing: false });
    expect(video.currentTime).toBe(frameToSeekTime(42));
  });

  it("steps from the frame on screen, pausing first", () => {
    const player = renderPlayer();
    act(() => player.controls().togglePlay());
    video.present(42);

    act(() => player.controls().step(-1, true));

    expect(video.pause).toHaveBeenCalled();
    expect(player.state()).toMatchObject({ frame: 41, playing: false });
    expect(video.currentTime).toBe(frameToSeekTime(41));
  });

  it("pauses for an edge preview and restores the playhead frame when it ends", () => {
    const player = renderPlayer();
    act(() => player.controls().play());
    video.present(42);

    act(() => player.controls().preview(72));
    video.present(72);

    expect(video.pause).toHaveBeenCalledOnce();
    expect(player.state()).toMatchObject({ frame: 42, previewFrame: 72, playing: false });
    expect(video.currentTime).toBe(frameToSeekTime(72));

    act(() => player.controls().preview(null));
    expect(player.state()).toMatchObject({ frame: 42, previewFrame: null, playing: false });
    expect(video.currentTime).toBe(frameToSeekTime(42));
  });

  it("clamps steps to the first and last frame", () => {
    const player = renderPlayer();

    act(() => player.controls().step(-5, true));
    expect(player.state().frame).toBe(0);

    act(() => player.controls().seek(10_000));
    expect(player.state().frame).toBe(599);
  });

  it("takes the frame on screen as the last when the video ends before its duration", () => {
    const player = renderPlayer();
    act(() => player.controls().seek(599));

    video.present(598);

    expect(player.state()).toMatchObject({ frame: 598, totalFrames: 599 });
  });

  it("doesn't shorten the video on a callback from a seek still in progress", () => {
    const player = renderPlayer();
    act(() => player.controls().seek(599));
    video.seeking = true;

    video.present(598);

    expect(player.state()).toMatchObject({ frame: 599, totalFrames: 600 });
  });

  it("doesn't play from the last frame", () => {
    const player = renderPlayer();
    act(() => player.controls().seek(599));

    act(() => player.controls().togglePlay());

    expect(video.play).not.toHaveBeenCalled();
    expect(player.state().playing).toBe(false);
  });

  it("sets the playback rate", () => {
    const player = renderPlayer();

    act(() => player.controls().setSpeed(0.25));

    expect(player.state().speed).toBe(0.25);
    expect(video.playbackRate).toBe(0.25);
  });
});
