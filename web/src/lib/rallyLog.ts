import type {
  Certainty,
  CourtPoint,
  Game,
  MatchDetail,
  MatchPlayer,
  ObservationGap,
  PlayerTrackingFrameOut,
  Rally,
  RallyEntry,
  Shot,
  ShotPosition,
  Zone,
} from "../api/client";

/**
 * The Rally Log as the Annotate workspace edits it: facts, the Match's roster, and new Rallies
 * and Shots. Everything here is pure so every edit can be undone (docs/annotation-ui.md).
 */

/** A value with how we know it; Unknown facts have no value (GLOSSARY.md, "Observed"). */
export interface Fact<T> {
  value: T | null;
  certainty: Certainty;
}

export const UNKNOWN: Fact<never> = { value: null, certainty: "unknown" };

export function observed<T>(value: T): Fact<T> {
  return { value, certainty: "observed" };
}

export function inferred<T>(value: T): Fact<T> {
  return { value, certainty: "inferred" };
}

/** Whether a fact has a value (Observed or Inferred). */
export function known<T>(fact: Fact<T>): fact is { value: T; certainty: Certainty } {
  return fact.value !== null && fact.certainty !== "unknown";
}

/** The two Teams and four Players of a Match, by id, with partner and opponent lookups. */
export interface Roster {
  teamA: string;
  teamB: string;
  players: readonly MatchPlayer[];
}

export function rosterOf(match: Pick<MatchDetail, "team_a_id" | "team_b_id" | "players">): Roster {
  return { teamA: match.team_a_id, teamB: match.team_b_id, players: match.players };
}

export function otherTeam(roster: Roster, teamId: string): string {
  return teamId === roster.teamA ? roster.teamB : roster.teamA;
}

export function teamPlayers(roster: Roster, teamId: string): MatchPlayer[] {
  return roster.players.filter((p) => p.team_id === teamId);
}

export function teamOf(roster: Roster, playerId: string): string | null {
  return roster.players.find((p) => p.id === playerId)?.team_id ?? null;
}

export function partnerOf(roster: Roster, playerId: string): string | null {
  const team = teamOf(roster, playerId);
  if (team === null) return null;
  return teamPlayers(roster, team).find((p) => p.id !== playerId)?.id ?? null;
}

/** A Player's name, or "Unknown". */
export function playerName(roster: Roster, playerId: string | null): string {
  return roster.players.find((p) => p.id === playerId)?.name ?? "Unknown";
}

/** The first Player (in name order) of a Team. */
export function firstPlayer(roster: Roster, teamId: string): string | null {
  return teamPlayers(roster, teamId)[0]?.id ?? null;
}

export function teamKey(roster: Roster, teamId: string | null): "a" | "b" | null {
  if (teamId === roster.teamA) return "a";
  if (teamId === roster.teamB) return "b";
  return null;
}

export function isShot(entry: RallyEntry | undefined): entry is Shot {
  return entry?.type === "shot";
}

export function isGap(entry: RallyEntry | undefined): entry is ObservationGap {
  return entry?.type === "gap";
}

export function shotsOf(rally: Rally): Shot[] {
  return rally.entries.filter(isShot);
}

/** A Rally's frames are known. Unseen Rallies have neither start nor end. */
export function isFramed(rally: Rally): boolean {
  return rally.start_frame !== null;
}

export function newRally(number: number, startFrame: number | null = null): Rally {
  return {
    number,
    start_frame: startFrame,
    end_frame: null,
    status: "empty",
    score: UNKNOWN,
    serving_team_id: UNKNOWN,
    server_id: UNKNOWN,
    returner_id: UNKNOWN,
    referee_call: UNKNOWN,
    challenge: null,
    winner_id: UNKNOWN,
    winner_source: null,
    scoreboard_winner_id: UNKNOWN,
    entries: [],
  };
}

export function newShot(contactFrame: number): Shot {
  return {
    type: "shot",
    shot_number: UNKNOWN,
    hitter_id: UNKNOWN,
    contact_frame: observed(contactFrame),
    contact_zone: UNKNOWN,
    shot_class: UNKNOWN,
    contact_kind: UNKNOWN,
    // Continuing Shots: no Error, and Erne and ATP seen not to happen until flagged.
    erne: observed(false),
    atp: observed(false),
    landing: UNKNOWN,
    error: null,
    positions: {},
  };
}

export const FRONTCOURT_MAX_Y_FT = 9;
export const MIDCOURT_MAX_Y_FT = 18;
/** Deeper than this from the net, an Established Team stops being Established. */
export const ESTABLISHED_MAX_Y_FT = 12;

/** The Zone of a court point, by distance from the net (inclusive inner bounds). */
export function zoneForPoint(point: CourtPoint): Zone {
  const dist = Math.abs(point.y);
  if (dist <= FRONTCOURT_MAX_Y_FT) return "frontcourt";
  if (dist <= MIDCOURT_MAX_Y_FT) return "midcourt";
  return "backcourt";
}

