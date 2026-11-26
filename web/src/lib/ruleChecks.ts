import type { Game, Rally, Score, Shot } from "../api/client";
import {
  RALLY_FIELDS,
  REFEREE_CALL_LABELS,
  type RallyField,
  type Selection,
  SHOT_FIELDS,
  type ShotField,
} from "./annotate";
import {
  isGap,
  isShot,
  known,
  otherTeam,
  partnerOf,
  playerName,
  type Roster,
  teamOf,
  teamPlayers,
} from "./rallyLog";
import {
  type Box,
  expectedPlayerForBox,
  flipBox,
  inferEvenRightPlayer,
  isOpeningScore,
  nextSideoutOutcomes,
  nextSideoutState,
  refereeCallWinner,
  type SideoutOutcome,
  sameScore,
} from "./sideout";

/**
 * Live, non-blocking rule checks during annotation (#13; ADR 0003). Purely computed from the
 * Match's Games and Roster — never persisted, never dismissible, and never blocking saves,
 * Mark Done, or navigation.
 */

/** Distance from the net to the non-volley zone (kitchen) line, in feet. */
export const KITCHEN_LINE_Y_FT = 7.0;
/** Distance from the centreline to each sideline, in feet. */
export const KITCHEN_SIDELINE_X_FT = 10.0;
/** Tolerance band inside the kitchen line, aligned with calibration.py's ERROR_WARNING_FT. */
export const KITCHEN_TOLERANCE_FT = 0.5;
/** Closer to the net than this inside the sidelines is a definite kitchen volley (Red). */
export const KITCHEN_STRICT_Y_FT = KITCHEN_LINE_Y_FT - KITCHEN_TOLERANCE_FT;

export type RuleSeverity = "red" | "amber";

export type RuleIssueCode =
  | "team_alternation"
  | "serve_hitter_mismatch"
  | "return_hitter_mismatch"
  | "two_bounce_rule"
  | "kitchen_volley"
  | "kitchen_line_volley"
  | "non_final_error"
  | "error_winner_mismatch"
  | "negative_score"
  | "server_wrong_team"
  | "returner_wrong_team"
  | "referee_call_server_number_mismatch"
  | "official_scoreboard_mismatch"
  | "winner_official_mismatch"
  | "winner_scoreboard_mismatch"
  | "game_opening_score"
  | "score_sequence"
  | "serving_team_sequence"
  | "server_turn_sequence"
  | "returner_turn_sequence"
  | "server_parity"
  | "returner_parity"
  | "score_backwards"
  | "score_jump";

export type ShotIssueField = Extract<ShotField, "hitter_id" | "contact_kind" | "error">;
export type RallyIssueField = Extract<
  RallyField,
  "score" | "serving_team_id" | "server_id" | "returner_id" | "referee_call" | "winner_id"
>;
export type RuleIssueField = ShotIssueField | RallyIssueField;

export interface RuleIssue {
  /** Deterministic key built from `(gameNumber, rallyNumber, entryIndex, code, field)`. */
  id: string;
  code: RuleIssueCode;
  severity: RuleSeverity;
  gameIndex: number;
  rallyIndex: number;
  gameNumber: number;
  rallyNumber: number;
  /** Index into `rally.entries` for Shot-level issues, or `null` for Rally-level issues. */
  entryIndex: number | null;
  /** `shot.contact_frame.value` for Shot-level issues, or `null`. */
  shotFrame: number | null;
  /** Target Inspector row key on the Shot or Rally tab. */
  field: RuleIssueField;
  /** Concise human-readable explanation using GLOSSARY.md vocabulary and Player/Team names. */
  message: string;
}

export interface IssueCounts {
  red: number;
  amber: number;
}

export interface TimelineShotMarker {
  key: string;
  gameIndex: number;
  rallyIndex: number;
  entryIndex: number;
  gameNumber: number;
  rallyNumber: number;
  shotFrame: number;
  severity: RuleSeverity;
  primaryIssue: RuleIssue;
  issues: RuleIssue[];
  tooltip: string;
}

export interface TimelineRallyMarker {
  key: string;
  gameIndex: number;
  rallyIndex: number;
  gameNumber: number;
  rallyNumber: number;
  startFrame: number;
  endFrame: number;
  severity: RuleSeverity;
  primaryIssue: RuleIssue;
  issues: RuleIssue[];
  tooltip: string;
}

const OUTCOME_LABELS: Record<SideoutOutcome, string> = {
  point: "Point",
  second_server: "Second server",
  side_out: "Side out",
};

function isRosterTeam(roster: Roster, teamId: string): boolean {
  return teamId === roster.teamA || teamId === roster.teamB;
}

function knownTeam(
  roster: Roster,
  fact: { value: string | null; certainty: string },
): string | null {
  if (fact.value === null || fact.certainty === "unknown") return null;
  return isRosterTeam(roster, fact.value) ? fact.value : null;
}

function validScore(rally: Rally): Score | null {
  if (!known(rally.score)) return null;
  const score = rally.score.value;
  return score.serving >= 0 && score.receiving >= 0 ? score : null;
}

function formatScoreValue(score: Score): string {
  return `${score.serving}-${score.receiving}-${score.server_number}`;
}

function teamName(roster: Roster, teamId: string): string {
  const names = teamPlayers(roster, teamId)
    .map((p) => p.name.trim().split(/\s+/).at(-1) ?? p.name)
    .filter((n) => n.length > 0);
  if (names.length > 0) return names.join(" / ");
  return teamId === roster.teamA ? "Team A" : "Team B";
}

