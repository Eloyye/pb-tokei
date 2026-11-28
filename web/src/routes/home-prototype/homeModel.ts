// PROTOTYPE (throwaway, branch prototype/home-screen): what each Home variant knows about a Match.
// Several fields are stubbed because the Match list API doesn't carry them yet; see STUB notes.
import type { Match } from "../../api/client";
import type { Workspace } from "../../lib/workspaces";

export type Stage = "video" | "calibrate" | "annotate" | "review" | "done";
export type StepState = "done" | "current" | "busy" | "todo" | "error";

export const STAGES: Stage[] = ["video", "calibrate", "annotate", "review", "done"];
export const STAGE_LABELS: Record<Stage, string> = {
  video: "Needs video",
  calibrate: "Calibrate",
  annotate: "Annotate",
  review: "Review",
  done: "Done",
};
export const STEP_LABELS: Record<Exclude<Stage, "done">, string> = {
  video: "Video",
  calibrate: "Calibrated",
  annotate: "Annotated",
  review: "Reviewed",
};

export interface Step {
  key: Exclude<Stage, "done">;
  state: StepState;
}

export interface HomeMatch {
  key: string;
  match: Match;
  stage: Stage;
  steps: Step[];
  action: { label: string; workspace: Workspace; disabled?: boolean };
  /** e.g. "Rally 3 of 4"; the API has no per-Game position, so this is Rallies Done + 1. */
  resumeAt: string | null;
}

function fetching(match: Match): { label: string; percent: number | null } | null {
  const job = match.footage_job;
  if (!job) return null;
  if (job.state === "queued") return { label: `Queued (${job.queue_position ?? 1})`, percent: 0 };
  if (job.state === "downloading") return { label: "Downloading", percent: job.percent };
  if (job.state === "converting") return { label: "Converting", percent: job.percent };
  return null;
}

export function fetchLabel(match: Match): string | null {
  const f = fetching(match);
  if (!f) return null;
  return f.percent === null ? `${f.label}…` : `${f.label} ${Math.round(f.percent)}%`;
}

export function fetchPercent(match: Match): number | null {
  return fetching(match)?.percent ?? null;
}

export function toHomeMatch(match: Match, key: string): HomeMatch {
  const assisted = match.annotation_mode === "assisted";
  const videoReady = match.video_status === "ready";
  const busy = fetching(match) !== null;
  const failed = match.footage_job?.state === "error";
  // STUB: no Calibration status in the list API. Treat any Calibrate time or any Rally as calibrated.
  const calibrated = match.operator_time.calibrate_seconds > 0 || match.total_rallies > 0;
  const annotated = match.total_rallies > 0 && match.done_rallies === match.total_rallies;
  // STUB: no review status either. Any Review time counts as reviewed.
  const reviewed = match.operator_time.review_seconds > 0;

  let stage: Stage;
  if (!videoReady) stage = "video";
  else if (!calibrated) stage = "calibrate";
  else if (!annotated) stage = "annotate";
  else if (assisted && !reviewed) stage = "review";
  else stage = "done";

  const keys: Step["key"][] = assisted
    ? ["video", "calibrate", "annotate", "review"]
    : ["video", "calibrate", "annotate"];
  const doneFlags: Record<Step["key"], boolean> = {
    video: videoReady,
    calibrate: calibrated && videoReady,
    annotate: annotated && videoReady,
    review: reviewed && videoReady,
  };
  const steps = keys.map((stepKey): Step => {
    if (stepKey === stage) {
      if (stepKey === "video" && failed) return { key: stepKey, state: "error" };
      if (stepKey === "video" && busy) return { key: stepKey, state: "busy" };
      return { key: stepKey, state: "current" };
    }
    return { key: stepKey, state: doneFlags[stepKey] ? "done" : "todo" };
  });

  const started = match.done_rallies > 0 || match.operator_time.annotate_seconds > 0;
  const action: HomeMatch["action"] = {
    video: busy
      ? { label: fetchLabel(match) ?? "Fetching…", workspace: "annotate" as const, disabled: true }
      : {
          label: failed
            ? "Retry fetch"
            : match.video_status === "not_converted"
              ? "Convert video"
              : "Fetch video",
          workspace: "annotate" as const,
        },
    calibrate: { label: "Calibrate", workspace: "calibrate" as const },
    annotate: { label: started ? "Resume" : "Annotate", workspace: "annotate" as const },
    review: { label: "Review", workspace: "review" as const },
    done: { label: "Report", workspace: "report" as const },
  }[stage];

  const resumeAt =
    stage === "annotate" && match.total_rallies > 0
      ? `Rally ${match.done_rallies + 1} of ${match.total_rallies}`
      : null;
  return { key, match, stage, steps, action, resumeAt };
}

/**
 * STUB: the API has no "last worked on" time, so Continue picks the unfinished, startable Match
 * with the most active time (then the most progress).
 */
export function pickContinue(items: HomeMatch[]): HomeMatch | null {
  const open = items.filter((m) => m.stage !== "done" && !m.action.disabled);
  if (open.length === 0) return null;
  const score = (m: HomeMatch) =>
    m.match.operator_time.active_seconds * 1000 +
    (m.match.total_rallies ? m.match.done_rallies / m.match.total_rallies : 0);
  return open.reduce((best, m) => (score(m) > score(best) ? m : best));
}

export interface TournamentGroup {
  tournament: string;
  items: HomeMatch[];
  dateRange: string;
}

