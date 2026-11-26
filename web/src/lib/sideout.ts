import type { Game, Rally, Score, WinnerSource } from "../api/client";
import {
  type Fact,
  inferred,
  known,
  numberShots,
  observed,
  otherTeam,
  partnerOf,
  type Roster,
  shotsOf,
  teamOf,
  UNKNOWN,
} from "./rallyLog";

/**
 * Side-out doubles (ADR 0002): what each Rally's score, Serving Team, Server and Returner should
 * be given the Rally before it, and who won each Rally. Pre-filled values are Inferred and never
 * overwrite Observed ones.
 *
 * Which Player stands in the right-hand court on an even score (`evenRight`) is learned from the
 * legal serving box, which is tracked across each service turn: right at 0-0-2 and at every side
 * out, flipping on every Point and when the second server takes over. Stacking only moves Players
 * after the serve and return, so this works whether or not a Team stacks.
 */

export type Box = "right" | "left";

export type SideoutOutcome = "point" | "second_server" | "side_out";

/** The exact next score, Serving Team, and legal serving box transition after one Rally. */
export interface SideoutStep {
  outcome: SideoutOutcome;
  score: Score;
  serving_team_id: string;
  box: "flip" | "right";
}

/** The four facts a Rally is pre-filled with. */
export interface Expected {
  score: Fact<Score>;
  serving_team_id: Fact<string>;
  server_id: Fact<string>;
  returner_id: Fact<string>;
}

const NOTHING: Expected = {
  score: UNKNOWN,
  serving_team_id: UNKNOWN,
  server_id: UNKNOWN,
  returner_id: UNKNOWN,
};

/** Rally 1 of any Game: the first Serving Team starts at 0-0-2. */
export const OPENING: Expected = {
  ...NOTHING,
  score: inferred({ serving: 0, receiving: 0, server_number: 2 }),
};

/** Whether a score is the legal Game-opening 0-0-2. */
export function isOpeningScore(score: Score): boolean {
  return score.serving === 0 && score.receiving === 0 && score.server_number === 2;
}

/** Whether two scores have the same serving, receiving, and server numbers. */
export function sameScore(a: Score, b: Score): boolean {
  return (
    a.serving === b.serving && a.receiving === b.receiving && a.server_number === b.server_number
  );
}

interface WalkState {
  /** Per Team, the Player in the right-hand court when the Team's score is even. */
  evenRight: Map<string, string>;
}

export function flipBox(box: Box): Box {
  return box === "right" ? "left" : "right";
}

function inferredOrUnknown(value: string | null): Fact<string> {
  return value === null ? UNKNOWN : inferred(value);
}

/**
 * The Player legally standing in `box` at `teamScore`, given the Player on that Team who stands
 * in the right-hand court on an even score (stacking-safe: depends only on score parity and box).
 */
export function expectedPlayerForBox(
  roster: Roster,
  evenRightPlayer: string,
  teamScore: number,
  box: Box,
): string | null {
  return (box === "right") === (teamScore % 2 === 0)
    ? evenRightPlayer
    : partnerOf(roster, evenRightPlayer);
}

/**
 * Which Player on `playerId`'s Team stands in the right-hand court on an even score, inferred
 * from seeing `playerId` legally stand in `box` at `teamScore`.
 */
export function inferEvenRightPlayer(
  roster: Roster,
  playerId: string,
  teamScore: number,
  box: Box,
): string | null {
  return expectedPlayerForBox(roster, playerId, teamScore, box);
}

/** The single exact next `(score, serving_team_id, box)` under side-out doubles rules. */
export function nextSideoutState(
  roster: Roster,
  score: Score,
  servingTeamId: string,
  winnerId: string,
): SideoutStep {
  if (winnerId === servingTeamId) {
    return {
      outcome: "point",
      score: { ...score, serving: score.serving + 1 },
      serving_team_id: servingTeamId,
      box: "flip",
    };
  }
  if (score.server_number === 1) {
    return {
      outcome: "second_server",
      score: { ...score, server_number: 2 },
      serving_team_id: servingTeamId,
      box: "flip",
    };
  }
  return {
    outcome: "side_out",
    score: { serving: score.receiving, receiving: score.serving, server_number: 1 },
    serving_team_id: otherTeam(roster, servingTeamId),
    box: "right",
  };
}

/** Both legal successors from `(score, servingTeamId)` when the Rally's winner is Unknown. */
export function nextSideoutOutcomes(
  roster: Roster,
  score: Score,
  servingTeamId: string,
): [SideoutStep, SideoutStep] {
  return [
    nextSideoutState(roster, score, servingTeamId, servingTeamId),
    nextSideoutState(roster, score, servingTeamId, otherTeam(roster, servingTeamId)),
  ];
}

