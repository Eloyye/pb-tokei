import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, isRetryable, listMatches } from "../api/client";
import {
  formatActiveTime,
  formatRatio,
  operatorTimeTitle,
  ratioClassName,
} from "../lib/operatorTime";
import { useOpenRallyLogPicker } from "../shell/rallyLog";
import { franchisesLabel, videoPill } from "./teams";

const POLL_MS = 1000;

export function MatchList() {
  const openPicker = useOpenRallyLogPicker();
  const matches = useQuery({
    queryKey: ["matches"],
    queryFn: listMatches,
    retry: (failures, error) => failures < 3 && isRetryable(error),
    refetchInterval: (query) =>
      query.state.data?.some(
        (m) =>
          m.footage_job &&
          (m.footage_job.state === "queued" ||
            m.footage_job.state === "downloading" ||
            m.footage_job.state === "converting"),
      )
        ? POLL_MS
        : false,
  });

  if (matches.isPending) return <p className="notice">Loading Matches…</p>;
  if (matches.isError) {
    // 409: no Rally Log is open yet, or another tab has switched it.
    const conflict = matches.error instanceof ApiError && matches.error.status === 409;
    return (
      <p className="notice error">
        {matches.error.message}
        {conflict && (
          <>
            {" "}
            <button type="button" className="button" onClick={openPicker}>
              Choose a Rally Log
            </button>
          </>
        )}
      </p>
    );
  }

  const [firstMatch] = matches.data;
  return (
    <main className="home">
      <div className="home-head">
        <div className="match-list-title">
          <h1>Matches</h1>
          <span className="mono">{matches.data.length}</span>
        </div>
        <Link to="/matches/new" className="button primary">
          New Match
        </Link>
      </div>
      {matches.data.length === 0 ? (
        <p className="notice">No Matches yet.</p>
      ) : (
        <div className="match-table">
          <div className="tr thead">
            <span>Tournament</span>
            <span>Match</span>
            <span>Franchise Match</span>
            <span>Video</span>
            <span>Mode</span>
            <span className="number">Active</span>
            <span className="number">Ratio</span>
          </div>
          {matches.data.map((match) => {
            const pill = videoPill(match);
            const assisted = match.annotation_mode === "assisted";
            const budget = assisted ? match.assisted_ratio_budget : null;
            return (
              <Link
                key={match.id}
                to="/matches/$matchId/$workspace"
                params={{ matchId: match.id, workspace: "annotate" }}
                className="tr"
              >
                <span className="dimmed">{match.tournament}</span>
                <span className="teams-cell">
                  <span className="swatch team-a" />
                  {match.team_a.join(" / ")}
                  <span className="vs">vs</span>
                  <span className="swatch team-b" />
                  {match.team_b.join(" / ")}
                </span>
                <span className="dimmed">{franchisesLabel(match) ?? "—"}</span>
                <span>
                  <span className={pill.className}>{pill.label}</span>
                </span>
                <span>
                  <span className={`pill ${assisted ? "pill-active" : "pill-none"}`}>
                    {assisted ? "Assisted" : "Gold"}
                  </span>
                </span>
                <span className="number mono dimmed" title={operatorTimeTitle(match.operator_time)}>
                  {formatActiveTime(match.operator_time.active_seconds)}
                </span>
                <span
                  className={`number mono ${ratioClassName(match.operator_time_ratio, budget)}`}
                >
                  {formatRatio(match.operator_time_ratio)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
      {firstMatch && (
        <p className="ratio-note">
          Ratio = operator minutes ÷ broadcast minutes. Assisted Annotation has a{" "}
          {formatRatio(firstMatch.assisted_ratio_budget)} budget (ADR 0004). Gold Annotation has no
          time budget.
        </p>
      )}
    </main>
  );
}