function shotLabel(shot: Shot): string {
  return known(shot.shot_number) ? String(shot.shot_number.value) : "?";
}

function isOverturnedChallenge(rally: Rally): boolean {
  return (
    rally.challenge !== null &&
    known(rally.challenge.ruling) &&
    rally.challenge.ruling.value === "overturned"
  );
}

function lastEntryErrorWinner(roster: Roster, rally: Rally): string | null {
  const last = rally.entries.at(-1);
  if (!isShot(last) || last.error === null || !known(last.error.player_id)) return null;
  const team = teamOf(roster, last.error.player_id.value);
  return team === null ? null : otherTeam(roster, team);
}

function makeIssue(
  gameIndex: number,
  rallyIndex: number,
  gameNumber: number,
  rallyNumber: number,
  entryIndex: number | null,
  shotFrame: number | null,
  code: RuleIssueCode,
  severity: RuleSeverity,
  field: RuleIssueField,
  message: string,
): RuleIssue {
  return {
    id: `${gameNumber}:${rallyNumber}:${entryIndex ?? "rally"}:${code}:${field}`,
    code,
    severity,
    gameIndex,
    rallyIndex,
    gameNumber,
    rallyNumber,
    entryIndex,
    shotFrame,
    field,
    message,
  };
}

function fieldRank(issue: RuleIssue): number {
  return issue.entryIndex === null
    ? RALLY_FIELDS.indexOf(issue.field as RallyField)
    : SHOT_FIELDS.indexOf(issue.field as ShotField);
}

function compareIssues(a: RuleIssue, b: RuleIssue): number {
  if (a.gameNumber !== b.gameNumber) return a.gameNumber - b.gameNumber;
  if (a.rallyNumber !== b.rallyNumber) return a.rallyNumber - b.rallyNumber;
  const aEntry = a.entryIndex ?? -1;
  const bEntry = b.entryIndex ?? -1;
  if (aEntry !== bEntry) return aEntry - bEntry;
  const aRank = fieldRank(a);
  const bRank = fieldRank(b);
  if (aRank !== bRank) return aRank - bRank;
  if (a.severity !== b.severity) return a.severity === "red" ? -1 : 1;
  return 0;
}