/** The Player on `team` legally in the right-hand court at `score`. */
function rightCourtPlayer(
  roster: Roster,
  state: WalkState,
  team: string,
  score: number,
): string | null {
  const even = state.evenRight.get(team);
  if (even === undefined) return null;
  return expectedPlayerForBox(roster, even, score, "right");
}

/** What Rally k + 1 should be, from Rally k, and the legal serving box for it. */
function transition(
  roster: Roster,
  state: WalkState,
  previous: Rally,
): { expected: Expected; box: Box | "flip" | null } {
  const score = previous.score.value;
  const serving = previous.serving_team_id.value;
  const winner = previous.winner_id.value;
  if (score === null || serving === null || winner === null) {
    return { expected: NOTHING, box: null };
  }
  const step = nextSideoutState(roster, score, serving, winner);
  const server = previous.server_id.value;
  const returner = previous.returner_id.value;
  const partner = (id: string | null) => (id === null ? null : partnerOf(roster, id));
  if (step.outcome === "point") {
    return {
      expected: {
        score: inferred(step.score),
        serving_team_id: inferred(step.serving_team_id),
        server_id: inferredOrUnknown(server),
        returner_id: inferredOrUnknown(partner(returner)),
      },
      box: step.box,
    };
  }
  if (step.outcome === "second_server") {
    return {
      expected: {
        score: inferred(step.score),
        serving_team_id: inferred(step.serving_team_id),
        server_id: inferredOrUnknown(partner(server)),
        returner_id: inferredOrUnknown(partner(returner)),
      },
      box: step.box,
    };
  }
  // Side out: the Receiving Team serves from the right-hand court, Server 1.
  return {
    expected: {
      score: inferred(step.score),
      serving_team_id: inferred(step.serving_team_id),
      server_id: inferredOrUnknown(
        rightCourtPlayer(roster, state, step.serving_team_id, step.score.serving),
      ),
      returner_id: inferredOrUnknown(
        rightCourtPlayer(roster, state, serving, step.score.receiving),
      ),
    },
    box: step.box,
  };
}

/** The serving box when the transition doesn't say: from who serves and the even-score Player. */
function boxFromServer(state: WalkState, rally: Rally): Box | null {
  const score = rally.score.value;
  const serving = rally.serving_team_id.value;
  const server = rally.server_id.value;
  if (score === null || serving === null || server === null) return null;
  const even = state.evenRight.get(serving);
  if (even === undefined) return null;
  return (server === even) === (score.serving % 2 === 0) ? "right" : "left";
}

/** Learns who is in the right-hand court on an even score, from a Rally's Server and Returner. */
function learn(roster: Roster, state: WalkState, rally: Rally, box: Box | null): void {
  const score = rally.score.value;
  const serving = rally.serving_team_id.value;
  if (score === null || serving === null || box === null) return;
  const receiving = otherTeam(roster, serving);
  const server = rally.server_id.value;
  const returner = rally.returner_id.value;
  if (server !== null) {
    const even = inferEvenRightPlayer(roster, server, score.serving, box);
    if (even !== null) state.evenRight.set(serving, even);
  }
  if (returner !== null) {
    const even = inferEvenRightPlayer(roster, returner, score.receiving, box);
    if (even !== null) state.evenRight.set(receiving, even);
  }
}

function keep<T>(current: Fact<T>, next: Fact<T>): Fact<T> {
  return current.certainty === "observed" ? current : next;
}

/** Replaces every fact that isn't Observed with the expected one. */
function prefill(rally: Rally, expected: Expected): Rally {
  return {
    ...rally,
    score: keep(rally.score, expected.score),
    serving_team_id: keep(rally.serving_team_id, expected.serving_team_id),
    server_id: keep(rally.server_id, expected.server_id),
    returner_id: keep(rally.returner_id, expected.returner_id),
  };
}

/** Shot 1's Observed hitter is the Server; Shot 2's is the Returner (when not Observed). */
function syncFromShots(roster: Roster, rally: Rally): Rally {
  let next = rally;
  for (const shot of shotsOf(rally)) {
    const number = shot.shot_number.value;
    const hitter = shot.hitter_id;
    if (hitter.certainty !== "observed" || hitter.value === null) continue;
    if (number === 1) {
      const team = teamOf(roster, hitter.value);
      if (next.server_id.certainty !== "observed") {
        next = { ...next, server_id: inferred(hitter.value) };
      }
      if (team !== null && next.serving_team_id.certainty !== "observed") {
        next = { ...next, serving_team_id: inferred(team) };
      }
    } else if (number === 2 && next.returner_id.certainty !== "observed") {
      next = { ...next, returner_id: inferred(hitter.value) };
    }
  }
  return next;
}

