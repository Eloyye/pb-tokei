import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { CameraView, MatchDetail } from "../api/client";
import { formatTimecode } from "../lib/frames";
import { parseGoto } from "../lib/goto";
import { SPEEDS } from "../lib/keymap";
import type { PlayerControls, PlayerState } from "../player/usePlayer";
import { Icon } from "./icons";
import { Panel, PanelTitle } from "./Panel";
import { VIDEO_STATUS_LABELS } from "../routes/teams";

const CAMERA_TAGS: Record<CameraView | "none", string> = {
  main: "MAIN VIEW",
  sideline: "SIDELINE VIEW",
  none: "NOT A PLAY SEGMENT",
};

/**
 * The Program Monitor: the Match's 60 fps video with the frame number and timecode over it, and
 * the transport under it. A Match without playable video shows the command that fixes it.
 */
export function Monitor({
  match,
  src,
  title,
  videoRef,
  state,
  controls,
  gotoOpen,
  onCloseGoto,
  focused,
  cameraView,
}: {
  match: MatchDetail;
  src: string | null;
  title: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  state: PlayerState;
  controls: PlayerControls;
  gotoOpen: boolean;
  onCloseGoto: () => void;
  focused: boolean;
  /** The Camera View of the Play Segment on screen, "none" outside one, null until known. */
  cameraView: CameraView | "none" | null;
}) {
  const lastFrame = Math.max(0, state.totalFrames - 1);
  return (
    <Panel
      id="monitor"
      focused={focused}
      className="area-monitor"
      tabs={<PanelTitle>{title}</PanelTitle>}
      tools={
        src && (
          <span className="mono">
            {state.frame.toLocaleString("en-US")} / {lastFrame.toLocaleString("en-US")}
          </span>
        )
      }
    >
      <div className="viewer">
        {src ? (
          <>
            <video
              ref={videoRef}
              src={src}
              preload="auto"
              playsInline
              onClick={controls.togglePlay}
            />
            {cameraView && (
              <div className={`overlay overlay-camera ${cameraView === "none" ? "off" : ""}`}>
                {CAMERA_TAGS[cameraView]}
              </div>
            )}
            <div className="overlay overlay-frame">
              <span className="frame">
                <small>FRAME</small>
                {state.frame.toLocaleString("en-US")}
              </span>
              <span className="timecode">{formatTimecode(state.frame)}</span>
            </div>
            <div className="overlay overlay-right">
              <div className={`speed ${state.speed < 1 ? "slow" : ""}`}>{state.speed}×</div>
              <div className={state.playing ? "playing" : ""}>
                {state.playing ? "Playing" : "Paused"}
              </div>
            </div>
            {gotoOpen && (
              <GotoBox
                onGo={(frame) => {
                  controls.seek(frame);
                  onCloseGoto();
                }}
                onClose={onCloseGoto}
              />
            )}
          </>
        ) : (
          <div className="fix">
            <p>
              <span className={`pill pill-${match.video_status}`}>
                {VIDEO_STATUS_LABELS[match.video_status]}
              </span>{" "}
              This Match has no playable 60 fps video yet. Run this, then come back:
            </p>
            {match.fix_command && <pre>{match.fix_command}</pre>}
          </div>
        )}
      </div>
      <Transport state={state} controls={controls} disabled={!src} />
    </Panel>
  );
}

function Transport({
  state,
  controls,
  disabled,
}: {
  state: PlayerState;
  controls: PlayerControls;
  disabled: boolean;
}) {
  return (
    <div className="transport">
      <fieldset className="transport-group" aria-label="Playback speed">
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            type="button"
            className="icon-button mono"
            disabled={disabled}
            aria-pressed={state.speed === speed}
            style={
              state.speed === speed
                ? { color: "var(--text)", background: "var(--raised)" }
                : undefined
            }
            onClick={() => controls.setSpeed(speed)}
          >
            {speed}×
          </button>
        ))}
      </fieldset>
      <div className="transport-group">
        <TransportButton
          icon="secondBack"
          label="Back 1 second (Shift+←)"
          disabled={disabled}
          onClick={() => controls.step(-60, false)}
        />
        <TransportButton
          icon="stepBack"
          label="Back one frame (←)"
          disabled={disabled}
          onClick={() => controls.step(-1, true)}
        />
        <button
          type="button"
          className="icon-button play"
          disabled={disabled}
          onClick={controls.togglePlay}
          title="Play / pause (Space)"
          aria-label={state.playing ? "Pause" : "Play"}
        >
          <Icon name={state.playing ? "pause" : "play"} />
        </button>
        <TransportButton
          icon="stepForward"
          label="Forward one frame (→)"
          disabled={disabled}
          onClick={() => controls.step(1, true)}
        />
        <TransportButton
          icon="secondForward"
          label="Forward 1 second (Shift+→)"
          disabled={disabled}
          onClick={() => controls.step(60, false)}
        />
      </div>
      <div className="transport-group end">
        <span className="hint">
          <kbd>/</kbd> go to
        </span>
      </div>
    </div>
  );
}

function TransportButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <Icon name={icon} />
    </button>
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
      <label htmlFor="goto-input">Go to a frame number, m:ss or h:mm:ss.sss</label>
      <input
        id="goto-input"
        ref={inputRef}
        value={text}
        autoComplete="off"
        placeholder="e.g. 4210 or 1:12"
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