/** Runs Shot-level checks 1–7 on one Rally. */
function checkShots(
  roster: Roster,
  gameIndex: number,
  rallyIndex: number,
  gameNumber: number,
  rally: Rally,
  out: RuleIssue[],
): void {
  const servingTeam = knownTeam(roster, rally.serving_team_id);
  const overturned = isOverturnedChallenge(rally);
  const rallyWinner = knownTeam(roster, rally.winner_id);
  const rallyServer = known(rally.server_id) ? rally.server_id.value : null;
  const rallyReturner = known(rally.returner_id) ? rally.returner_id.value : null;

  let expectedTeam: string | null = servingTeam;
  let seenAnyShot = false;
  let seenKnownHitterShot = false;
  let hasLeadingGap = false;
  let hasMidGap = false;
  let oddGapsSinceAnchor = 0;
  let unknownShotsSinceAnchor = 0;

  for (let ei = 0; ei < rally.entries.length; ei++) {
    const entry = rally.entries[ei]!;
    if (isGap(entry)) {
      if (!seenAnyShot) hasLeadingGap = true;
      else hasMidGap = true;
      if (entry.missing === "odd") {
        oddGapsSinceAnchor += 1;
        if (expectedTeam !== null) expectedTeam = otherTeam(roster, expectedTeam);
      }
      continue;
    }

    const shot = entry;
    const contactFrame = known(shot.contact_frame) ? shot.contact_frame.value : null;
    const emit = (
      code: RuleIssueCode,
      severity: RuleSeverity,
      field: ShotIssueField,
      message: string,
    ) =>
      out.push(
        makeIssue(
          gameIndex,
          rallyIndex,
          gameNumber,
          rally.number,
          ei,
          contactFrame,
          code,
          severity,
          field,
          message,
        ),
      );

    // Check 1: Team alternation & leading/mid-Rally Observation Gap (Red).
    let flaggedAlternation = false;
    const hitterId = known(shot.hitter_id) ? shot.hitter_id.value : null;
    const hitterTeam = hitterId === null ? null : teamOf(roster, hitterId);
    if (hitterTeam !== null) {
      if (expectedTeam !== null && hitterTeam !== expectedTeam) {
        flaggedAlternation = true;
        const parity = oddGapsSinceAnchor % 2 === 1 ? "odd" : "even";
        let message: string;
        if (!seenAnyShot && !hasLeadingGap && !seenKnownHitterShot) {
          message = `Serve is hit by ${teamName(roster, hitterTeam)}, but ${teamName(roster, expectedTeam)} is the Serving Team.`;
        } else if (hasLeadingGap && !seenKnownHitterShot && unknownShotsSinceAnchor === 0) {
          message = `After a leading ${parity} Observation Gap, expected ${teamName(roster, expectedTeam)} to hit, not ${teamName(roster, hitterTeam)}.`;
        } else if (hasMidGap && unknownShotsSinceAnchor === 0) {
          message = `After an ${parity} Observation Gap, expected ${teamName(roster, expectedTeam)} to hit, not ${teamName(roster, hitterTeam)}.`;
        } else if (unknownShotsSinceAnchor > 0) {
          message = `Teams must alternate: expected ${teamName(roster, expectedTeam)} to hit Shot ${shotLabel(shot)}, not ${teamName(roster, hitterTeam)}.`;
        } else {
          message = `Teams must alternate: Shot ${shotLabel(shot)} is hit by the same Team as the previous Shot.`;
        }
        emit("team_alternation", "red", "hitter_id", message);
      }
      // Re-anchor forward from this Shot's actual hitter so one mistake does not cascade.
      expectedTeam = otherTeam(roster, hitterTeam);
      seenKnownHitterShot = true;
      hasLeadingGap = false;
      hasMidGap = false;
      oddGapsSinceAnchor = 0;
      unknownShotsSinceAnchor = 0;
    } else {
      // Unknown hitter counts as one team flip.
      unknownShotsSinceAnchor += 1;
      if (expectedTeam !== null) expectedTeam = otherTeam(roster, expectedTeam);
    }
    seenAnyShot = true;

    const shotNum = known(shot.shot_number) ? shot.shot_number.value : null;

    // Check 2: Serve hitter != Rally.server_id (Amber; suppressed if Check 1 fired).
    if (
      !flaggedAlternation &&
      shotNum === 1 &&
      hitterId !== null &&
      rallyServer !== null &&
      hitterId !== rallyServer
    ) {
      emit(
        "serve_hitter_mismatch",
        "amber",
        "hitter_id",
        `The Serve is hit by ${playerName(roster, hitterId)}, but the Server is ${playerName(roster, rallyServer)}.`,
      );
    }

    // Check 3: Return hitter != Rally.returner_id (Amber; suppressed if Check 1 fired).
    if (
      !flaggedAlternation &&
      shotNum === 2 &&
      hitterId !== null &&
      rallyReturner !== null &&
      hitterId !== rallyReturner
    ) {
      emit(
        "return_hitter_mismatch",
        "amber",
        "hitter_id",
        `The Return is hit by ${playerName(roster, hitterId)}, but the Returner is ${playerName(roster, rallyReturner)}.`,
      );
    }

    const isVolley = known(shot.contact_kind) && shot.contact_kind.value === "volley";

    // Check 4: Two-bounce rule — Shots 2 and 3 must be Bounces (Red).
    if (isVolley && (shotNum === 2 || shotNum === 3)) {
      emit(
        "two_bounce_rule",
        "red",
        "contact_kind",
        `Shot ${shotNum} must be a Bounce (two-bounce rule).`,
      );
    }

    // Check 5: No Volley from inside the kitchen (Red < 6.5 ft, Amber 6.5..7.0 ft).
    if (isVolley && hitterId !== null) {
      const position = shot.positions[hitterId]?.position;
      const isErne = known(shot.erne) && shot.erne.value === true;
      const isHitterKitchenFault =
        shot.error !== null &&
        known(shot.error.kind) &&
        shot.error.kind.value === "kitchen_fault" &&
        (!known(shot.error.player_id) || shot.error.player_id.value === hitterId);
      if (position && known(position) && !isErne && !isHitterKitchenFault) {
        const { x, y } = position.value;
        const dist = Math.abs(y);
        if (Math.abs(x) <= KITCHEN_SIDELINE_X_FT) {
          if (dist < KITCHEN_STRICT_Y_FT) {
            emit(
              "kitchen_volley",
              "red",
              "contact_kind",
              `Volley from inside the kitchen (${dist.toFixed(1)} ft from net).`,
            );
          } else if (dist <= KITCHEN_LINE_Y_FT) {
            emit(
              "kitchen_line_volley",
              "amber",
              "contact_kind",
              `Volley at the kitchen line (${dist.toFixed(1)} ft from net) — check Contact Kind or foot position.`,
            );
          }
        }
      }
    }

    // Check 6: Error on a non-final Shot (Red).
    const isLastEntry = ei === rally.entries.length - 1;
    if (shot.error !== null && !isLastEntry) {
      emit(
        "non_final_error",
        "red",
        "error",
        `Error recorded on Shot ${shotLabel(shot)}, but the Rally continues after it.`,
      );
    }

    // Check 7: Last-Shot Error disagrees with Rally.winner_id (Amber).
    if (
      isLastEntry &&
      shot.error !== null &&
      known(shot.error.player_id) &&
      rallyWinner !== null &&
      !overturned
    ) {
      const errorPlayerTeam = teamOf(roster, shot.error.player_id.value);
      if (errorPlayerTeam !== null) {
        const errorWinner = otherTeam(roster, errorPlayerTeam);
        if (errorWinner !== rallyWinner) {
          emit(
            "error_winner_mismatch",
            "amber",
            "error",
            `Error by ${playerName(roster, shot.error.player_id.value)} implies ${teamName(roster, errorWinner)} won, but Rally winner is ${teamName(roster, rallyWinner)}.`,
          );
        }
      }
    }
  }
}

/**
 * Computes the legal serving box (`"right"` / `"left"` / `null`) for `rallies[i]`, following
 * #12's exact box-tracking rules (right at Game opening 0-0-2 and at every side-out, flipping
 * on Points and Second servers, null when it cannot be established until the next side-out).
 */