/** The hitter's Contact Zone from their position at contact, with the position's certainty. */
export function contactZoneFor(shot: Shot): Fact<Zone> {
  const hitter = shot.hitter_id.value;
  const position = hitter === null ? undefined : shot.positions[hitter]?.position;
  if (!position || !known(position)) return UNKNOWN;
  return { value: zoneForPoint(position.value), certainty: position.certainty };
}

/**
 * Shot Numbers: `1, 2, ...` (Observed) up to the first Observation Gap, Unknown after it.
 * Returns the same Rally when nothing changes.
 */
export function numberShots(rally: Rally): Rally {
  let next = 1;
  let afterGap = false;
  let changed = false;
  const entries = rally.entries.map((entry) => {
    if (entry.type === "gap") {
      afterGap = true;
      return entry;
    }
    const number: Fact<number> = afterGap ? UNKNOWN : observed(next++);
    if (sameFact(entry.shot_number, number)) return entry;
    changed = true;
    return { ...entry, shot_number: number };
  });
  return changed ? { ...rally, entries } : rally;
}

export function sameFact<T>(a: Fact<T>, b: Fact<T>): boolean {
  return a.certainty === b.certainty && JSON.stringify(a.value) === JSON.stringify(b.value);
}

/** Entries in frame order: Shots by `contact_frame`, each Observation Gap kept after the Shot it
 * followed (a leading gap stays first). */
export function sortEntries(entries: readonly RallyEntry[]): RallyEntry[] {
  const groups: { shot: Shot | null; gaps: ObservationGap[] }[] = [{ shot: null, gaps: [] }];
  for (const entry of entries) {
    if (entry.type === "gap") groups[groups.length - 1]!.gaps.push(entry);
    else groups.push({ shot: entry, gaps: [] });
  }
  const [lead, ...rest] = groups;
  rest.sort((a, b) => (a.shot!.contact_frame.value ?? 0) - (b.shot!.contact_frame.value ?? 0));
  return [...lead!.gaps, ...rest.flatMap((g) => [g.shot!, ...g.gaps])];
}

/** Renumbers a Game's Rallies 1..N in their order. */
export function renumberRallies(rallies: readonly Rally[]): Rally[] {
  return rallies.map((r, i) => (r.number === i + 1 ? r : { ...r, number: i + 1 }));
}

export function renumberGames(games: readonly Game[]): Game[] {
  return games.map((g, i) => (g.number === i + 1 ? g : { ...g, number: i + 1 }));
}

/** A blank position (both facts Unknown) for every Player who has none yet. */
export function withAllPositions(
  roster: Roster,
  positions: Record<string, ShotPosition>,
): Record<string, ShotPosition> {
  const out: Record<string, ShotPosition> = {};
  for (const p of roster.players) {
    out[p.id] = positions[p.id] ?? { position: UNKNOWN, settled: UNKNOWN };
  }
  return out;
}

export function formatScore(
  score: Fact<{ serving: number; receiving: number; server_number: 1 | 2 }>,
) {
  const s = score.value;
  return s === null ? "—" : `${s.serving}-${s.receiving}-${s.server_number}`;
}

/** Parses `s-r-n` (e.g. `4-2-1`); null if it isn't a valid score called. */
export function parseScore(
  text: string,
): { serving: number; receiving: number; server_number: 1 | 2 } | null {
  const match = /^\s*(\d{1,2})\s*[-–\s]\s*(\d{1,2})\s*[-–\s]\s*([12])\s*$/.exec(text);
  if (!match) return null;
  return {
    serving: Number(match[1]),
    receiving: Number(match[2]),
    server_number: Number(match[3]) as 1 | 2,
  };
}

/**
 * Every Player's position and Settled fact from Player Tracking at a Shot's contact, keeping
 * their certainties; null when Tracking knows nothing there (not run, unmapped, or no frame),
 * so nothing stale is copied in.
 */
export function positionsFromTracking(
  roster: Roster,
  tracking: PlayerTrackingFrameOut | undefined,
): Record<string, ShotPosition> | null {
  if (!tracking) return null;
  const out: Record<string, ShotPosition> = {};
  let anyKnown = false;
  for (const player of roster.players) {
    const tracked = tracking.players.find((p) => p.player_id === player.id);
    const position: Fact<CourtPoint> =
      tracked &&
      tracked.position_certainty !== "unknown" &&
      tracked.position_x !== null &&
      tracked.position_y !== null
        ? {
            value: { x: tracked.position_x, y: tracked.position_y },
            certainty: tracked.position_certainty,
          }
        : UNKNOWN;
    const settled: Fact<boolean> =
      tracked && tracked.settled_certainty !== "unknown" && tracked.settled !== null
        ? { value: tracked.settled, certainty: tracked.settled_certainty }
        : UNKNOWN;
    anyKnown ||= known(position) || known(settled);
    out[player.id] = { position, settled };
  }
  return anyKnown ? out : null;
}
