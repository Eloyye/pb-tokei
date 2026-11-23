import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { getMatch } from "../api/client";
import { isWorkspace } from "../lib/workspaces";
import { Workspace } from "../workspace/Workspace";

const route = getRouteApi("/matches/$matchId/$workspace");

export function MatchPage() {
  const { matchId, workspace } = route.useParams();
  const match = useQuery({ queryKey: ["matches", matchId], queryFn: () => getMatch(matchId) });

  if (match.isPending) return <p className="notice">Loading Match…</p>;
  if (match.isError) return <p className="notice error">{match.error.message}</p>;
  if (!isWorkspace(workspace)) return <p className="notice">Page not found.</p>;
  // Keyed by Match so switching Matches starts a fresh player and Timeline, and by whether the
  // video is playable: the player attaches to the <video> when it mounts, so a video that
  // becomes ready while the Match is open (the Match is refetched on window focus) needs a
  // fresh Workspace too.
  const playable = match.data.video_status === "ready";
  return <Workspace key={`${matchId}:${playable}`} match={match.data} workspace={workspace} />;
}
