import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { CameraView, MatchDetail } from "../api/client";
import { formatTimecode } from "../lib/frames";
import { parseGoto } from "../lib/goto";
import { SPEEDS } from "../lib/keymap";
import { VIEW_LABELS } from "../lib/segments";
import type { PlayerControls, PlayerState } from "../player/usePlayer";
import { Icon } from "./icons";
import { FetchPanel } from "./FetchPanel";
import { Panel, PanelTitle } from "./Panel";

function cameraTag(view: CameraView | "none"): string {
  return view === "none" ? "NOT A PLAY SEGMENT" : VIEW_LABELS[view].toUpperCase();
}

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
  overlay,
  headerTools,
  annotate,
  compact = false,
  swapButton,
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
  /** A layer over the picture, such as Calibrate's Landmarks; it takes clicks on the video. */
  overlay?: ReactNode;
  /** Extra controls in the Monitor header (e.g. Annotate's Player overlay toggle & swaps). */
  headerTools?: ReactNode;
  /** Annotate's Rally and Shot transport (docs/annotation-ui.md, "Monitor"). */
  annotate?: AnnotateTransport;
  /** The smaller slot above the Inspector. */
  compact?: boolean;
  swapButton?: ReactNode;
}) {
  const lastFrame = Math.max(0, state.totalFrames - 1);
  const shownFrame = state.previewFrame ?? state.frame;
  return (
    <Panel
      id="monitor"
      focused={focused}
      className={compact ? "area-side" : "area-main"}
      tabs={<PanelTitle>{title}</PanelTitle>}
      tools={
        <>
          {headerTools}
          {src && (
            <span className="monitor-readout mono">
              {compact
                ? formatTimecode(shownFrame)
                : `${shownFrame.toLocaleString("en-US")} / ${lastFrame.toLocaleString("en-US")}`}
            </span>
          )}
          {swapButton}
        </>
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
            {state.previewFrame === null && overlay}
            {cameraView && (
              <div className={`overlay overlay-camera ${cameraView === "none" ? "off" : ""}`}>
                {cameraTag(cameraView)}
              </div>
            )}
            <div className="overlay overlay-frame">
              <span className="frame">
                <small>FRAME</small>
                {shownFrame.toLocaleString("en-US")}
              </span>
              {!compact && <span className="timecode">{formatTimecode(shownFrame)}</span>}
            </div>
            <div className="overlay overlay-right">
              <div className={`speed ${state.speed < 1 ? "slow" : ""}`}>{state.speed}×</div>
              {annotate?.rallyRange && <div className="rally-range">{annotate.rallyRange}</div>}
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
          <FetchPanel match={match} />
        )}
      </div>
      <Transport state={state} controls={controls} disabled={!src} annotate={annotate} />
    </Panel>
  );
}

export interface AnnotateTransport {
  onRallyStart: () => void;
  onRallyEnd: () => void;
  onAddShot: () => void;
  onRally: (direction: 1 | -1) => void;
  onShot: (direction: 1 | -1) => void;
  /** The selected Rally's frames, shown bottom-right; null without one. */
  rallyRange: string | null;
}

function Transport({
  state,
  controls,
  disabled,
  annotate,
}: {
  state: PlayerState;
  controls: PlayerControls;
  disabled: boolean;
  annotate?: AnnotateTransport;
}) {
  if (annotate) {
    return (
      <div className="transport">
        <div className="transport-group">
          <TransportButton
            icon="markIn"
            label="Rally start at playhead (⇧I)"
            disabled={disabled}
            onClick={annotate.onRallyStart}
          />
          <TransportButton
            icon="markOut"
            label="Rally end at playhead (⇧O)"
            disabled={disabled}
            onClick={annotate.onRallyEnd}
          />
          <button
            type="button"
            className="icon-button mono"
            disabled={disabled}
            title="Add a Shot at the playhead (M)"
            onClick={annotate.onAddShot}
          >
            + Shot
          </button>
        </div>
        <div className="transport-group">
          <TransportButton
            icon="prevRally"
            label="Previous Rally (PgUp)"
            disabled={disabled}
            onClick={() => annotate.onRally(-1)}
          />
          <TransportButton
            icon="prevShot"
            label="Previous Shot (↑)"
            disabled={disabled}
            onClick={() => annotate.onShot(-1)}
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
            title="Play / pause (Space): pauses at the Rally's end"
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
            icon="nextShot"
            label="Next Shot (↓)"
            disabled={disabled}
            onClick={() => annotate.onShot(1)}
          />
          <TransportButton
            icon="nextRally"
            label="Next Rally (PgDn)"
            disabled={disabled}
            onClick={() => annotate.onRally(1)}
          />
        </div>
        <div className="transport-group end">
          <span className="hint">
            <kbd>Enter</kbd> Rally Done, next
          </span>
        </div>
      </div>
    );
  }
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
