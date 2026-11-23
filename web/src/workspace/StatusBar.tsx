import { FPS } from "../lib/frames";
import { useOpenHelp } from "../shell/help";

/** The strip under the workspace: the current hint on the left, facts about the video, `?`. */
export function StatusBar({ message, totalFrames }: { message: string; totalFrames: number }) {
  const openHelp = useOpenHelp();
  const seconds = Math.round(totalFrames / FPS);
  const length = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <footer className="statusbar">
      <span className="message">{message}</span>
      {totalFrames > 0 && (
        <span className="mono">
          {totalFrames.toLocaleString("en-US")} frames · {length}
        </span>
      )}
      <span>
        <button type="button" onClick={openHelp}>
          <kbd>?</kbd> shortcuts
        </button>
      </span>
    </footer>
  );
}
