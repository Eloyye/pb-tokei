import type { Match } from "../api/client";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a real YYYY-MM-DD calendar date with a 4-digit year. */
export function isValidMatchDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1000) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Matches newest date first, null dates last, then Tournament name and id. */
export function compareMatches(a: Match, b: Match): number {
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return b.date < a.date ? -1 : 1;
  }
  if (a.tournament !== b.tournament) return a.tournament < b.tournament ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function teamsLabel(match: Pick<Match, "team_a" | "team_b">): string {
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
