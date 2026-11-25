import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, isRetryable, listMatches } from "../api/client";
import { useOpenRallyLogPicker } from "../shell/rallyLog";
import { franchisesLabel, VIDEO_STATUS_LABELS } from "./teams";

export function MatchList() {
  const openPicker = useOpenRallyLogPicker();
  const matches = useQuery({
    queryKey: ["matches"],
    queryFn: listMatches,
    retry: (failures, error) => failures < 3 && isRetryable(error),
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

  return (
    <main className="home">
      <div className="home-head">
        <h1>Matches</h1>
        <span className="mono">{matches.data.length} Matches</span>
      </div>
      {matches.data.length === 0 ? (
        <p className="notice">
          No Matches yet. Add one with <code>pb-tokei match add &lt;roster file&gt;</code>.
        </p>
      ) : (
        <div className="match-table">
          <div className="tr thead">
            <span>Tournament</span>
            <span>Match</span>
            <span>Franchise Match</span>
            <span>Video</span>
          </div>
          {matches.data.map((match) => (
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
                <span className={`pill pill-${match.video_status}`}>
                  {VIDEO_STATUS_LABELS[match.video_status]}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
