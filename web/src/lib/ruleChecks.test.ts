import { describe, expect, it } from "vitest";
import type { Game, ObservationGap, Rally, Score, Shot, ShotPosition } from "../api/client";
import { inferred, newRally, newShot, numberShots, observed, UNKNOWN } from "./rallyLog";
import {
  checkMatch,
  countIssues,
  countIssuesByRally,
  formatIssueHint,
  KITCHEN_LINE_Y_FT,
  KITCHEN_SIDELINE_X_FT,
  KITCHEN_STRICT_Y_FT,
  nextRuleIssue,
  rallyIssueKey,
  timelineIssueMarkers,
} from "./ruleChecks";
import { normalizeGame } from "./sideout";
import { ROSTER } from "./testRoster";

const score = (serving: number, receiving: number, server_number: 1 | 2): Score => ({
  serving,
  receiving,
  server_number,
});

const at = (x: number, y: number): ShotPosition => ({
  position: observed({ x, y }),
  settled: observed(true),
});

function shot(frame: number, fields: Partial<Shot> = {}): Shot {
  return { ...newShot(frame), ...fields };
}

function gap(missing: "odd" | "even"): ObservationGap {
  return { type: "gap", missing };
}

function rally(number: number, fields: Partial<Rally> = {}): Rally {
  const base: Rally = {
    ...newRally(number, number * 1000),
    end_frame: number * 1000 + 300,
    ...fields,
  };
  return numberShots(base);
}

function game(rallies: Rally[], number = 1): Game {
  return { number, rallies };
}

