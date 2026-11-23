import type { Match } from "../api/client";

export function teamsLabel(match: Match): string {
  return `${match.team_a.join(" / ")} vs ${match.team_b.join(" / ")}`;
}

export function franchisesLabel(match: Match): string | null {
  if (match.franchise_a === null || match.franchise_b === null) return null;
  return `${match.franchise_a} vs ${match.franchise_b}`;
}

export const VIDEO_STATUS_LABELS: Record<Match["video_status"], string> = {
  ready: "Video ready",
  not_converted: "Not converted",
  none: "No video",
};