/** The winner seen in play: the Team opposite the Player whose Error ended the Rally. */
function playWinnerFromError(roster: Roster, rally: Rally): string | null {
  const last = shotsOf(rally).at(-1);
  const player = last?.error?.player_id.value;
  if (!player) return null;
  const team = teamOf(roster, player);
  return team === null ? null : otherTeam(roster, team);
}

export function refereeCallWinner(roster: Roster, rally: Rally): string | null {
  if (!known(rally.referee_call) || !known(rally.serving_team_id)) return null;
  const serving = rally.serving_team_id.value;
  if (serving !== roster.teamA && serving !== roster.teamB) return null;
  return rally.referee_call.value === "point" ? serving : otherTeam(roster, serving);
}

/** The winner implied by who serves the next Rally (only its Observed facts, to avoid circles). */
function nextServeWinner(roster: Roster, rally: Rally, next: Rally | undefined): string | null {
  const serving = rally.serving_team_id.value;
  if (!next || serving === null || next.serving_team_id.certainty !== "observed") return null;
  const receiving = otherTeam(roster, serving);
  if (next.serving_team_id.value !== serving) return receiving;
  const score = rally.score.value;
  const nextScore = next.score.certainty === "observed" ? next.score.value : null;
  if (score !== null && nextScore !== null) {
    if (nextScore.server_number === 2 && score.server_number === 1) return receiving;
    if (nextScore.serving > score.serving) return serving;
  }
  const server = rally.server_id.value;
  const nextServer = next.server_id.certainty === "observed" ? next.server_id.value : null;
  if (server !== null && nextServer !== null) {
    return nextServer === server ? serving : receiving;
  }
  return null;
}

/**
 * A winner the operator entered by hand as seen in play (Rally details): Observed, from `play`.
 * A winner worked out from an Error is stored Inferred instead, so it is recomputed every time and
 * goes away with its Error.
 */
export function manualWinner(rally: Rally): string | null {
  return rally.winner_source === "play" && rally.winner_id.certainty === "observed"
    ? rally.winner_id.value
    : null;
}

/**
 * Who won a Rally and how we know, highest priority first: Challenge, Referee Call, scoreboard,
 * next Serve, then play (a winner the operator set by hand, else one inferred from an Error).
 */
export function resolveWinner(
  roster: Roster,
  rally: Rally,
  next: Rally | undefined,
): { winner_id: Fact<string>; winner_source: WinnerSource | null } {
  const fromError = playWinnerFromError(roster, rally);
  const manual = manualWinner(rally);
  const fromCall = refereeCallWinner(roster, rally);
  const ruling = rally.challenge?.ruling.value ?? null;
  if (ruling !== null) {
    const base = fromCall ?? manual ?? fromError;
    if (base !== null) {
      return {
        winner_id: observed(ruling === "upheld" ? base : otherTeam(roster, base)),
        winner_source: "challenge",
      };
    }
  }
  if (fromCall !== null) return { winner_id: inferred(fromCall), winner_source: "referee_call" };
  if (known(rally.scoreboard_winner_id)) {
    return { winner_id: inferred(rally.scoreboard_winner_id.value), winner_source: "scoreboard" };
  }
  const fromNext = nextServeWinner(roster, rally, next);
  if (fromNext !== null) return { winner_id: inferred(fromNext), winner_source: "next_serve" };
  // Within play, a winner the operator entered outranks one worked out from an Error.
  if (manual !== null) return { winner_id: observed(manual), winner_source: "play" };
  if (fromError !== null) return { winner_id: inferred(fromError), winner_source: "play" };
  return { winner_id: UNKNOWN, winner_source: null };
}

/**
 * Brings a Game up to date after an edit: numbers Shots, syncs Server and Returner from Shots 1
 * and 2, resolves every winner, and pre-fills the Rallies after `fromIndex` (forward cascade) for
 * every fact not Observed. Pass -1 to pre-fill all of them.
 */
export function normalizeGame(game: Game, roster: Roster, fromIndex: number): Game {
  const rallies = game.rallies.map(numberShots);
  const state: WalkState = { evenRight: new Map() };
  let box: Box | null = null;
  for (let i = 0; i < rallies.length; i++) {
    let rally = rallies[i]!;
    let expected = OPENING;
    let nextBox: Box | null = "right";
    if (i > 0) {
      const step = transition(roster, state, rallies[i - 1]!);
      expected = step.expected;
      nextBox = step.box === "flip" ? (box === null ? null : flipBox(box)) : step.box;
    }
    if (i > fromIndex) rally = prefill(rally, expected);
    rally = syncFromShots(roster, rally);
    box = nextBox ?? boxFromServer(state, rally);
    learn(roster, state, rally, box);
    rally = { ...rally, ...resolveWinner(roster, rally, rallies[i + 1]) };
    rallies[i] = rally;
  }
  return { ...game, rallies };
}
