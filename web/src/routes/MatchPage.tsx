import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { getMatch, matchVideoUrl } from "../api/client";
import { Player } from "../player/Player";
import { franchisesLabel, teamsLabel, VIDEO_STATUS_LABELS } from "./teams";

const route = getRouteApi("/matches/$matchId");

export function MatchPage() {
  const { matchId } = route.useParams();
  const match = useQuery({ queryKey: ["matches", matchId], queryFn: () => getMatch(matchId) });

  if (match.isPending) return <p className="notice">Loading Match…</p>;
  if (match.isError) return <p className="notice error">{match.error.message}</p>;

  const franchises = franchisesLabel(match.data);
  return (
    <main className="match-page">
      <div className="match-heading">
        <h1>{teamsLabel(match.data)}</h1>
        <p>
          {match.data.tournament}
          {franchises && ` · ${franchises}`}
        </p>
      </div>
      {match.data.video_status === "ready" ? (
        <Player src={matchVideoUrl(matchId)} />
      ) : (
        <div className="fix">
          <p>
            <span className={`status status-${match.data.video_status}`}>
              {VIDEO_STATUS_LABELS[match.data.video_status]}
            </span>{" "}
            This Match has no playable 60 fps video yet. Run this, then come back:
          </p>
          {match.data.fix_command && <pre>{match.data.fix_command}</pre>}
        </div>
      )}
    </main>
  );
}
