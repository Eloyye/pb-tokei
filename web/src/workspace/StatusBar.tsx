import type { MatchDetail } from "../api/client";
import { FPS, formatLength } from "../lib/frames";
import {
  formatActiveTime,
  formatRatio,
  operatorRatio,
  operatorTimeTitle,
  ratioClassName,
} from "../lib/operatorTime";
import type { IssueCounts } from "../lib/ruleChecks";
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
  issueCounts,
  onNextIssue,
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
  issueCounts?: IssueCounts;
  onNextIssue?: () => void;
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
  const showIssues = workspace !== "calibrate" && issueCounts !== undefined;
  const totalIssues = showIssues ? issueCounts.red + issueCounts.amber : 0;
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
      {showIssues && (
        <span>
          <button
            type="button"
            className="sb-issues"
            title={
              totalIssues > 0
                ? "Jump to next rule issue (F8; Shift+F8 for previous)"
                : "No rule issues in this Match (F8)"
            }
            onClick={onNextIssue}
          >
            {issueCounts.red > 0 && <span className="sb-red">● {issueCounts.red}</span>}
            {issueCounts.amber > 0 && <span className="sb-amber">● {issueCounts.amber}</span>}
            <span>{totalIssues === 0 ? "No issues" : totalIssues === 1 ? "issue" : "issues"}</span>
          </button>
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
