import { formatLength } from "../lib/frames";
import type { SaveStatus } from "../lib/saveQueue";
import { useOpenHelp } from "../shell/help";

const SAVE_LABELS: Record<SaveStatus["state"], string> = {
  saved: "Saved",
  saving: "Saving…",
  retrying: "Save failed, retrying",
  refused: "Save refused",
};

/**
 * The strip under the workspace: save state, the current hint, facts about the video, `?`.
 */
export function StatusBar({
  message,
  saveStatus,
  totalFrames,
}: {
  message: string;
  saveStatus: SaveStatus;
  totalFrames: number;
}) {
  const openHelp = useOpenHelp();
  const failed = saveStatus.state === "retrying" || saveStatus.state === "refused";
  return (
    <footer className="statusbar">
      <output
        className={`save-state ${saveStatus.state}`}
        title={"error" in saveStatus ? saveStatus.error : undefined}
      >
        {SAVE_LABELS[saveStatus.state]}
        {failed && "error" in saveStatus && `: ${saveStatus.error}`}
      </output>
      <span className="message">{message}</span>
      {totalFrames > 0 && (
        <span className="mono">
          {totalFrames.toLocaleString("en-US")} frames · {formatLength(totalFrames)}
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