function nextLegalBox(
  roster: Roster,
  rallies: readonly Rally[],
  i: number,
  prevBox: Box | null,
): Box | null {
  const rally = rallies[i]!;
  const currScore = validScore(rally);
  const currServing = knownTeam(roster, rally.serving_team_id);

  if (i === 0) {
    if (currScore === null || isOpeningScore(currScore)) return "right";
    return null;
  }

  const prev = rallies[i - 1]!;
  const prevScore = validScore(prev);
  const prevServing = knownTeam(roster, prev.serving_team_id);
  const prevWinner = knownTeam(roster, prev.winner_id);

  if (prevScore !== null && prevServing !== null) {
    const outcomes = nextSideoutOutcomes(roster, prevScore, prevServing);
    if (currScore !== null && currServing !== null) {
      const matched = outcomes.find(
        (step) => sameScore(currScore, step.score) && currServing === step.serving_team_id,
      );
      if (matched) {
        return matched.box === "right" ? "right" : prevBox === null ? null : flipBox(prevBox);
      }
      return null;
    }
    if (prevWinner !== null) {
      const step = nextSideoutState(roster, prevScore, prevServing, prevWinner);
      if (currServing !== null && currServing !== step.serving_team_id) return null;
      return step.box === "right" ? "right" : prevBox === null ? null : flipBox(prevBox);
    }
    if (currServing !== null && currServing !== prevServing && prevScore.server_number === 2) {
      return "right";
    }
    return null;
  }

  // Previous score or serving team was Unknown: an adjacent team switch starting Server 1 is a side-out.
  if (
    prevServing !== null &&
    currServing !== null &&
    currServing !== prevServing &&
    (currScore === null || currScore.server_number === 1)
  ) {
    return "right";
  }
  return null;
}

/** Converts `(serving, receiving)` score to `[teamA, teamB]` score. */
function teamScores(roster: Roster, score: Score, servingTeamId: string): [number, number] {
  return servingTeamId === roster.teamA
    ? [score.serving, score.receiving]
    : [score.receiving, score.serving];
}

type RallyEmitter = (
  code: RuleIssueCode,
  severity: RuleSeverity,
  field: RallyIssueField,
  message: string,
) => void;

/** Check 8: intra-rally roster & score impossibilities (Red). */
function checkIntraRallyImpossibilities(
  roster: Roster,
  rally: Rally,
  servingTeam: string | null,
  emit: RallyEmitter,
): { serverFlagged: boolean; returnerFlagged: boolean } {
  const rawScore = known(rally.score) ? rally.score.value : null;
  if (rawScore !== null && (rawScore.serving < 0 || rawScore.receiving < 0)) {
    emit("negative_score", "red", "score", "Score cannot be negative.");
  }

  let serverFlagged = false;
  const serverId = known(rally.server_id) ? rally.server_id.value : null;
  if (serverId !== null && servingTeam !== null && teamOf(roster, serverId) !== servingTeam) {
    serverFlagged = true;
    emit(
      "server_wrong_team",
      "red",
      "server_id",
      `${playerName(roster, serverId)} is not on the Serving Team (${teamName(roster, servingTeam)}).`,
    );
  }

  let returnerFlagged = false;
  const returnerId = known(rally.returner_id) ? rally.returner_id.value : null;
  if (returnerId !== null && servingTeam !== null && teamOf(roster, returnerId) === servingTeam) {
    returnerFlagged = true;
    const receiving = otherTeam(roster, servingTeam);
    emit(
      "returner_wrong_team",
      "red",
      "returner_id",
      `${playerName(roster, returnerId)} is on the Serving Team, not the Receiving Team (${teamName(roster, receiving)}).`,
    );
  }

  return { serverFlagged, returnerFlagged };
}

/** Check 9: Referee Call vs score.server_number mismatch (Amber). */
function checkRefereeCallServerNumber(rally: Rally, emit: RallyEmitter): void {
  if (!known(rally.referee_call) || !known(rally.score)) return;
  const call = rally.referee_call.value;
  const serverNum = rally.score.value.server_number;
  if (call === "side_out" && serverNum === 1) {
    emit(
      "referee_call_server_number_mismatch",
      "amber",
      "referee_call",
      "Referee Call is Side out, but score has Server 1 (expected Second server).",
    );
  } else if (call === "second_server" && serverNum === 2) {
    emit(
      "referee_call_server_number_mismatch",
      "amber",
      "referee_call",
      "Referee Call is Second server, but score has Server 2 (expected Side out).",
    );
  }
}

/** Check 10: post-Challenge official call, scoreboard reading, and winner_id agreement (Amber). */
function checkWinnerAgreement(roster: Roster, rally: Rally, emit: RallyEmitter): void {
  const overturned = isOverturnedChallenge(rally);
  const rawCallWinner = refereeCallWinner(roster, rally);
  const lastErrorWinner = lastEntryErrorWinner(roster, rally);
  const officialWinner = overturned
    ? rawCallWinner !== null
      ? otherTeam(roster, rawCallWinner)
      : lastErrorWinner !== null
        ? otherTeam(roster, lastErrorWinner)
        : null
    : rawCallWinner;
  const sbWinner = knownTeam(roster, rally.scoreboard_winner_id);
  const winner = knownTeam(roster, rally.winner_id);

  let flaggedOfficialVsScoreboard = false;
  if (officialWinner !== null && sbWinner !== null && officialWinner !== sbWinner) {
    flaggedOfficialVsScoreboard = true;
    if (overturned) {
      emit(
        "official_scoreboard_mismatch",
        "amber",
        "winner_id",
        `Overturned Challenge gives the Rally to ${teamName(roster, officialWinner)}, but the scoreboard says ${teamName(roster, sbWinner)}.`,
      );
    } else {
      const callLabel = REFEREE_CALL_LABELS[rally.referee_call.value!];
      emit(
        "official_scoreboard_mismatch",
        "amber",
        "winner_id",
        `Referee Call (${callLabel}) says ${teamName(roster, officialWinner)} won, but the scoreboard says ${teamName(roster, sbWinner)}.`,
      );
    }
  }

  if (winner !== null && officialWinner !== null && winner !== officialWinner) {
    const source = overturned ? "Challenge" : "Referee Call";
    emit(
      "winner_official_mismatch",
      "amber",
      "winner_id",
      `Rally winner is ${teamName(roster, winner)}, but ${source} says ${teamName(roster, officialWinner)} won.`,
    );
  } else if (
    !flaggedOfficialVsScoreboard &&
    winner !== null &&
    sbWinner !== null &&
    winner !== sbWinner
  ) {
    emit(
      "winner_scoreboard_mismatch",
      "amber",
      "winner_id",
      `Rally winner is ${teamName(roster, winner)}, but the scoreboard says ${teamName(roster, sbWinner)}.`,
    );
  }
}