describe("ruleChecks: Shot-level checks (1–7)", () => {
  it("Check 1: flags Serve hit by Receiving Team and re-anchors forward without cascading", () => {
    const r = rally(1, {
      serving_team_id: observed("A"),
      server_id: observed("a1"),
      returner_id: observed("b1"),
      entries: [
        shot(1010, { hitter_id: observed("b1") }), // Wrong team for Serve -> Red (suppresses Check 2)
        shot(1050, { hitter_id: observed("a1"), contact_kind: observed("bounce") }), // Re-anchored after B -> A is legal!
        shot(1090, { hitter_id: observed("b2"), contact_kind: observed("bounce") }), // Legal
      ],
    });
    const issues = checkMatch([game([r])], ROSTER);
    expect(
      issues.map((i) => ({
        code: i.code,
        severity: i.severity,
        entry: i.entryIndex,
        field: i.field,
      })),
    ).toEqual([
      { code: "team_alternation", severity: "red", entry: 0, field: "hitter_id" },
      // Shot 2 (index 1) has return_hitter_mismatch suppressed? Wait: a1 != b1 and Check 1 did NOT fire on Shot 2.
      { code: "return_hitter_mismatch", severity: "amber", entry: 1, field: "hitter_id" },
    ]);
    expect(issues[0]!.message).toBe(
      "Serve is hit by Lee / Kim, but Bright / Johns is the Serving Team.",
    );
  });

  it("Check 1: flags consecutive same-Team Shots and re-anchors without cascading", () => {
    const r = rally(1, {
      serving_team_id: observed("A"),
      server_id: observed("a1"),
      returner_id: observed("b1"),
      entries: [
        shot(1010, { hitter_id: observed("a1") }),
        shot(1050, { hitter_id: observed("b1"), contact_kind: observed("bounce") }),
        shot(1090, { hitter_id: observed("b2"), contact_kind: observed("bounce") }), // Same team as previous -> Red
        shot(1130, { hitter_id: observed("a2") }), // Re-anchored after B -> A is legal
      ],
    });
    const issues = checkMatch([game([r])], ROSTER);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "team_alternation",
      severity: "red",
      entryIndex: 2,
      field: "hitter_id",
      message: "Teams must alternate: Shot 3 is hit by the same Team as the previous Shot.",
    });
  });

  it("Check 1: handles leading odd and even Observation Gaps (including combined multiple gaps)", () => {
    // Serving A + leading odd gap -> expect B; A hitting is Red.
    const rOddBad = rally(1, {
      serving_team_id: observed("A"),
      entries: [gap("odd"), shot(1050, { hitter_id: observed("a1") })],
    });
    const oddIssues = checkMatch([game([rOddBad])], ROSTER);
    expect(oddIssues).toHaveLength(1);
    expect(oddIssues[0]!.message).toBe(
      "After a leading odd Observation Gap, expected Lee / Kim to hit, not Bright / Johns.",
    );

    // Serving A + leading odd gap -> B hitting is valid.
    const rOddGood = rally(1, {
      serving_team_id: observed("A"),
      entries: [gap("odd"), shot(1050, { hitter_id: observed("b1") })],
    });
    expect(checkMatch([game([rOddGood])], ROSTER)).toEqual([]);

    // Serving A + leading even gap -> expect A; B hitting is Red.
    const rEvenBad = rally(1, {
      serving_team_id: observed("A"),
      entries: [gap("even"), shot(1050, { hitter_id: observed("b1") })],
    });
    expect(checkMatch([game([rEvenBad])], ROSTER)[0]!.message).toBe(
      "After a leading even Observation Gap, expected Bright / Johns to hit, not Lee / Kim.",
    );

    // Two consecutive leading odd gaps combine to even -> expect A; B hitting is Red.
    const rDoubleOdd = rally(1, {
      serving_team_id: observed("A"),
      entries: [gap("odd"), gap("odd"), shot(1050, { hitter_id: observed("b1") })],
    });
    expect(checkMatch([game([rDoubleOdd])], ROSTER)[0]!.message).toBe(
      "After a leading even Observation Gap, expected Bright / Johns to hit, not Lee / Kim.",
    );
  });

  it("Check 1: handles mid-Rally odd and even Observation Gaps", () => {
    // Shot 1 (A) -> odd gap -> expect A (1 missing = B, next = A). B hitting is Red.
    const rMidOdd = rally(1, {
      serving_team_id: observed("A"),
      entries: [
        shot(1010, { hitter_id: observed("a1") }),
        gap("odd"),
        shot(1100, { hitter_id: observed("b1") }),
      ],
    });
    expect(checkMatch([game([rMidOdd])], ROSTER)[0]!.message).toBe(
      "After an odd Observation Gap, expected Bright / Johns to hit, not Lee / Kim.",
    );

    // Shot 1 (A) -> even gap -> expect B. A hitting is Red.
    const rMidEven = rally(1, {
      serving_team_id: observed("A"),
      entries: [
        shot(1010, { hitter_id: observed("a1") }),
        gap("even"),
        shot(1100, { hitter_id: observed("a2") }),
      ],
    });
    expect(checkMatch([game([rMidEven])], ROSTER)[0]!.message).toBe(
      "After an even Observation Gap, expected Lee / Kim to hit, not Bright / Johns.",
    );
  });

  it("Check 1: counts Unknown-hitter Shots as 1 team flip (A -> Unknown -> B is Red)", () => {
    const rBad = rally(1, {
      serving_team_id: observed("A"),
      entries: [
        shot(1010, { hitter_id: observed("a1") }),
        shot(1050, { hitter_id: UNKNOWN, contact_kind: observed("bounce") }),
        shot(1090, { hitter_id: observed("b1"), contact_kind: observed("bounce") }),
      ],
    });
    const issues = checkMatch([game([rBad])], ROSTER);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "team_alternation",
      severity: "red",
      entryIndex: 2,
      message: "Teams must alternate: expected Bright / Johns to hit Shot 3, not Lee / Kim.",
    });

    // A -> Unknown -> A is valid.
    const rGood = rally(1, {
      serving_team_id: observed("A"),
      entries: [
        shot(1010, { hitter_id: observed("a1") }),
        shot(1050, { hitter_id: UNKNOWN, contact_kind: observed("bounce") }),
        shot(1090, { hitter_id: observed("a2"), contact_kind: observed("bounce") }),
      ],
    });
    expect(checkMatch([game([rGood])], ROSTER)).toEqual([]);
  });

  it("Check 1: catches consecutive same-Team Shots even when Serving Team is Unknown", () => {
    const r = rally(1, {
      serving_team_id: UNKNOWN,
      entries: [
        gap("odd"),
        shot(1010, { hitter_id: observed("a1") }),
        shot(1050, { hitter_id: observed("a2") }),
      ],
    });
    const issues = checkMatch([game([r])], ROSTER);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toBe(
      "Teams must alternate: Shot ? is hit by the same Team as the previous Shot.",
    );
  });

  it("Checks 2 & 3: flags Serve/Return partner mismatch in Amber, suppressed when Check 1 fires", () => {
    const rMismatch = rally(1, {
      serving_team_id: observed("A"),
      server_id: observed("a1"),
      returner_id: observed("b1"),
      entries: [
        shot(1010, { hitter_id: observed("a2") }), // Partner on A -> Amber Check 2
        shot(1050, { hitter_id: inferred("b2"), contact_kind: observed("bounce") }), // Inferred partner on B -> Amber Check 3
      ],
    });
    const issues = checkMatch([game([rMismatch])], ROSTER);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      code: "serve_hitter_mismatch",
      severity: "amber",
      entryIndex: 0,
      field: "hitter_id",
      message: "The Serve is hit by Ben Johns, but the Server is Anna Bright.",
    });
    expect(issues[1]).toMatchObject({
      code: "return_hitter_mismatch",
      severity: "amber",
      entryIndex: 1,
      field: "hitter_id",
      message: "The Return is hit by Dan Kim, but the Returner is Cara Lee.",
    });

    // Wrong team on Shot 2 triggers Check 1 Red and suppresses Check 3 Amber.
    const rWrongReturnTeam = rally(1, {
      serving_team_id: observed("A"),
      server_id: observed("a1"),
      returner_id: observed("b1"),
      entries: [
        shot(1010, { hitter_id: observed("a1") }),
        shot(1050, { hitter_id: observed("a2"), contact_kind: observed("bounce") }),
      ],
    });
    const suppressed = checkMatch([game([rWrongReturnTeam])], ROSTER);
    expect(suppressed.map((i) => i.code)).toEqual(["team_alternation"]);
  });

  it("Check 4: flags two-bounce rule on Shots 2 and 3, skips Serve, Unknown, and post-gap Shots", () => {
    const r = rally(1, {
      serving_team_id: observed("A"),
      entries: [
        shot(1010, { hitter_id: observed("a1"), contact_kind: observed("volley") }), // Shot 1 volley serve OK
        shot(1050, { hitter_id: observed("b1"), contact_kind: observed("volley") }), // Shot 2 -> Red
        shot(1090, { hitter_id: observed("a1"), contact_kind: inferred("volley") }), // Shot 3 (Inferred) -> Red
        shot(1130, { hitter_id: observed("b1"), contact_kind: observed("volley") }), // Shot 4 OK
        gap("even"),
        shot(1200, { hitter_id: observed("a1"), contact_kind: observed("volley") }), // After gap -> skipped
      ],
    });
    const issues = checkMatch([game([r])], ROSTER);
    expect(issues.map((i) => ({ code: i.code, entry: i.entryIndex, msg: i.message }))).toEqual([
      {
        code: "two_bounce_rule",
        entry: 1,
        msg: "Shot 2 must be a Bounce (two-bounce rule).",
      },
      {
        code: "two_bounce_rule",
        entry: 2,
        msg: "Shot 3 must be a Bounce (two-bounce rule).",
      },
    ]);
  });

  it("Check 5: enforces 6.5 / 7.0 ft kitchen volley thresholds, sidelines, Erne, and Kitchen Fault exemptions", () => {
    const mkVolley = (
      frame: number,
      hitter: string,
      pos: ShotPosition,
      extra: Partial<Shot> = {},
    ) =>
      shot(frame, {
        hitter_id: observed(hitter),
        contact_kind: observed("volley"),
        positions: { [hitter]: pos },
        ...extra,
      });

    const r = rally(1, {
      serving_team_id: observed("A"),
      entries: [
        // Shot 1-3 normal setup (bounces)
        shot(1010, { hitter_id: observed("a1") }),
        shot(1020, { hitter_id: observed("b1"), contact_kind: observed("bounce") }),
        shot(1030, { hitter_id: observed("a1"), contact_kind: observed("bounce") }),
        // Shot 4: inside kitchen (< 6.5 ft, on near court y = -4.2) -> Red
        mkVolley(1040, "b1", at(KITCHEN_SIDELINE_X_FT, -4.2)),
        // Shot 5: at exact 6.5 ft boundary -> Amber
        mkVolley(1050, "a1", at(0, KITCHEN_STRICT_Y_FT)),
        // Shot 6: at exact 7.0 ft boundary -> Amber
        mkVolley(1060, "b1", at(-5, -KITCHEN_LINE_Y_FT)),
        // Shot 7: just outside kitchen (7.01 ft) -> clean
        mkVolley(1070, "a1", at(0, 7.01)),
        // Shot 8: outside sidelines (|x| > 10.0 ft) -> exempt
        mkVolley(1080, "b1", at(10.1, 3.0)),
        // Shot 9: Erne = true (Inferred) -> exempt
        mkVolley(1090, "a1", at(4.0, 2.0), { erne: inferred(true) }),
        // Shot 10: Bounce inside kitchen -> clean
        shot(1100, {
          hitter_id: observed("b1"),
          contact_kind: observed("bounce"),
          positions: { b1: at(0, 3.0) },
        }),
        // Shot 11: partner Kitchen Fault does NOT exempt the hitter's volley -> Red!
        mkVolley(1110, "a1", at(0, 3.0), {
          error: { kind: observed("kitchen_fault"), player_id: observed("a2") },
        }),
        // Shot 12: hitter Kitchen Fault exempts the volley (and last entry so no Check 6)
        mkVolley(1120, "b1", at(0, 3.0), {
          error: { kind: observed("kitchen_fault"), player_id: observed("b1") },
        }),
      ],
    });
    const issues = checkMatch([game([r])], ROSTER);
    const kitchen = issues.filter(
      (i) => i.code === "kitchen_volley" || i.code === "kitchen_line_volley",
    );
    expect(
      kitchen.map((i) => ({ entry: i.entryIndex, severity: i.severity, msg: i.message })),
    ).toEqual([
      { entry: 3, severity: "red", msg: "Volley from inside the kitchen (4.2 ft from net)." },
      {
        entry: 4,
        severity: "amber",
        msg: "Volley at the kitchen line (6.5 ft from net) — check Contact Kind or foot position.",
      },
      {
        entry: 5,
        severity: "amber",
        msg: "Volley at the kitchen line (7.0 ft from net) — check Contact Kind or foot position.",
      },
      { entry: 10, severity: "red", msg: "Volley from inside the kitchen (3.0 ft from net)." },
    ]);

    // Also verify Kitchen Fault with Unknown player_id exempts the volley.
    const rUnkFaultPlayer = rally(1, {
      serving_team_id: observed("A"),
      entries: [
        mkVolley(1010, "a1", at(0, 3.0), {
          error: { kind: observed("kitchen_fault"), player_id: UNKNOWN },
        }),
      ],
    });
    expect(checkMatch([game([rUnkFaultPlayer])], ROSTER)).toEqual([]);
  });

  it("Checks 6 & 7: flags non-final Error in Red (including before a gap) and last-Shot Error winner mismatch in Amber unless overturned", () => {
    const rNonFinal = rally(1, {
      serving_team_id: observed("A"),
      winner_id: observed("A"),
      entries: [
        shot(1010, {
          hitter_id: observed("a1"),
          error: { kind: observed("net"), player_id: observed("a1") },
        }),
        gap("odd"),
      ],
    });
    const nonFinalIssues = checkMatch([game([rNonFinal])], ROSTER);
    expect(nonFinalIssues).toHaveLength(1);
    expect(nonFinalIssues[0]).toMatchObject({
      code: "non_final_error",
      severity: "red",
      entryIndex: 0,
      field: "error",
      message: "Error recorded on Shot 1, but the Rally continues after it.",
    });

    // Final Shot Error by a1 implies B won, but winner_id is A -> Check 7 Amber.
    const rLastMismatch = rally(1, {
      serving_team_id: observed("A"),
      winner_id: observed("A"),
      entries: [
        shot(1010, {
          hitter_id: observed("a1"),
          error: { kind: observed("out"), player_id: observed("a1") },
        }),
      ],
    });
    const mismatchIssues = checkMatch([game([rLastMismatch])], ROSTER);
    expect(mismatchIssues).toHaveLength(1);
    expect(mismatchIssues[0]).toMatchObject({
      code: "error_winner_mismatch",
      severity: "amber",
      entryIndex: 0,
      field: "error",
      message: "Error by Anna Bright implies Lee / Kim won, but Rally winner is Bright / Johns.",
    });

    // Overturned Challenge exempts Check 7.
    const rOverturned = rally(1, {
      ...rLastMismatch,
      challenge: {
        challenger_id: observed("a1"),
        original_call: observed("Out"),
        ruling: observed("overturned"),
      },
    });
    expect(checkMatch([game([rOverturned])], ROSTER)).toEqual([]);

    // Upheld Challenge still runs Check 7.
    const rUpheld = rally(1, {
      ...rLastMismatch,
      challenge: {
        challenger_id: observed("a1"),
        original_call: observed("Out"),
        ruling: observed("upheld"),
      },
    });
    expect(checkMatch([game([rUpheld])], ROSTER).map((i) => i.code)).toEqual([
      "error_winner_mismatch",
    ]);
  });
});

