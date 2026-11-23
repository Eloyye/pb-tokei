import { type FormEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { clampFrame, formatFrameTime } from "../lib/frames";
import { parseGoto } from "../lib/goto";
import { isTextEntry, keyAction, type PlayerAction } from "../lib/keymap";
import { usePlayer } from "./usePlayer";

/** Plays a Match's 60 fps video, opening paused on frame 0 with audio on. Keyboard first. */
export function Player({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, controls] = usePlayer(videoRef);
  const { speed } = state;
  const { seek, step, togglePlay, setSpeed } = controls;
  const [gotoOpen, setGotoOpen] = useState(false);

  useEffect(() => {
    const run = (action: PlayerAction) => {
      switch (action.type) {
        case "togglePlay":
          return togglePlay();
        case "step":
          return step(action.frames, action.pause);
        case "setSpeed":
          return setSpeed(action.speed);
        case "openGoto":
          return setGotoOpen(true);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) return;
      const action = keyAction(event, speed);
      if (!action) return;
      event.preventDefault();
      // Only frame stepping repeats while a key is held.
      if (event.repeat && action.type !== "step") return;
      run(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [speed, step, togglePlay, setSpeed]);

  const lastFrame = Math.max(0, state.totalFrames - 1);
  return (
    <section className="player">
      <video ref={videoRef} src={src} preload="auto" playsInline onClick={togglePlay} />
      <ScrubBar frame={state.frame} totalFrames={state.totalFrames} onSeek={seek} />
      <div className="readout">
        <span className="frame" title="Frame number">
          <span className="label">Frame</span> {state.frame}
          <span className="of"> / {lastFrame}</span>
        </span>
        <span className="time" title="h:mm:ss.sss">
          {formatFrameTime(state.frame)}
        </span>
        <span className="speed" title="Playback speed">
          {state.speed}×
        </span>
        <span className={state.playing ? "state playing" : "state"}>
          {state.playing ? "Playing" : "Paused"}
        </span>
        {gotoOpen && (
          <GotoBox
            onGo={(frame) => {
              seek(frame);
              setGotoOpen(false);
            }}
            onClose={() => setGotoOpen(false)}
          />
        )}
      </div>
      <KeyHelp />
    </section>
  );
}

function ScrubBar({
  frame,
  totalFrames,
  onSeek,
}: {
  frame: number;
  totalFrames: number;
  onSeek: (frame: number) => void;
}) {
  const seekTo = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    onSeek(clampFrame(Math.floor(fraction * totalFrames), totalFrames));
  };
  const progress = totalFrames > 1 ? (frame / (totalFrames - 1)) * 100 : 0;
  return (
    <div
      className="scrub"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        seekTo(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) seekTo(event);
      }}
    >
      <div className="scrub-fill" style={{ width: `${progress}%` }} />
    </div>
  );
}

function GotoBox({ onGo, onClose }: { onGo: (frame: number) => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  useEffect(() => inputRef.current?.focus(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const frame = parseGoto(text);
    if (frame === null) setInvalid(true);
    else onGo(frame);
  };
  return (
    <form className="goto" onSubmit={submit}>
      <input
        ref={inputRef}
        value={text}
        aria-label="Go to frame or time"
        placeholder="frame, m:ss or h:mm:ss.sss"
        aria-invalid={invalid}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        onBlur={onClose}
      />
    </form>
  );
}

const KEYS: [string, string][] = [
  ["Space", "play / pause"],
  ["← →", "1 frame"],
  ["⇧ ← →", "1 s"],
  ["⌥ ← →", "10 s"],
  ["[ ]", "slower / faster"],
  ["\\", "1×"],
  ["/", "go to"],
];

function KeyHelp() {
  return (
    <ul className="keys">
      {KEYS.map(([key, action]) => (
        <li key={key}>
          <kbd>{key}</kbd> {action}
        </li>
      ))}
    </ul>
  );
}
