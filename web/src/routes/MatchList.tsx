import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { listMatches } from "../api/client";
import { franchisesLabel, teamsLabel, VIDEO_STATUS_LABELS } from "./teams";

export function MatchList() {
  const matches = useQuery({ queryKey: ["matches"], queryFn: listMatches });

  if (matches.isPending) return <p className="notice">Loading Matches…</p>;
  if (matches.isError) return <p className="notice error">{matches.error.message}</p>;
  if (matches.data.length === 0) {
    return (
      <p className="notice">
        No Matches yet. Add one with <code>pb-tokei match add &lt;roster file&gt;</code>.
      </p>
    );
  }

  return (
    <main className="match-list">
      <h1>Matches</h1>
      <ul>
        {matches.data.map((match) => (
          <li key={match.id}>
            <Link to="/matches/$matchId" params={{ matchId: match.id }} className="match-row">
              <span className="tournament">{match.tournament}</span>
              <span className="teams">{teamsLabel(match)}</span>
              <span className="franchises">{franchisesLabel(match)}</span>
              <span className={`status status-${match.video_status}`}>
                {VIDEO_STATUS_LABELS[match.video_status]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