describe("ruleChecks: Rally-level checks (8–11)", () => {
  it("Check 8: flags negative score, wrong-Team Server, and wrong-Team Returner in Red without Check 11 double-flags", () => {
    const r = rally(1, {
      status: "empty",
      score: observed(score(-1, 0, 2)),
      serving_team_id: observed("A"),
      server_id: observed("b1"),
      returner_id: observed("a2"),
    });
    const issues = checkMatch([game([r])], ROSTER);
    expect(
      issues.map((i) => ({ code: i.code, severity: i.severity, field: i.field, msg: i.message })),
    ).toEqual([
      { code: "negative_score", severity: "red", field: "score", msg: "Score cannot be negative." },
      {
        code: "server_wrong_team",
        severity: "red",
        field: "server_id",
        msg: "Cara Lee is not on the Serving Team (Bright / Johns).",
      },
      {
        code: "returner_wrong_team",
        severity: "red",
        field: "returner_id",
        msg: "Ben Johns is on the Serving Team, not the Receiving Team (Lee / Kim).",
      },
    ]);
  });

  it("Check 9: flags Referee Call vs score.server_number mismatch in Amber", () => {
    const r1 = rally(1, {
      score: observed(score(0, 0, 2)),
      serving_team_id: observed("A"),
      referee_call: observed("second_server"),
    });
    const r2 = rally(2, {
      score: observed(score(0, 0, 1)),
      serving_team_id: observed("B"),
      referee_call: observed("side_out"),
    });
    const issues = checkMatch([game([r1, r2])], ROSTER).filter(
      (i) => i.code === "referee_call_server_number_mismatch",
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]!.message).toBe(
      "Referee Call is Second server, but score has Server 2 (expected Side out).",
    );
    expect(issues[1]!.message).toBe(
      "Referee Call is Side out, but score has Server 1 (expected Second server).",
    );
  });

  it("Check 10: flags post-Challenge / Referee Call vs Scoreboard and winner disagreements without double-flagging", () => {
    // 10.1: Referee Call says A, scoreboard says B, winner is A -> ONLY 10.1 fires (not 10.3!).
    const rCallVsSb = rally(1, {
      score: observed(score(0, 0, 2)),
      serving_team_id: observed("A"),
      referee_call: observed("point"),
      scoreboard_winner_id: observed("B"),
      winner_id: inferred("A"),
      winner_source: "referee_call",
    });
    const callIssues = checkMatch([game([rCallVsSb])], ROSTER);
    expect(callIssues).toHaveLength(1);
    expect(callIssues[0]).toMatchObject({
      code: "official_scoreboard_mismatch",
      severity: "amber",
      field: "winner_id",
      message: "Referee Call (Point) says Bright / Johns won, but the scoreboard says Lee / Kim.",
    });

    // 10.1 overturned Challenge (from Referee Call): Point for A overturned -> B, scoreboard says A.
    const rOverturnedCall = rally(1, {
      ...rCallVsSb,
      challenge: {
        challenger_id: observed("b1"),
        original_call: observed("Out"),
        ruling: observed("overturned"),
      },
      scoreboard_winner_id: observed("A"),
      winner_id: observed("B"),
      winner_source: "challenge",
    });
    const ovIssues = checkMatch([game([rOverturnedCall])], ROSTER);
    expect(ovIssues).toHaveLength(1);
    expect(ovIssues[0]!.message).toBe(
      "Overturned Challenge gives the Rally to Lee / Kim, but the scoreboard says Bright / Johns.",
    );

    // 10.1 overturned Challenge falling back to last-Shot Error (no Referee Call).
    const rOverturnedErr = rally(1, {
      score: observed(score(0, 0, 2)),
      serving_team_id: observed("A"),
      entries: [
        shot(1010, {
          hitter_id: observed("a1"),
          error: { kind: observed("out"), player_id: observed("a1") }, // implies B, overturned -> A
        }),
      ],
      challenge: {
        challenger_id: observed("a1"),
        original_call: observed("Out"),
        ruling: observed("overturned"),
      },
      scoreboard_winner_id: observed("B"),
      winner_id: observed("A"),
      winner_source: "challenge",
    });
    expect(checkMatch([game([rOverturnedErr])], ROSTER).map((i) => i.message)).toEqual([
      "Overturned Challenge gives the Rally to Bright / Johns, but the scoreboard says Lee / Kim.",
    ]);

    // 10.2: winner disagrees with Referee Call.
    const rWinnerVsCall = rally(1, {
      score: observed(score(0, 0, 2)),
      serving_team_id: observed("A"),
      referee_call: observed("point"),
      scoreboard_winner_id: observed("A"),
      winner_id: observed("B"),
    });
    expect(
      checkMatch([game([rWinnerVsCall])], ROSTER).map((i) => ({ code: i.code, msg: i.message })),
    ).toEqual([
      {
        code: "winner_official_mismatch",
        msg: "Rally winner is Lee / Kim, but Referee Call says Bright / Johns won.",
      },
    ]);

    // 10.3: no official call, winner disagrees with scoreboard.
    const rWinnerVsSb = rally(1, {
      score: observed(score(0, 0, 2)),
      serving_team_id: observed("A"),
      scoreboard_winner_id: observed("B"),
      winner_id: observed("A"),
    });
    expect(
      checkMatch([game([rWinnerVsSb])], ROSTER).map((i) => ({ code: i.code, msg: i.message })),
    ).toEqual([
      {
        code: "winner_scoreboard_mismatch",
        msg: "Rally winner is Bright / Johns, but the scoreboard says Lee / Kim.",
      },
    ]);
  });

  it("Check 11a & 11b: checks Game opening 0-0-2, known-winner transitions, and Unknown-winner 2-outcome check", () => {
    // 11a: Game opening != 0-0-2
    const rOpenBad = rally(1, {
      score: observed(score(0, 0, 1)),
      serving_team_id: observed("A"),
    });
    expect(checkMatch([game([rOpenBad])], ROSTER)[0]).toMatchObject({
      code: "game_opening_score",
      severity: "amber",
      field: "score",
      message: "Game 1 Rally 1 starts at 0-0-1, expected 0-0-2 under side-out doubles rules.",
    });

    // 11b known winner: wrong score -> field score; right score + wrong team -> field serving_team_id.
    const gKnown = game([
      rally(1, {
        score: observed(score(0, 0, 2)),
        serving_team_id: observed("A"),
        winner_id: observed("A"),
      }),
      rally(2, {
        score: observed(score(1, 0, 2)),
        serving_team_id: observed("B"), // score right, only team wrong -> serving_team_id
        winner_id: observed("B"),
      }),
      rally(3, {
        score: observed(score(5, 0, 2)),
        serving_team_id: observed("B"), // wrong score -> score
      }),
    ]);
    const knownIssues = checkMatch([gKnown], ROSTER);
    expect(
      knownIssues.map((i) => ({ rally: i.rallyNumber, code: i.code, field: i.field })),
    ).toEqual([
      { rally: 2, code: "score_sequence", field: "serving_team_id" },
      { rally: 3, code: "score_sequence", field: "score" },
    ]);

    // 11b Unknown winner: 2 legal successors (1-0-2 A or 0-0-1 B).
    const gUnkOk = game([
      rally(1, { score: observed(score(0, 0, 2)), serving_team_id: observed("A") }),
      rally(2, { score: observed(score(0, 0, 1)), serving_team_id: observed("B") }),
      rally(3, { score: observed(score(1, 0, 1)), serving_team_id: observed("B") }),
    ]);
    expect(checkMatch([gUnkOk], ROSTER)).toEqual([]);

    const gUnkBad = game([
      rally(1, { score: observed(score(0, 0, 2)), serving_team_id: observed("A") }),
      rally(2, { score: observed(score(2, 0, 2)), serving_team_id: observed("A") }),
      rally(3, { score: observed(score(2, 0, 1)), serving_team_id: observed("B") }), // matches neither 3-0-2 A nor 0-2-1 B
    ]);
    const unkIssues = checkMatch([gUnkBad], ROSTER);
    expect(unkIssues[0]).toMatchObject({
      rallyNumber: 2,
      code: "score_sequence",
      field: "score",
      message: "After Rally 1 (0-0-2), expected 1-0-2 or 0-0-1, got 2-0-2.",
    });

    // Unknown winner where score matches one legal outcome (0-0-1) but team is wrong (A instead of B).
    const gUnkTeamOnly = game([
      rally(1, { score: observed(score(0, 0, 2)), serving_team_id: observed("A") }),
      rally(2, { score: observed(score(0, 0, 1)), serving_team_id: observed("A") }),
    ]);
    expect(checkMatch([gUnkTeamOnly], ROSTER)[0]).toMatchObject({
      rallyNumber: 2,
      code: "score_sequence",
      field: "serving_team_id",
    });
  });

  it("Check 11c: checks Serving Team continuity when scores are Unknown", () => {
    const g = game([
      rally(1, {
        score: UNKNOWN,
        serving_team_id: observed("A"),
        referee_call: observed("side_out"),
        winner_id: inferred("B"),
      }),
      rally(2, {
        score: UNKNOWN,
        serving_team_id: observed("A"), // should have switched to B
        referee_call: observed("second_server"),
        winner_id: inferred("B"),
      }),
      rally(3, {
        score: UNKNOWN,
        serving_team_id: observed("B"), // should have stayed A
      }),
    ]);
    const issues = checkMatch([g], ROSTER);
    expect(issues.map((i) => ({ rally: i.rallyNumber, code: i.code, field: i.field }))).toEqual([
      { rally: 2, code: "serving_team_sequence", field: "serving_team_id" },
      { rally: 3, code: "serving_team_sequence", field: "serving_team_id" },
    ]);
  });

  it("Check 11d & 11e: enforces turn continuity and stacking-safe even_right parity across side-outs without cascading", () => {
    // A clean normalized multi-rally Game across Points, Second server, and Side outs has 0 issues.
    const clean = normalizeGame(
      game([
        rally(1, {
          serving_team_id: observed("A"),
          server_id: observed("a1"),
          returner_id: observed("b1"),
          referee_call: observed("point"),
        }),
        rally(2, { referee_call: observed("side_out") }),
        rally(3, { referee_call: observed("point") }),
        rally(4, { referee_call: observed("second_server") }),
        rally(5, { referee_call: observed("side_out") }),
        rally(6),
      ]),
      ROSTER,
      -1,
    );
    expect(checkMatch([clean], ROSTER)).toEqual([]);

    // 11d: within a service turn, wrong Server after a Point flags ONLY 11d (no 11e double-flag).
    const badTurn = game([
      rally(1, {
        score: observed(score(0, 0, 2)),
        serving_team_id: observed("A"),
        server_id: observed("a1"),
        returner_id: observed("b1"),
        winner_id: observed("A"),
      }),
      rally(2, {
        score: observed(score(1, 0, 2)),
        serving_team_id: observed("A"),
        server_id: observed("a2"), // should stay a1
        returner_id: observed("b1"), // should switch to b2
      }),
    ]);
    expect(checkMatch([badTurn], ROSTER).map((i) => ({ code: i.code, field: i.field }))).toEqual([
      { code: "server_turn_sequence", field: "server_id" },
      { code: "returner_turn_sequence", field: "returner_id" },
    ]);

    // 11e: after a side-out, Server parity typo flags Rally 3 ONLY; evenRight stays stable so Rally 4 passes!
    const badParity = game([
      rally(1, {
        score: observed(score(0, 0, 2)),
        serving_team_id: observed("A"),
        server_id: observed("a1"), // evenRight[A] = a1
        returner_id: observed("b1"), // evenRight[B] = b1
        winner_id: observed("B"), // side out -> B serves 0-0-1 from right
      }),
      rally(2, {
        score: observed(score(0, 0, 1)),
        serving_team_id: observed("B"),
        server_id: observed("b2"), // TYPO: should be b1 (even score, right box)!
        returner_id: observed("a1"), // OK (even score, right box)
        winner_id: observed("A"), // second server -> 0-0-2 from LEFT box
      }),
      rally(3, {
        score: observed(score(0, 0, 2)),
        serving_team_id: observed("B"),
        server_id: observed("b2"), // OK on left box at score 0! (evenRight[B] stayed b1; 11d compares to R2's typo b2)
        returner_id: observed("a2"), // OK on left box at score 0
        winner_id: observed("A"), // side out -> A serves 0-0-1 from right
      }),
      rally(4, {
        score: observed(score(0, 0, 1)),
        serving_team_id: observed("A"),
        server_id: observed("a1"), // OK
        returner_id: observed("b1"), // OK (confirms evenRight[B] was NOT overwritten by R2's typo!)
      }),
    ]);
    const parityIssues = checkMatch([badParity], ROSTER);
    expect(parityIssues.filter((i) => i.rallyNumber === 2).map((i) => i.code)).toEqual([
      "server_parity",
    ]);
    expect(parityIssues.filter((i) => i.rallyNumber === 4)).toEqual([]);
  });

  it("Check 11f: checks cross-gap score monotonicity across Unknown-score Rallies", () => {
    const gBackwards = game([
      rally(1, {
        score: observed(score(0, 0, 2)),
        serving_team_id: observed("A"),
        winner_id: observed("A"),
      }),
      rally(2, {
        score: observed(score(1, 0, 2)),
        serving_team_id: observed("A"),
        winner_id: observed("A"),
      }),
      rally(3, { score: UNKNOWN, serving_team_id: UNKNOWN, start_frame: null, end_frame: null }),
      rally(4, { score: observed(score(0, 0, 1)), serving_team_id: observed("B") }), // [0, 0] < [1, 0]
    ]);
    expect(
      checkMatch([gBackwards], ROSTER).map((i) => ({
        rally: i.rallyNumber,
        code: i.code,
        msg: i.message,
      })),
    ).toEqual([
      {
        rally: 4,
        code: "score_backwards",
        msg: "Score went backwards from Rally 2 (1-0 → 0-0).",
      },
    ]);

    const gJump = game([
      rally(1, { score: observed(score(0, 0, 2)), serving_team_id: observed("A") }),
      rally(2, { score: UNKNOWN, serving_team_id: UNKNOWN, start_frame: null, end_frame: null }),
      rally(3, { score: observed(score(3, 0, 2)), serving_team_id: observed("A") }), // delta 3 > span 2
    ]);
    expect(
      checkMatch([gJump], ROSTER).map((i) => ({
        rally: i.rallyNumber,
        code: i.code,
        msg: i.message,
      })),
    ).toEqual([
      {
        rally: 3,
        code: "score_jump",
        msg: "Score jumped by 3 across 2 Rallies since Rally 1 — missing Unseen Rally?",
      },
    ]);

    // Delta <= spanCount is legal.
    const gValidGap = game([
      rally(1, { score: observed(score(0, 0, 2)), serving_team_id: observed("A") }),
      rally(2, { score: UNKNOWN, serving_team_id: UNKNOWN, start_frame: null, end_frame: null }),
      rally(3, { score: observed(score(2, 0, 2)), serving_team_id: observed("A") }), // delta 2 === span 2
    ]);
    expect(checkMatch([gValidGap], ROSTER)).toEqual([]);
  });

  it("evaluates all Rally statuses (empty, in_progress, done) and resets Check 11 per Game", () => {
    const g1 = game(
      [
        rally(1, {
          status: "done",
          score: observed(score(0, 0, 2)),
          serving_team_id: observed("A"),
          server_id: observed("a1"),
          returner_id: observed("b1"),
        }),
      ],
      1,
    );
    const g2 = game(
      [
        rally(1, {
          status: "in_progress",
          score: observed(score(0, 0, 2)),
          serving_team_id: observed("A"),
          server_id: observed("a2"), // New Game can start with a2 as evenRight[A]!
          returner_id: observed("b2"),
        }),
      ],
      2,
    );
    expect(checkMatch([g1, g2], ROSTER)).toEqual([]);
  });
});

