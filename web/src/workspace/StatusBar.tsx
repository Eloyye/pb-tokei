import type { MatchDetail } from "../api/client";
import { FPS, formatLength } from "../lib/frames";
import {
  formatActiveTime,
  formatRatio,
  operatorRatio,
  operatorTimeTitle,
  ratioClassName,
} from "../lib/operatorTime";
import type { SaveStatus } from "../lib/saveQueue";
import type { Workspace } from "../lib/workspaces";
import { useOpenHelp } from "../shell/help";
import { useOperatorTime } from "./useOperatorTime";

const SAVE_LABELS: Record<SaveStatus["state"], string> = {
  saved: "Saved",
  saving: "Saving…",
  retrying: "Save failed, retrying",
  refused: "Save refused",
};

/**
 * Save state, the current hint, operator time, and the shortcut button.
 */
export function StatusBar({
  message,
  saveStatus,
  match,
  workspace,
}: {
  message: string;
  saveStatus: SaveStatus;
  match: Pick<
    MatchDetail,
    | "id"
    | "video_status"
    | "operator_time"
    | "annotation_mode"
    | "broadcast_seconds"
    | "assisted_ratio_budget"
  >;
  workspace: Workspace;
}) {
  const openHelp = useOpenHelp();
  const failed = saveStatus.state === "retrying" || saveStatus.state === "refused";
  const { time, idle } = useOperatorTime(match, workspace);
  const ratio = operatorRatio(time.active_seconds, match.broadcast_seconds);
  const budget =
    match.annotation_mode === "assisted" || workspace === "review"
      ? match.assisted_ratio_budget
      : null;
  const budgetLabel = formatRatio(budget);
  const length =
    match.broadcast_seconds === null
      ? "broadcast length unavailable"
      : formatLength(match.broadcast_seconds * FPS);
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
      <span
        className={`mono active-time${idle ? " idle" : ""}`}
        title={`${operatorTimeTitle(time)}${idle ? " (paused — idle)" : ""}`}
      >
        Active {formatActiveTime(time.active_seconds)}
      </span>
      <span
        className={`mono ${ratioClassName(ratio, budget)}`}
        title={`Operator minutes ÷ broadcast minutes (${length})${budget !== null ? ` · Assisted budget ${budgetLabel}` : ""}`}
      >
        Ratio {formatRatio(ratio)}
        {budget !== null && ratio !== null && ` / ${budgetLabel}`}
      </span>
      <span>
        <button type="button" onClick={openHelp}>
          <kbd>?</kbd> shortcuts
        </button>
      </span>
    </footer>
  );
}
