import { describe, expect, it } from "vitest";
import type { Game, Rally } from "../api/client";
import { inferred, newRally, newShot, observed, UNKNOWN } from "./rallyLog";
import {
  applyBoxStep,
  boxParityPlayer,
  isOpeningScore,
  nextSideoutOutcomes,
  nextSideoutState,
  normalizeGame,
  refereeCallWinner,
  resolveWinner,
  sameScore,
} from "./sideout";
import { ROSTER } from "./testRoster";

function rally(number: number, fields: Partial<Rally> = {}): Rally {
  return { ...newRally(number, number * 1000), ...fields };
}

const score = (serving: number, receiving: number, server_number: 1 | 2) => ({
  serving,
  receiving,
  server_number,
});

function expectFacts(r: Rally, s: string, team: string, server: string, returner: string) {
  expect(
    r.score.value &&
      `${r.score.value.serving}-${r.score.value.receiving}-${r.score.value.server_number}`,
  ).toBe(s);
  expect(r.serving_team_id.value).toBe(team);
  expect(r.server_id.value).toBe(server);
  expect(r.returner_id.value).toBe(returner);
}

describe("side-out pre-fill", () => {
  it("opens every Game at 0-0-2 and follows Points, second servers and side outs", () => {
    const game: Game = {
      number: 1,
      rallies: [
        rally(1, {
          serving_team_id: observed("A"),
          server_id: observed("a1"),
          returner_id: observed("b1"),
          referee_call: observed("point"),
        }),
        rally(2, { referee_call: observed("side_out") }),
        rally(3, { referee_call: observed("point") }),
        rally(4, { referee_call: observed("second_server") }),
        rally(5),
      ],
    };
    const [r1, r2, r3, r4, r5] = normalizeGame(game, ROSTER, -1).rallies;
    expect(r1!.score).toEqual(inferred(score(0, 0, 2)));
    expect(r1!.winner_id).toEqual(inferred("A"));
    expect(r1!.winner_source).toBe("referee_call");
    // Point: same Server, Returner switches to the partner.
    expectFacts(r2!, "1-0-2", "A", "a1", "b2");
    expect(r2!.server_id.certainty).toBe("inferred");
    // Side out: B serves from the right-hand court at their score (0, even) -> b1, who stood
    // right at 0-0-2; A's right-hand Player at score 1 (odd) is a2.
    expectFacts(r3!, "0-1-1", "B", "b1", "a2");
    // Point for B.
    expectFacts(r4!, "1-1-1", "B", "b1", "a1");
    // Second server: the partner serves, the Returner switches.
    expectFacts(r5!, "1-1-2", "B", "b2", "a2");
  });

  it("cascades a changed ruling through Inferred Rallies but never overwrites Observed facts", () => {
    const base: Game = {
      number: 1,
      rallies: [
        rally(1, {
          serving_team_id: observed("A"),
          server_id: observed("a1"),
          returner_id: observed("b1"),
          referee_call: observed("point"),
        }),
        rally(2, { referee_call: observed("side_out"), returner_id: observed("b2") }),
        rally(3),
      ],
    };
    const before = normalizeGame(base, ROSTER, -1);
    expectFacts(before.rallies[1]!, "1-0-2", "A", "a1", "b2");

    // The first Rally was really a side out.
    const changed: Game = {
      ...before,
      rallies: before.rallies.map((r, i) =>
        i === 0 ? { ...r, referee_call: observed("side_out") } : r,
      ),
    };
    const after = normalizeGame(changed, ROSTER, 0).rallies;
    expect(after[0]!.winner_id.value).toBe("B");
    // Rally 2 is now B's serve from 0-0-1; its Observed Returner is kept.
    expectFacts(after[1]!, "0-0-1", "B", "b1", "b2");
    expect(after[1]!.returner_id.certainty).toBe("observed");
    // Rally 2's side-out call is the Receiving Team (A) winning with server 1: second server,
    // the Returner switching from the Observed one.
    expectFacts(after[2]!, "0-0-2", "B", "b2", "b1");
  });

  it("leaves facts Unknown when the previous Rally's winner isn't known", () => {
    const game: Game = {
      number: 1,
      rallies: [rally(1, { serving_team_id: observed("A") }), rally(2)],
    };
    const [, r2] = normalizeGame(game, ROSTER, -1).rallies;
    expect(r2!.score).toEqual(UNKNOWN);
    expect(r2!.serving_team_id).toEqual(UNKNOWN);
  });

  it("syncs the Server and Returner from Shots 1 and 2's Observed hitters", () => {
    const serve = { ...newShot(10), hitter_id: observed("b2") };
    const ret = { ...newShot(40), hitter_id: observed("a1") };
    const game: Game = { number: 1, rallies: [rally(1, { entries: [serve, ret] })] };
    const [r1] = normalizeGame(game, ROSTER, -1).rallies;
    expect(r1!.server_id).toEqual(inferred("b2"));
    expect(r1!.serving_team_id).toEqual(inferred("B"));
    expect(r1!.returner_id).toEqual(inferred("a1"));
    expect(r1!.entries.map((e) => (e.type === "shot" ? e.shot_number.value : null))).toEqual([
      1, 2,
    ]);
  });
});