describe("ruleChecks: merging, counts, and chronological F8 cycling", () => {
  it("merges multi-issue Shots and Rallies, handles open-ended & Unseen Rallies, and orders chronologically", () => {
    const r1Framed = rally(1, {
      start_frame: 100,
      end_frame: 400,
      score: observed(score(-1, 0, 2)), // Red: Check 8 negative score
      serving_team_id: observed("A"),
      referee_call: observed("second_server"), // Amber: Check 9 server_number 2 vs second_server
      entries: [
        shot(120, {
          hitter_id: observed("a1"),
        }),
        shot(170, {
          hitter_id: observed("b2"),
          contact_kind: observed("volley"), // Red: Check 4 two-bounce rule
          positions: { b2: at(0, 6.8) }, // Amber: Check 5 kitchen line
        }),
        shot(220, {
          contact_frame: UNKNOWN, // Unknown contact frame: omitted from Timeline triangles!
          hitter_id: observed("b1"), // Red: Check 1 alternation
        }),
      ],
    });
    const r2Open = rally(2, {
      start_frame: 500,
      end_frame: null,
      score: observed(score(0, 0, 2)),
      serving_team_id: observed("A"),
      server_id: observed("b1"), // Red: Check 8 server wrong team
      entries: [shot(580, { hitter_id: UNKNOWN })],
    });
    const r3Unseen = rally(3, {
      start_frame: null,
      end_frame: null,
      score: observed(score(-2, 0, 2)), // Red: Check 8 negative score (Unseen Rally)
      serving_team_id: observed("A"),
    });

    const games = [game([r1Framed, r2Open, r3Unseen])];
    const issues = checkMatch(games, ROSTER);

    // Verify counts.
    const total = countIssues(issues);
    expect(total.red + total.amber).toBe(issues.length);
    const byRally = countIssuesByRally(issues);
    expect(byRally.get(rallyIssueKey(0, 0))).toEqual({ red: 3, amber: 2 });
    expect(byRally.get(rallyIssueKey(0, 1))).toEqual({ red: 1, amber: 0 });
    expect(byRally.get(rallyIssueKey(0, 2))).toEqual({ red: 1, amber: 0 });

    // Verify Timeline markers: merged Shot 2 triangle (Red > Amber, 2 lines in tooltip), Shot 3 omitted (Unknown frame).
    const markers = timelineIssueMarkers(games, issues);
    expect(markers.shots).toHaveLength(1);
    expect(markers.shots[0]).toMatchObject({
      shotFrame: 170,
      severity: "red",
      primaryIssue: expect.objectContaining({ code: "two_bounce_rule", severity: "red" }),
    });
    expect(markers.shots[0]!.tooltip.split("\n")).toHaveLength(2);

    // Rally markers: r1 framed [100, 400] (Red > Amber), r2 open-ended [500, 580], r3 Unseen omitted!
    expect(markers.rallies).toHaveLength(2);
    expect(markers.rallies[0]).toMatchObject({
      startFrame: 100,
      endFrame: 400,
      severity: "red",
      primaryIssue: expect.objectContaining({ code: "negative_score", field: "score" }),
    });
    expect(markers.rallies[1]).toMatchObject({
      startFrame: 500,
      endFrame: 580,
      severity: "red",
    });

    // Verify F8 cycling walks every issue chronologically (including both issues on Shot 2 contact_kind and Unseen Rally 3) and wraps around.
    const visited: string[] = [];
    let ctx = {
      selection: { game: 0, rally: null as number | null, entry: null as number | null },
      inspectorTab: "shot" as "shot" | "rally",
      focusedField: undefined as ReturnType<typeof checkMatch>[number]["field"] | undefined,
      lastIssueId: null as string | null,
    };
    for (let step = 0; step < issues.length + 1; step++) {
      const next = nextRuleIssue(issues, ctx, 1)!;
      visited.push(next.issue.id);
      ctx = {
        selection: {
          game: next.issue.gameIndex,
          rally: next.issue.rallyIndex,
          entry: next.issue.entryIndex,
        },
        inspectorTab: next.issue.entryIndex === null ? "rally" : "shot",
        focusedField: next.issue.field,
        lastIssueId: next.issue.id,
      };
    }
    expect(visited.slice(0, issues.length)).toEqual(issues.map((i) => i.id));
    expect(visited.at(-1)).toBe(issues[0]!.id); // wrapped around

    // Shift+F8 from first issue wraps to the last issue (Unseen Rally 3).
    const prev = nextRuleIssue(issues, ctx, -1)!;
    expect(prev.issue.id).toBe(issues.at(-1)!.id);
    expect(formatIssueHint(prev.issue, prev.index, issues.length)).toBe(
      `Issue ${issues.length}/${issues.length} · G1 R3 · Score cannot be negative.`,
    );

    // Empty list returns null.
    expect(nextRuleIssue([], ctx, 1)).toBeNull();
  });

  it("navigates across multiple Games, Game-only selections, position-based fallbacks, wraps, and single-issue lists", () => {
    const g1 = game(
      [
        rally(1, {
          score: observed(score(-1, 0, 2)), // i0: G1 R1 score
          serving_team_id: observed("A"),
          server_id: observed("b1"), // i1: G1 R1 server_id
          entries: [
            shot(1010, { hitter_id: UNKNOWN }),
            shot(1050, { hitter_id: observed("b1"), contact_kind: observed("volley") }), // i2: G1 R1 entry 1 contact_kind
          ],
        }),
      ],
      1,
    );
    const g2 = game(
      [
        rally(1, {
          score: observed(score(0, 0, 1)), // i3: G2 R1 score
          serving_team_id: observed("A"),
        }),
        rally(2, {
          score: observed(score(-2, 0, 2)), // i4: G2 R2 score
          serving_team_id: observed("A"),
        }),
      ],
      2,
    );

    const issues = checkMatch([g1, g2], ROSTER);
    expect(
      issues.map((i) => `${i.gameNumber}:${i.rallyNumber}:${i.entryIndex ?? "r"}:${i.field}`),
    ).toEqual([
      "1:1:r:score",
      "1:1:r:server_id",
      "1:1:1:contact_kind",
      "2:1:r:score",
      "2:2:r:score",
    ]);

    // Game-only selection on Game 2 ({ game: 1, rally: null }): F8 -> G2 first, Shift+F8 -> G1 last.
    expect(
      nextRuleIssue(
        issues,
        {
          selection: { game: 1, rally: null, entry: null },
          inspectorTab: "shot",
          focusedField: undefined,
          lastIssueId: null,
        },
        1,
      )?.issue.id,
    ).toBe(issues[3]!.id);
    expect(
      nextRuleIssue(
        issues,
        {
          selection: { game: 1, rally: null, entry: null },
          inspectorTab: "shot",
          focusedField: undefined,
          lastIssueId: null,
        },
        -1,
      )?.issue.id,
    ).toBe(issues[2]!.id);
    // Game-only Shift+F8 from Game 1 wraps to the last issue in Game 2.
    expect(
      nextRuleIssue(
        issues,
        {
          selection: { game: 0, rally: null, entry: null },
          inspectorTab: "shot",
          focusedField: undefined,
          lastIssueId: null,
        },
        -1,
      )?.issue.id,
    ).toBe(issues[4]!.id);

    // Position-based fallback (lastIssueId null / stale): cursor on G1 R1 serving_team_id sits between score (i0) and server_id (i1).
    const betweenRallyFields = {
      selection: { game: 0, rally: 0, entry: null },
      inspectorTab: "rally" as const,
      focusedField: "serving_team_id" as const,
      lastIssueId: "stale-id",
    };
    expect(nextRuleIssue(issues, betweenRallyFields, 1)?.issue.id).toBe(issues[1]!.id);
    expect(nextRuleIssue(issues, betweenRallyFields, -1)?.issue.id).toBe(issues[0]!.id);

    // Position-based fallback crossing from Game 1's last Shot issue into Game 2 (and back).
    const atG1LastShot = {
      selection: { game: 0, rally: 0, entry: 1 },
      inspectorTab: "shot" as const,
      focusedField: "contact_kind" as const,
      lastIssueId: null,
    };
    expect(nextRuleIssue(issues, atG1LastShot, 1)?.issue.id).toBe(issues[3]!.id);
    expect(nextRuleIssue(issues, atG1LastShot, -1)?.issue.id).toBe(issues[1]!.id);

    // Wrapping from position-based fallback past the last issue -> first issue; before first -> last.
    expect(
      nextRuleIssue(
        issues,
        {
          selection: { game: 1, rally: 1, entry: null },
          inspectorTab: "rally",
          focusedField: "status",
          lastIssueId: null,
        },
        1,
      )?.issue.id,
    ).toBe(issues[0]!.id);
    expect(
      nextRuleIssue(
        issues,
        {
          selection: { game: 0, rally: 0, entry: null },
          inspectorTab: "rally",
          focusedField: "frames",
          lastIssueId: null,
        },
        -1,
      )?.issue.id,
    ).toBe(issues[4]!.id);

    // Single-issue list always returns that issue in both directions.
    const single = [issues[0]!];
    expect(nextRuleIssue(single, betweenRallyFields, 1)).toEqual({ issue: single[0], index: 0 });
    expect(nextRuleIssue(single, betweenRallyFields, -1)).toEqual({ issue: single[0], index: 0 });
  });
});
