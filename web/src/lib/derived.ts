import type { Rally, Shot } from "../api/client";
import {
  ESTABLISHED_MAX_Y_FT,
  FRONTCOURT_MAX_Y_FT,
  isShot,
  known,
  type Roster,
  teamOf,
  teamPlayers,
} from "./rallyLog";

/**
 * A read-only preview of Derived judgments (GLOSSARY.md, ADR 0003): Team Status, Rally Phase and
 * Shot Type at a Shot. Never stored; Event Processing (#16) owns the official versions.
 */

export type TeamStatus = "established" | "split" | "back" | "unknown";
export type RallyPhase = "serve" | "return" | "transition" | "frontcourt_battle" | "scramble";
export type ShotType =
  | "serve"
  | "return"
  | "dink"
  | "block"
  | "drop"
  | "reset"
  | "speedup"
  | "counter"
  | "drive"
  | "offensive_lob"
  | "defensive_lob"
  | "lob"
  | "overhead";

export const TEAM_STATUS_LABELS: Record<TeamStatus, string> = {
  established: "Established",
  split: "Split",
  back: "Back",
  unknown: "Unknown",
};

export const RALLY_PHASE_LABELS: Record<RallyPhase, string> = {
  serve: "Serve",
  return: "Return",
  transition: "Transition",
  frontcourt_battle: "Frontcourt Battle",
  scramble: "Scramble",
};

export const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  serve: "Serve",
  return: "Return",
  dink: "Dink",
  block: "Block",
  drop: "Drop",
  reset: "Reset",
  speedup: "Speedup",
  counter: "Counter",
  drive: "Drive",
  offensive_lob: "Offensive Lob",
  defensive_lob: "Defensive Lob",
  lob: "Lob",
  overhead: "Overhead",
};

/** Each Team's Status at each Shot of a Rally, in entry order (keyed by entry index). */
export function teamStatuses(
  roster: Roster,
  rally: Rally,
): Map<number, Record<string, TeamStatus>> {
  const out = new Map<number, Record<string, TeamStatus>>();
  const teams = [roster.teamA, roster.teamB];
  const established: Record<string, boolean> = {};
  rally.entries.forEach((entry, index) => {
    if (!isShot(entry)) return;
    const statuses: Record<string, TeamStatus> = {};
    for (const team of teams) {
      const depths = teamPlayers(roster, team).map((p) => {
        const position = entry.positions[p.id]?.position;
        return position && known(position) ? Math.abs(position.value.y) : null;
      });
      if (depths.length !== 2 || depths.some((d) => d === null)) {
        statuses[team] = "unknown";
        continue;
      }
      const [a, b] = depths as [number, number];
      const stays = established[team] && a <= ESTABLISHED_MAX_Y_FT && b <= ESTABLISHED_MAX_Y_FT;
      const arrives = a <= FRONTCOURT_MAX_Y_FT && b <= FRONTCOURT_MAX_Y_FT;
      established[team] = Boolean(stays || arrives);
      statuses[team] = established[team]
        ? "established"
        : a <= FRONTCOURT_MAX_Y_FT || b <= FRONTCOURT_MAX_Y_FT
          ? "split"
          : "back";
    }
    out.set(index, statuses);
  });
  return out;
}

/** The Rally Phase at the Shot at `index`, or null when it can't be worked out. */
export function rallyPhase(roster: Roster, rally: Rally, index: number): RallyPhase | null {
  const shot = rally.entries[index];
  if (!isShot(shot)) return null;
  if (shot.shot_number.value === 1) return "serve";
  if (shot.shot_number.value === 2) return "return";
  const statuses = teamStatuses(roster, rally);
  const now = statuses.get(index);
  if (!now) return null;
  const teams = [roster.teamA, roster.teamB];
  const everEstablished = (team: string) =>
    [...statuses].some(([i, s]) => i < index && s[team] === "established");
  if (teams.some((t) => everEstablished(t) && now[t] !== "established" && now[t] !== "unknown")) {
    return "scramble";
  }
  if (teams.some((t) => now[t] === "unknown")) return null;
  if (teams.every((t) => now[t] === "established")) return "frontcourt_battle";
  return "transition";
}

/** Whether a Shot is an Attack (Hard or Overhead); null if its Shot Class is Unknown. */
function isAttack(shot: Shot): boolean | null {
  const shotClass = shot.shot_class.value;
  if (shotClass === null) return null;
  return shotClass === "hard" || shotClass === "overhead";
}

/** The Shot Type of the Shot at `index`, or null when it can't be worked out. */
export function shotType(roster: Roster, rally: Rally, index: number): ShotType | null {
  const shot = rally.entries[index];
  if (!isShot(shot)) return null;
  if (shot.shot_number.value === 1) return "serve";
  if (shot.shot_number.value === 2) return "return";
  const shotClass = shot.shot_class.value;
  if (shotClass === null) return null;
  if (shotClass === "overhead") return "overhead";
  if (shotClass === "lob") {
    const hitter = shot.hitter_id.value;
    const team = hitter === null ? null : teamOf(roster, hitter);
    const status = team === null ? undefined : teamStatuses(roster, rally).get(index)?.[team];
    if (status === "established") return "offensive_lob";
    if (status === undefined || status === "unknown") return "lob";
    return "defensive_lob";
  }
  const zone = shot.contact_zone.value;
  if (zone === null) return null;
  if (shotClass === "hard" && zone !== "frontcourt") return "drive";
  // The incoming Shot: the entry just before, if it is a Shot (not an Observation Gap).
  const previous = rally.entries[index - 1];
  const incomingAttack = isShot(previous) ? isAttack(previous) : null;
  if (incomingAttack === null) return null;
  if (shotClass === "soft") {
    if (zone === "frontcourt") return incomingAttack ? "block" : "dink";
    return incomingAttack ? "reset" : "drop";
  }
  return incomingAttack ? "counter" : "speedup";
}