describe("winner resolution", () => {
  const serving = { serving_team_id: observed("A"), score: observed(score(3, 2, 1)) };

  it("prefers a Challenge, then the Referee Call, then the scoreboard", () => {
    const called = rally(1, { ...serving, referee_call: observed("point") });
    expect(resolveWinner(ROSTER, called, undefined)).toEqual({
      winner_id: inferred("A"),
      winner_source: "referee_call",
    });
    const overturned = {
      ...called,
      challenge: {
        challenger_id: observed("b1"),
        original_call: observed("Out"),
        ruling: observed("overturned" as const),
      },
    };
    expect(resolveWinner(ROSTER, overturned, undefined)).toEqual({
      winner_id: observed("B"),
      winner_source: "challenge",
    });
    const scoreboard = rally(1, { ...serving, scoreboard_winner_id: observed("B") });
    expect(resolveWinner(ROSTER, scoreboard, undefined).winner_source).toBe("scoreboard");
  });

  it("infers an unseen Rally's winner from who serves next", () => {
    const unseen = rally(1, { ...serving, server_id: observed("a1") });
    const sideOut = rally(2, { serving_team_id: observed("B") });
    expect(resolveWinner(ROSTER, unseen, sideOut)).toEqual({
      winner_id: inferred("B"),
      winner_source: "next_serve",
    });
    const secondServer = rally(2, {
      serving_team_id: observed("A"),
      score: observed(score(3, 2, 2)),
    });
    expect(resolveWinner(ROSTER, unseen, secondServer).winner_id.value).toBe("B");
    const point = rally(2, { serving_team_id: observed("A"), score: observed(score(4, 2, 1)) });
    expect(resolveWinner(ROSTER, unseen, point).winner_id.value).toBe("A");
    const partner = rally(2, { serving_team_id: observed("A"), server_id: observed("a2") });
    expect(resolveWinner(ROSTER, unseen, partner).winner_id.value).toBe("B");
    // Inferred facts on the next Rally don't count.
    const guessed = rally(2, { serving_team_id: inferred("B") });
    expect(resolveWinner(ROSTER, unseen, guessed).winner_id).toEqual(UNKNOWN);
  });

  it("takes play from the last Shot's Error, or a winner set by hand", () => {
    const shot = {
      ...newShot(10),
      error: { kind: observed("out" as const), player_id: observed("a2") },
    };
    const errored = rally(1, { entries: [shot] });
    const fromError = resolveWinner(ROSTER, errored, undefined);
    // Inferred from the Error, so it is recomputed rather than kept as if typed by hand.
    expect(fromError).toEqual({ winner_id: inferred("B"), winner_source: "play" });
    const manual = rally(1, { winner_id: observed("A"), winner_source: "play" });
    expect(resolveWinner(ROSTER, manual, undefined).winner_id).toEqual(observed("A"));

    // The Error's Shot is gone: its winner goes too.
    const withoutError = { ...errored, ...fromError, entries: [] };
    expect(resolveWinner(ROSTER, withoutError, undefined)).toEqual({
      winner_id: UNKNOWN,
      winner_source: null,
    });
  });

  it("refereeCallWinner requires known facts and a Roster Team, accepting Observed and Inferred", () => {
    expect(
      refereeCallWinner(
        ROSTER,
        rally(1, { serving_team_id: observed("A"), referee_call: observed("point") }),
      ),
    ).toBe("A");
    expect(
      refereeCallWinner(
        ROSTER,
        rally(1, { serving_team_id: inferred("A"), referee_call: inferred("side_out") }),
      ),
    ).toBe("B");
    expect(
      refereeCallWinner(
        ROSTER,
        rally(1, { serving_team_id: observed("A"), referee_call: observed("second_server") }),
      ),
    ).toBe("B");
    // Unknown certainty (even if a stale value were present) returns null.
    expect(
      refereeCallWinner(
        ROSTER,
        rally(1, {
          serving_team_id: observed("A"),
          referee_call: { value: "point", certainty: "unknown" },
        }),
      ),
    ).toBeNull();
    expect(
      refereeCallWinner(
        ROSTER,
        rally(1, {
          serving_team_id: { value: "A", certainty: "unknown" },
          referee_call: observed("point"),
        }),
      ),
    ).toBeNull();
    // Non-Roster team ID returns null instead of silently mapping to teamA.
    expect(
      refereeCallWinner(
        ROSTER,
        rally(1, { serving_team_id: observed("unknown-team"), referee_call: observed("side_out") }),
      ),
    ).toBeNull();
  });
});