/** Infers the expected side-out outcome after `prev` when at least one adjacent score is Unknown. */
function outcomeWithoutBothScores(
  prevServing: string,
  prevWinner: string | null,
  prevServerNum: 1 | 2 | null,
  prevCall: "point" | "second_server" | "side_out" | null,
): SideoutOutcome | null {
  if (prevWinner === prevServing) return "point";
  if (prevWinner !== null) {
    if (prevServerNum === 1) return "second_server";
    if (prevServerNum === 2) return "side_out";
    return prevCall === "second_server" || prevCall === "side_out" ? prevCall : null;
  }
  return prevCall;
}

/** Infers whether an adjacent same-Serving-Team transition was a Point or Second server. */
function sameTurnStep(
  prevServing: string,
  prevWinner: string | null,
  prevScore: Score | null,
  score: Score | null,
  prevCall: "point" | "second_server" | "side_out" | null,
): "point" | "second_server" | null {
  if (prevWinner === prevServing) return "point";
  if (prevWinner !== null) {
    const prevServerNum = prevScore?.server_number ?? null;
    if (prevServerNum === 1 || (prevServerNum === null && prevCall === "second_server")) {
      return "second_server";
    }
    return null;
  }
  if (prevScore !== null && score !== null) {
    if (
      score.serving === prevScore.serving + 1 &&
      score.receiving === prevScore.receiving &&
      score.server_number === prevScore.server_number
    ) {
      return "point";
    }
    if (
      score.serving === prevScore.serving &&
      score.receiving === prevScore.receiving &&
      prevScore.server_number === 1 &&
      score.server_number === 2
    ) {
      return "second_server";
    }
    return null;
  }
  return prevCall === "point" || prevCall === "second_server" ? prevCall : null;
}