/** Groups in the order the list already arrives (newest first), keeping each Tournament together. */
export function groupByTournament(items: HomeMatch[]): TournamentGroup[] {
  const groups = new Map<string, HomeMatch[]>();
  for (const item of items) {
    const list = groups.get(item.match.tournament) ?? [];
    list.push(item);
    groups.set(item.match.tournament, list);
  }
  return [...groups].map(([tournament, list]) => {
    const dates = list.map((m) => m.match.date).filter((d): d is string => d !== null);
    dates.sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    const dateRange =
      first === undefined ? "undated" : first === last ? first : `${first} – ${last?.slice(5)}`;
    return { tournament, items: list, dateRange };
  });
}

export type Filter = "all" | Stage;

export function filterItems(items: HomeMatch[], filter: Filter, query: string): HomeMatch[] {
  const q = query.trim().toLowerCase();
  return items.filter((m) => {
    if (filter !== "all" && m.stage !== filter) return false;
    if (!q) return true;
    const hay = [
      m.match.tournament,
      ...m.match.team_a,
      ...m.match.team_b,
      m.match.franchise_a ?? "",
      m.match.franchise_b ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

/**
 * PROTOTYPE sample data: the demo Rally Log has no video, so every Match sits at "Needs video".
 * This dresses up copies of the real Matches with a spread of states so each variant can be judged.
 * Links still open the real Match each copy was made from.
 */
const sampleTime = (calibrate: number, annotate: number, review: number) => ({
  active_seconds: calibrate + annotate + review,
  calibrate_seconds: calibrate,
  annotate_seconds: annotate,
  review_seconds: review,
});

export function sampleMatches(real: Match[]): Match[] {
  const [base] = real;
  if (!base) return real;
  const rows: Partial<Match>[] = [
    {
      tournament: "Sample Atlanta Open",
      date: "2026-11-21",
      team_a: ["Rio Vance", "Milo Hart"],
      team_b: ["Theo Lund", "Ivo Marsh"],
      video_status: "ready",
      annotation_mode: "gold",
      total_rallies: 118,
      done_rallies: 47,
      operator_time: sampleTime(900, 2460, 0),
      broadcast_seconds: 3900,
    },
    {
      tournament: "Sample Atlanta Open",
      date: "2026-11-22",
      team_a: ["Nell Ash", "Rio Vance"],
      team_b: ["Sage Bloom", "Kit Rowe"],
      video_status: "ready",
      annotation_mode: "assisted",
      total_rallies: 0,
      done_rallies: 0,
      operator_time: sampleTime(0, 0, 0),
      broadcast_seconds: 3300,
    },
    {
      tournament: "Sample Atlanta Open",
      date: "2026-11-22",
      team_a: ["Owen Pike", "Reid Cole"],
      team_b: ["Jules Fenn", "Dax Moor"],
      video_status: "none",
      footage_job: {
        state: "downloading",
        percent: 42,
        queue_position: null,
      } as Match["footage_job"],
      annotation_mode: "gold",
      total_rallies: 0,
      done_rallies: 0,
      operator_time: sampleTime(0, 0, 0),
    },
    {
      tournament: "Sample MLP Columbus",
      date: "2026-11-08",
      franchise_a: "Harbor Hawks",
      franchise_b: "Mesa Comets",
      team_a: ["Sage Bloom", "Luc Arden"],
      team_b: ["Cleo Brandt", "Finn Holt"],
      video_status: "ready",
      annotation_mode: "assisted",
      total_rallies: 64,
      done_rallies: 64,
      operator_time: sampleTime(300, 420, 0),
      broadcast_seconds: 2400,
    },
    {
      tournament: "Sample MLP Columbus",
      date: "2026-11-08",
      franchise_a: "Harbor Hawks",
      franchise_b: "Mesa Comets",
      team_a: ["Luc Arden", "Wes Calder"],
      team_b: ["Finn Holt", "Ash Kerr"],
      video_status: "ready",
      annotation_mode: "assisted",
      total_rallies: 58,
      done_rallies: 58,
      operator_time: sampleTime(240, 380, 120),
      broadcast_seconds: 2100,
    },
    {
      tournament: "Sample Chicago Open",
      date: "2026-10-30",
      team_a: ["Nico Tran", "Ari Vega"],
      team_b: ["Cal Voss", "Toby Wren"],
      video_status: "not_converted",
      annotation_mode: "gold",
      total_rallies: 0,
      done_rallies: 0,
      operator_time: sampleTime(0, 0, 0),
    },
    {
      tournament: "Sample Chicago Open",
      date: "2026-10-31",
      team_a: ["Nico Tran", "Ari Vega"],
      team_b: ["Rio Vance", "Milo Hart"],
      video_status: "ready",
      annotation_mode: "gold",
      total_rallies: 131,
      done_rallies: 131,
      operator_time: sampleTime(780, 5400, 0),
      broadcast_seconds: 4200,
    },
  ];
  return rows.map((row, i) => {
    const src = real[i % real.length] ?? base;
    const merged = {
      ...src,
      franchise_a: null,
      franchise_b: null,
      footage_job: null,
      ...row,
    } as Match;
    const broadcast = merged.broadcast_seconds;
    merged.operator_time_ratio =
      broadcast && merged.operator_time.active_seconds
        ? merged.operator_time.active_seconds / broadcast
        : null;
    return merged;
  });
}