describe("shared side-out helpers", () => {
  it.each([
    {
      name: "Point increments serving score and flips the serving box",
      from: score(3, 2, 1),
      serving: "A",
      winner: "A",
      expected: { outcome: "point", score: score(4, 2, 1), serving_team_id: "A", box: "flip" },
    },
    {
      name: "Second server advances 1 -> 2 and flips the serving box",
      from: score(3, 2, 1),
      serving: "A",
      winner: "B",
      expected: {
        outcome: "second_server",
        score: score(3, 2, 2),
        serving_team_id: "A",
        box: "flip",
      },
    },
    {
      name: "Side out swaps score, switches Serving Team, and resets to the right box",
      from: score(3, 2, 2),
      serving: "A",
      winner: "B",
      expected: {
        outcome: "side_out",
        score: score(2, 3, 1),
        serving_team_id: "B",
        box: "right",
      },
    },
  ])("nextSideoutState: $name", ({ from, serving, winner, expected }) => {
    expect(nextSideoutState(ROSTER, from, serving, winner)).toEqual(expected);
  });

  it("nextSideoutOutcomes returns both Point and loss successors", () => {
    const [win, loss] = nextSideoutOutcomes(ROSTER, score(0, 0, 2), "A");
    expect(win).toEqual({
      outcome: "point",
      score: score(1, 0, 2),
      serving_team_id: "A",
      box: "flip",
    });
    expect(loss).toEqual({
      outcome: "side_out",
      score: score(0, 0, 1),
      serving_team_id: "B",
      box: "right",
    });
  });

  it("applyBoxStep, boxParityPlayer, isOpeningScore, and sameScore behave as documented", () => {
    expect(applyBoxStep("right", null)).toBe("right");
    expect(applyBoxStep("right", "left")).toBe("right");
    expect(applyBoxStep("flip", "right")).toBe("left");
    expect(applyBoxStep("flip", "left")).toBe("right");
    expect(applyBoxStep("flip", null)).toBeNull();

    // Even score + right box -> same Player; odd score + right box -> partner; symmetric inverse.
    expect(boxParityPlayer(ROSTER, "a1", 0, "right")).toBe("a1");
    expect(boxParityPlayer(ROSTER, "a1", 1, "right")).toBe("a2");
    expect(boxParityPlayer(ROSTER, "a1", 0, "left")).toBe("a2");
    expect(boxParityPlayer(ROSTER, "a1", 1, "left")).toBe("a1");
    expect(boxParityPlayer(ROSTER, "a2", 0, "left")).toBe("a1");

    expect(isOpeningScore(score(0, 0, 2))).toBe(true);
    expect(isOpeningScore(score(0, 0, 1))).toBe(false);
    expect(sameScore(score(4, 2, 1), score(4, 2, 1))).toBe(true);
    expect(sameScore(score(4, 2, 1), score(4, 2, 2))).toBe(false);
  });
});