/** Checks 11b, 11c, and 11d: adjacent Rally k -> k+1 score, Serving Team, Server, and Returner. */
function checkAdjacentTransition(
  roster: Roster,
  prev: Rally,
  rally: Rally,
  score: Score | null,
  servingTeam: string | null,
  flags: { serverFlagged: boolean; returnerFlagged: boolean },
  emit: RallyEmitter,
): void {
  const prevScore = validScore(prev);
  const prevServing = knownTeam(roster, prev.serving_team_id);
  const prevWinner = knownTeam(roster, prev.winner_id);
  const prevCall =
    !isOverturnedChallenge(prev) && known(prev.referee_call) ? prev.referee_call.value : null;

  if (prevServing === null || servingTeam === null) return;

  // 11b: Score & Serving Team transition when both scores and Serving Teams are known.
  if (prevScore !== null && score !== null) {
    if (prevWinner !== null) {
      const step = nextSideoutState(roster, prevScore, prevServing, prevWinner);
      if (!sameScore(score, step.score) || servingTeam !== step.serving_team_id) {
        const field: RallyIssueField = sameScore(score, step.score) ? "serving_team_id" : "score";
        emit(
          "score_sequence",
          "amber",
          field,
          `After Rally ${prev.number} (${formatScoreValue(prevScore)}, ${OUTCOME_LABELS[step.outcome]}), expected ${formatScoreValue(step.score)} (${teamName(roster, step.serving_team_id)}), got ${formatScoreValue(score)} (${teamName(roster, servingTeam)}).`,
        );
      }
    } else {
      const [pointStep, lossStep] = nextSideoutOutcomes(roster, prevScore, prevServing);
      const matchesPoint =
        sameScore(score, pointStep.score) && servingTeam === pointStep.serving_team_id;
      const matchesLoss =
        sameScore(score, lossStep.score) && servingTeam === lossStep.serving_team_id;
      if (!matchesPoint && !matchesLoss) {
        const scoreMatchesOne =
          sameScore(score, pointStep.score) || sameScore(score, lossStep.score);
        const field: RallyIssueField = scoreMatchesOne ? "serving_team_id" : "score";
        const message = scoreMatchesOne
          ? `After Rally ${prev.number} (${formatScoreValue(prevScore)}), expected ${formatScoreValue(pointStep.score)} (${teamName(roster, pointStep.serving_team_id)}) or ${formatScoreValue(lossStep.score)} (${teamName(roster, lossStep.serving_team_id)}), got ${formatScoreValue(score)} (${teamName(roster, servingTeam)}).`
          : `After Rally ${prev.number} (${formatScoreValue(prevScore)}), expected ${formatScoreValue(pointStep.score)} or ${formatScoreValue(lossStep.score)}, got ${formatScoreValue(score)}.`;
        emit("score_sequence", "amber", field, message);
      }
    }
  } else {
    // 11c: Serving Team continuity when either score is Unknown.
    const expectedOutcome = outcomeWithoutBothScores(
      prevServing,
      prevWinner,
      prevScore?.server_number ?? null,
      prevCall,
    );
    if (expectedOutcome !== null) {
      const expectedServing =
        expectedOutcome === "side_out" ? otherTeam(roster, prevServing) : prevServing;
      if (servingTeam !== expectedServing) {
        emit(
          "serving_team_sequence",
          "amber",
          "serving_team_id",
          `After Rally ${prev.number} (${OUTCOME_LABELS[expectedOutcome]}), expected ${teamName(roster, expectedServing)} to serve, not ${teamName(roster, servingTeam)}.`,
        );
      }
    }
  }

  // 11d: Server & Returner continuity within a service turn.
  if (servingTeam !== prevServing) return;
  const turnStep = sameTurnStep(prevServing, prevWinner, prevScore, score, prevCall);
  if (turnStep === null) return;

  const serverId = known(rally.server_id) ? rally.server_id.value : null;
  const prevServer = known(prev.server_id) ? prev.server_id.value : null;
  if (
    !flags.serverFlagged &&
    prevServer !== null &&
    teamOf(roster, prevServer) === prevServing &&
    serverId !== null
  ) {
    const expectedServer = turnStep === "point" ? prevServer : partnerOf(roster, prevServer);
    if (expectedServer !== null && serverId !== expectedServer) {
      flags.serverFlagged = true;
      emit(
        "server_turn_sequence",
        "amber",
        "server_id",
        turnStep === "point"
          ? `After a Point in Rally ${prev.number}, Server should stay ${playerName(roster, expectedServer)}, not ${playerName(roster, serverId)}.`
          : `After Second server in Rally ${prev.number}, Server should switch to ${playerName(roster, expectedServer)}, not ${playerName(roster, serverId)}.`,
      );
    }
  }

  const receiving = otherTeam(roster, prevServing);
  const returnerId = known(rally.returner_id) ? rally.returner_id.value : null;
  const prevReturner = known(prev.returner_id) ? prev.returner_id.value : null;
  if (
    !flags.returnerFlagged &&
    prevReturner !== null &&
    teamOf(roster, prevReturner) === receiving &&
    returnerId !== null
  ) {
    const expectedReturner = partnerOf(roster, prevReturner);
    if (expectedReturner !== null && returnerId !== expectedReturner) {
      flags.returnerFlagged = true;
      const reason = turnStep === "point" ? "a Point" : "Second server";
      emit(
        "returner_turn_sequence",
        "amber",
        "returner_id",
        `After ${reason} in Rally ${prev.number}, Returner should switch to ${playerName(roster, expectedReturner)}, not ${playerName(roster, returnerId)}.`,
      );
    }
  }
}

/** Check 11e: stacking-safe even_right[Team] parity for Server and Returner. */
function checkServingBoxParity(
  roster: Roster,
  rally: Rally,
  score: Score,
  servingTeam: string,
  legalServingBox: Box,
  evenRight: Map<string, string>,
  flags: { serverFlagged: boolean; returnerFlagged: boolean },
  emit: RallyEmitter,
): void {
  const receiving = otherTeam(roster, servingTeam);
  const serverId = known(rally.server_id) ? rally.server_id.value : null;
  const returnerId = known(rally.returner_id) ? rally.returner_id.value : null;

  if (serverId !== null && teamOf(roster, serverId) === servingTeam) {
    const evenS = evenRight.get(servingTeam);
    if (evenS !== undefined) {
      const expectedServer = expectedPlayerForBox(roster, evenS, score.serving, legalServingBox);
      if (expectedServer !== null && serverId !== expectedServer && !flags.serverFlagged) {
        emit(
          "server_parity",
          "amber",
          "server_id",
          `Expected ${playerName(roster, expectedServer)} to serve from the ${legalServingBox} box at score ${score.serving}, not ${playerName(roster, serverId)}.`,
        );
      }
    } else {
      const learned = inferEvenRightPlayer(roster, serverId, score.serving, legalServingBox);
      if (learned !== null) evenRight.set(servingTeam, learned);
    }
  }

  if (returnerId !== null && teamOf(roster, returnerId) === receiving) {
    const evenR = evenRight.get(receiving);
    if (evenR !== undefined) {
      const expectedReturner = expectedPlayerForBox(
        roster,
        evenR,
        score.receiving,
        legalServingBox,
      );
      if (expectedReturner !== null && returnerId !== expectedReturner && !flags.returnerFlagged) {
        emit(
          "returner_parity",
          "amber",
          "returner_id",
          `Expected ${playerName(roster, expectedReturner)} to return in the ${legalServingBox} box at score ${score.receiving}, not ${playerName(roster, returnerId)}.`,
        );
      }
    } else {
      const learned = inferEvenRightPlayer(roster, returnerId, score.receiving, legalServingBox);
      if (learned !== null) evenRight.set(receiving, learned);
    }
  }
}

