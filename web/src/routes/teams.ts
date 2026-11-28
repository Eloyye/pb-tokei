import type { Match } from "../api/client";
import type { components } from "../api/schema";

export function teamsLabel(match: Pick<Match, "team_a" | "team_b">): string {
  return `${match.team_a.join(" / ")} vs ${match.team_b.join(" / ")}`;
}

export function reportTeamLabel(team: components["schemas"]["ReportTeam"]): string {
  return team.players.map((player) => player.name).join(" / ");
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

export function videoPill(match: Match): { label: string; className: string } {
  const job = match.footage_job;
  if (job) {
    if (job.state === "queued") {
      return { label: `Queued (${job.queue_position ?? 1})`, className: "pill pill-queued" };
    }
    if (job.state === "downloading") {
      const label =
        job.percent !== null ? `Downloading ${Math.round(job.percent)}%` : "Downloading…";
      return { label, className: "pill pill-active" };
    }
    if (job.state === "converting") {
      const label = job.percent !== null ? `Converting ${Math.round(job.percent)}%` : "Converting…";
      return { label, className: "pill pill-active" };
    }
    if (job.state === "error") {
      return { label: "Fetch failed", className: "pill pill-error" };
    }
  }
  return {
    label: VIDEO_STATUS_LABELS[match.video_status],
    className: `pill pill-${match.video_status}`,
  };
}