/** Check 11f: cross-gap score monotonicity across intermediate Unknown-score Rallies. */
function checkCrossGapMonotonicity(
  roster: Roster,
  prevKnown: Rally,
  spanCount: number,
  score: Score,
  servingTeam: string,
  emit: RallyEmitter,
): void {
  const prevKnownScore = validScore(prevKnown)!;
  const prevKnownServing = knownTeam(roster, prevKnown.serving_team_id)!;
  const [prevA, prevB] = teamScores(roster, prevKnownScore, prevKnownServing);
  const [currA, currB] = teamScores(roster, score, servingTeam);
  if (currA < prevA || currB < prevB) {
    emit(
      "score_backwards",
      "amber",
      "score",
      `Score went backwards from Rally ${prevKnown.number} (${prevA}-${prevB} → ${currA}-${currB}).`,
    );
    return;
  }
  const delta = currA - prevA + (currB - prevB);
  if (delta > spanCount) {
    emit(
      "score_jump",
      "amber",
      "score",
      `Score jumped by ${delta} across ${spanCount} Rallies since Rally ${prevKnown.number} — missing Unseen Rally?`,
    );
  }
}

/** Runs Rally-level checks 8–11 and Shot-level checks 1–7 across one Game. */
function checkGame(roster: Roster, gameIndex: number, game: Game, out: RuleIssue[]): void {
  const evenRight = new Map<string, string>();
  let legalServingBox: Box | null = null;
  let lastKnownScoreIdx: number | null = null;

  for (let ri = 0; ri < game.rallies.length; ri++) {
    const rally = game.rallies[ri]!;
    const emit: RallyEmitter = (code, severity, field, message) =>
      out.push(
        makeIssue(
          gameIndex,
          ri,
          game.number,
          rally.number,
          null,
          null,
          code,
          severity,
          field,
          message,
        ),
      );

    checkShots(roster, gameIndex, ri, game.number, rally, out);

    const score = validScore(rally);
    const servingTeam = knownTeam(roster, rally.serving_team_id);

    const flags = checkIntraRallyImpossibilities(roster, rally, servingTeam, emit);
    checkRefereeCallServerNumber(rally, emit);
    checkWinnerAgreement(roster, rally, emit);

    if (ri === 0 && score !== null && !isOpeningScore(score)) {
      emit(
        "game_opening_score",
        "amber",
        "score",
        `Game ${game.number} Rally ${rally.number} starts at ${formatScoreValue(score)}, expected 0-0-2 under side-out doubles rules.`,
      );
    }

    if (ri > 0) {
      checkAdjacentTransition(
        roster,
        game.rallies[ri - 1]!,
        rally,
        score,
        servingTeam,
        flags,
        emit,
      );
    }

    legalServingBox = nextLegalBox(roster, game.rallies, ri, legalServingBox);
    if (score !== null && servingTeam !== null && legalServingBox !== null) {
      checkServingBoxParity(
        roster,
        rally,
        score,
        servingTeam,
        legalServingBox,
        evenRight,
        flags,
        emit,
      );
    }

    if (score !== null && servingTeam !== null) {
      if (lastKnownScoreIdx !== null && lastKnownScoreIdx < ri - 1) {
        checkCrossGapMonotonicity(
          roster,
          game.rallies[lastKnownScoreIdx]!,
          ri - lastKnownScoreIdx,
          score,
          servingTeam,
          emit,
        );
      }
      lastKnownScoreIdx = ri;
    }
  }
}

/**
 * Evaluates all 11 rule checks across every Game and Rally of a Match, returning issues in
 * canonical chronological order: Game.number → Rally.number → Rally-level (Inspector field order)
 * → Shot-level (entryIndex order, then Inspector field order).
 */
export function checkMatch(games: readonly Game[], roster: Roster): RuleIssue[] {
  const out: RuleIssue[] = [];
  for (let gi = 0; gi < games.length; gi++) {
    checkGame(roster, gi, games[gi]!, out);
  }
  out.sort(compareIssues);
  return out;
}

/** Counts total Red and Amber issues. */
export function countIssues(issues: readonly RuleIssue[]): IssueCounts {
  let red = 0;
  let amber = 0;
  for (const issue of issues) {
    if (issue.severity === "red") red += 1;
    else amber += 1;
  }
  return { red, amber };
}

export function rallyIssueKey(gameIndex: number, rallyIndex: number): string {
  return `${gameIndex}:${rallyIndex}`;
}

/** Per-Rally Red and Amber counts (combining Shot-level and Rally-level issues). */
export function countIssuesByRally(issues: readonly RuleIssue[]): Map<string, IssueCounts> {
  const map = new Map<string, IssueCounts>();
  for (const issue of issues) {
    const key = rallyIssueKey(issue.gameIndex, issue.rallyIndex);
    const counts = map.get(key) ?? { red: 0, amber: 0 };
    if (issue.severity === "red") counts.red += 1;
    else counts.amber += 1;
    map.set(key, counts);
  }
  return map;
}

function primaryOf(group: readonly RuleIssue[]): RuleIssue {
  return group.find((issue) => issue.severity === "red") ?? group[0]!;
}

/**
 * Merges rule issues into clickable Timeline markers: one triangle per offending Shot (with known
 * contact frame) and one bar per offending framed or open-ended Rally (Unseen Rallies omitted).
 */
export function timelineIssueMarkers(
  games: readonly Game[],
  issues: readonly RuleIssue[],
): { shots: TimelineShotMarker[]; rallies: TimelineRallyMarker[] } {
  const shotGroups = new Map<string, RuleIssue[]>();
  const rallyGroups = new Map<string, RuleIssue[]>();

  for (const issue of issues) {
    if (issue.entryIndex !== null) {
      if (issue.shotFrame === null) continue;
      const key = `${issue.gameIndex}:${issue.rallyIndex}:${issue.entryIndex}`;
      const list = shotGroups.get(key);
      if (list) list.push(issue);
      else shotGroups.set(key, [issue]);
    } else {
      const key = rallyIssueKey(issue.gameIndex, issue.rallyIndex);
      const list = rallyGroups.get(key);
      if (list) list.push(issue);
      else rallyGroups.set(key, [issue]);
    }
  }

  const shots: TimelineShotMarker[] = [];
  for (const [key, group] of shotGroups) {
    const primary = primaryOf(group);
    shots.push({
      key,
      gameIndex: primary.gameIndex,
      rallyIndex: primary.rallyIndex,
      entryIndex: primary.entryIndex!,
      gameNumber: primary.gameNumber,
      rallyNumber: primary.rallyNumber,
      shotFrame: primary.shotFrame!,
      severity: primary.severity,
      primaryIssue: primary,
      issues: group,
      tooltip: group.map((i) => i.message).join("\n"),
    });
  }

  const rallies: TimelineRallyMarker[] = [];
  for (const [key, group] of rallyGroups) {
    const primary = primaryOf(group);
    const rally = games[primary.gameIndex]?.rallies[primary.rallyIndex];
    if (!rally || rally.start_frame === null) continue;
    let endFrame: number;
    if (rally.end_frame !== null) {
      endFrame = Math.max(rally.start_frame, rally.end_frame);
    } else {
      let lastShotFrame: number | null = null;
      for (const entry of rally.entries) {
        if (isShot(entry) && known(entry.contact_frame)) {
          lastShotFrame =
            lastShotFrame === null
              ? entry.contact_frame.value
              : Math.max(lastShotFrame, entry.contact_frame.value);
        }
      }
      endFrame = Math.max(rally.start_frame, lastShotFrame ?? rally.start_frame);
    }
    rallies.push({
      key,
      gameIndex: primary.gameIndex,
      rallyIndex: primary.rallyIndex,
      gameNumber: primary.gameNumber,
      rallyNumber: primary.rallyNumber,
      startFrame: rally.start_frame,
      endFrame,
      severity: primary.severity,
      primaryIssue: primary,
      issues: group,
      tooltip: group.map((i) => i.message).join("\n"),
    });
  }

  return { shots, rallies };
}

export interface IssueNavigationContext {
  selection: Selection;
  inspectorTab: "shot" | "rally";
  focusedField: ShotField | RallyField | undefined;
  lastIssueId: string | null;
}

function matchesFocus(issue: RuleIssue, ctx: IssueNavigationContext): boolean {
  if (
    issue.gameIndex !== ctx.selection.game ||
    issue.rallyIndex !== ctx.selection.rally ||
    issue.field !== ctx.focusedField
  ) {
    return false;
  }
  return issue.entryIndex === null
    ? ctx.inspectorTab === "rally"
    : ctx.inspectorTab === "shot" && ctx.selection.entry === issue.entryIndex;
}

function compareTuples(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * Picks the next (`direction = 1`) or previous (`direction = -1`) rule issue relative to the
 * current selection/focus, wrapping around at either end. Returns `null` when there are 0 issues.
 */
export function nextRuleIssue(
  issues: readonly RuleIssue[],
  ctx: IssueNavigationContext,
  direction: 1 | -1,
): { issue: RuleIssue; index: number } | null {
  if (issues.length === 0) return null;

  if (ctx.lastIssueId !== null) {
    const lastIndex = issues.findIndex((i) => i.id === ctx.lastIssueId);
    if (lastIndex >= 0 && matchesFocus(issues[lastIndex]!, ctx)) {
      const nextIndex = (lastIndex + direction + issues.length) % issues.length;
      return { issue: issues[nextIndex]!, index: nextIndex };
    }
  }

  const { selection, inspectorTab, focusedField } = ctx;
  if (selection.rally === null) {
    const index =
      direction === 1
        ? issues.findIndex((i) => i.gameIndex >= selection.game)
        : issues.findLastIndex((i) => i.gameIndex < selection.game);
    const resolved = index >= 0 ? index : direction === 1 ? 0 : issues.length - 1;
    return { issue: issues[resolved]!, index: resolved };
  }

  const currentPos: readonly number[] =
    inspectorTab === "rally"
      ? [
          selection.game,
          selection.rally,
          -1,
          focusedField ? RALLY_FIELDS.indexOf(focusedField as RallyField) : -1,
        ]
      : selection.entry !== null
        ? [
            selection.game,
            selection.rally,
            selection.entry,
            focusedField ? SHOT_FIELDS.indexOf(focusedField as ShotField) : -1,
          ]
        : [selection.game, selection.rally, -1, -1];

  const posOf = (issue: RuleIssue): readonly number[] => [
    issue.gameIndex,
    issue.rallyIndex,
    issue.entryIndex ?? -1,
    fieldRank(issue),
  ];

  const index =
    direction === 1
      ? issues.findIndex((i) => compareTuples(posOf(i), currentPos) > 0)
      : issues.findLastIndex((i) => compareTuples(posOf(i), currentPos) < 0);
  const resolved = index >= 0 ? index : direction === 1 ? 0 : issues.length - 1;
  return { issue: issues[resolved]!, index: resolved };
}

/** Concise status bar hint shown when jumping to a rule issue. */
export function formatIssueHint(issue: RuleIssue, index: number, total: number): string {
  return `Issue ${index + 1}/${total} · G${issue.gameNumber} R${issue.rallyNumber} · ${issue.message}`;
}
