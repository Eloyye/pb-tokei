import { describe, expect, it } from "vitest";
import type { Game, Rally, Shot, ShotPosition } from "../api/client";
import {
  type AnnotateContext,
  type AnnotateEdit,
  addShot,
  cycleCertainty,
  deleteEntry,
  deleteGame,
  deleteRally,
  deselectSelection,
  insertUnseenRally,
  markRallyDone,
  markRallyEnd,
  markRallyStart,
  moveContact,
  moveRallyEdge,
  moveShotPosition,
  NO_SELECTION,
  nextRallySelection,
  nextShotSelection,
  type Selection,
  selectedRally,
  selectedShot,
  setError,
  setLanding,
  setRallyDetails,
  setRallyEdge,
  setRefereeCall,
  splitRally,
  startNextGame,
  swapHitterToPartner,
  swapShotTeammates,
  switchHitterTeam,
  toggleGap,
  toggleRally,
  toggleShot,
} from "./annotate";
import { commit, startHistory, undo } from "./history";
import { inferred, newRally, newShot, numberShots, observed, UNKNOWN } from "./rallyLog";
import { checkMatch } from "./ruleChecks";
import { ROSTER } from "./testRoster";

function ctx(games: Game[] = [], selection: Selection = NO_SELECTION, frame = 0): AnnotateContext {
  return { games, selection, roster: ROSTER, frame };
}

/** Applies edits in order at the given frames, as the keys would. */
function run(steps: [number, (c: AnnotateContext) => AnnotateEdit][]): AnnotateEdit {
  let state: AnnotateEdit = { games: [], selection: NO_SELECTION, message: "" };
  for (const [frame, step] of steps) state = step(ctx(state.games, state.selection, frame));
  return state;
}

const at = (x: number, y: number): ShotPosition => ({
  position: observed({ x, y }),
  settled: inferred(Math.abs(y) <= 9),
});

const snapshot: Record<string, ShotPosition> = {
  a1: at(-5, -21),
  a2: at(5, -20),
  b1: at(4, 21),
  b2: at(-3, 4),
};

function shotAt(edit: AnnotateEdit, index: number): Shot {
  const entry = selectedRally(edit.games, edit.selection)!.entries[index];
  if (entry?.type !== "shot") throw new Error(`entry ${index} isn't a Shot`);
  return entry;
}

describe("framing Rallies", () => {
  it("Shift+I starts Game 1's Rally 1 open-ended at 0-0-2 and Shift+O closes it", () => {
    const started = run([[100, markRallyStart]]);
    expect(started.games).toHaveLength(1);
    const rally = selectedRally(started.games, started.selection)!;
    expect(rally).toMatchObject({ number: 1, start_frame: 100, end_frame: null, status: "empty" });
    expect(rally.score).toEqual(inferred({ serving: 0, receiving: 0, server_number: 2 }));

    const ended = run([
      [100, markRallyStart],
      [400, markRallyEnd],
    ]);
    expect(selectedRally(ended.games, ended.selection)).toMatchObject({
      start_frame: 100,
      end_frame: 400,
      status: "in_progress",
    });
  });

  it("refuses to end a Rally before it starts", () => {
    const edit = run([
      [100, markRallyStart],
      [50, markRallyEnd],
    ]);
    expect(selectedRally(edit.games, edit.selection)!.end_frame).toBeNull();
    expect(edit.message).toMatch(/can't end before it starts/);
  });

  it("starts the next Rally past the end, moves the start inside, and keeps Rallies apart", () => {
    const two = run([
      [100, markRallyStart],
      [400, markRallyEnd],
      [600, markRallyStart],
      [900, markRallyEnd],
    ]);
    const game = two.games[0]!;
    expect(game.rallies.map((r) => [r.number, r.start_frame, r.end_frame])).toEqual([
      [1, 100, 400],
      [2, 600, 900],
    ]);

    // Moving Rally 2's start inside Rally 1 is refused.
    const overlap = markRallyStart(ctx(two.games, two.selection, 300));
    expect(overlap.games).toBe(two.games);
    expect(overlap.message).toMatch(/inside G1 R1/);

    // Moving it within its own frames works.
    const moved = markRallyStart(ctx(two.games, two.selection, 650));
    expect(moved.games[0]!.rallies[1]!.start_frame).toBe(650);

    // A new Rally before Rally 1 is placed (and numbered) first.
    const early = markRallyStart(ctx(two.games, NO_SELECTION, 20));
    expect(early.games[0]!.rallies.map((r) => r.start_frame)).toEqual([20, 100, 600]);
    expect(early.selection.rally).toBe(0);
  });

  it("inserts Unseen Rallies, starts Game 2, deletes Rallies and empty Games", () => {
    const edit = run([
      [100, markRallyStart],
      [400, markRallyEnd],
      [400, insertUnseenRally],
    ]);
    const rallies = edit.games[0]!.rallies;
    expect(rallies).toHaveLength(2);
    expect(rallies[1]).toMatchObject({ number: 2, start_frame: null, end_frame: null });

    const game2 = startNextGame(ctx(edit.games, edit.selection));
    expect(game2.games.map((g) => g.number)).toEqual([1, 2]);
    expect(game2.selection).toEqual({ game: 1, rally: null, entry: null });
    const rally1 = markRallyStart(ctx(game2.games, game2.selection, 2000));
    expect(rally1.games[1]!.rallies[0]!.score.value).toEqual({
      serving: 0,
      receiving: 0,
      server_number: 2,
    });

    expect(deleteGame(ctx(game2.games, game2.selection), 1).games).toHaveLength(1);
    expect(deleteGame(ctx(game2.games, game2.selection), 0).message).toMatch(/still has Rallies/);

    const deleted = deleteRally(ctx(edit.games, edit.selection));
    expect(deleted.games[0]!.rallies).toHaveLength(1);
  });

  it("Enter marks the Rally Done and moves on", () => {
    const edit = run([
      [100, markRallyStart],
      [400, markRallyEnd],
      [600, markRallyStart],
      [900, markRallyEnd],
    ]);
    const first = { game: 0, rally: 0, entry: null };
    const done = markRallyDone(ctx(edit.games, first));
    expect(done.games[0]!.rallies[0]!.status).toBe("done");
    expect(done.selection.rally).toBe(1);
    const last = markRallyDone(ctx(done.games, done.selection));
    expect(last.selection.rally).toBe(1);
    expect(last.message).toMatch(/Space plays on/);
  });

  it("navigates Rallies across Games and Shots within a Rally", () => {
    const edit = run([
      [100, markRallyStart],
      [150, (c) => addShot(c, null)],
      [180, (c) => addShot(c, null)],
      [400, markRallyEnd],
      [0, startNextGame],
      [2000, markRallyStart],
    ]);
    const start = { game: 0, rally: 0, entry: 0 };
    expect(nextShotSelection(edit.games, start, 1)).toEqual({ ...start, entry: 1 });
    expect(nextShotSelection(edit.games, { ...start, entry: 1 }, 1)).toBeUndefined();
    expect(nextRallySelection(edit.games, start, 1)).toEqual({ game: 1, rally: 0, entry: null });
    expect(nextRallySelection(edit.games, { game: 1, rally: 0, entry: null }, -1)).toEqual(start);
  });

  it("toggles Shot and Rally selection and steps back with Esc", () => {
    const edit = run([
      [100, markRallyStart],
      [150, (c) => addShot(c, null)],
      [180, (c) => addShot(c, null)],
      [400, markRallyEnd],
      [0, startNextGame],
      [2000, markRallyStart],
      [2050, (c) => addShot(c, null)],
    ]);
    const shot1: Selection = { game: 0, rally: 0, entry: 0 };

    // Clicking the selected Shot deselects it and keeps the Rally.
    expect(toggleShot(shot1, 0, 0, 0)).toEqual({ game: 0, rally: 0, entry: null });
    // Clicking another Shot selects it.
    expect(toggleShot(shot1, 0, 0, 1)).toEqual({ game: 0, rally: 0, entry: 1 });
    // Clicking a Shot when only the Rally is selected selects it.
    expect(toggleShot({ game: 0, rally: 0, entry: null }, 0, 0, 1)).toEqual({
      game: 0,
      rally: 0,
      entry: 1,
    });

    // Clicking the selected Rally clears both Rally and Shot while keeping the active Game.
    expect(toggleRally(edit.games, { game: 1, rally: 0, entry: 0 }, 1, 0)).toEqual({
      game: 1,
      rally: null,
      entry: null,
    });
    // Clicking another Rally selects it and its first Shot.
    expect(toggleRally(edit.games, { game: 1, rally: 0, entry: 0 }, 0, 0)).toEqual({
      game: 0,
      rally: 0,
      entry: 0,
    });

    // Esc steps from Shot → Rally → nothing (keeping active Game), then stays unchanged.
    const afterFirstEsc = deselectSelection({ game: 1, rally: 0, entry: 0 });
    expect(afterFirstEsc).toEqual({ game: 1, rally: 0, entry: null });
    const afterSecondEsc = deselectSelection(afterFirstEsc);
    expect(afterSecondEsc).toEqual({ game: 1, rally: null, entry: null });
    expect(deselectSelection(afterSecondEsc)).toBe(afterSecondEsc);
  });

  it("Referee Calls set the winner, and the same call again clears it", () => {
    const edit = run([
      [100, markRallyStart],
      [100, (c) => setRefereeCall(c, "side_out")],
    ]);
    const rally = selectedRally(edit.games, edit.selection)!;
    expect(rally.referee_call).toEqual(observed("side_out"));
    const cleared = setRefereeCall(ctx(edit.games, edit.selection), "side_out");
    expect(selectedRally(cleared.games, cleared.selection)!.referee_call).toEqual(UNKNOWN);
  });
});

describe("dragging Rally edges", () => {
  const selection = { game: 1, rally: 1, entry: null };
  const rally = numberShots({
    ...newRally(2, 300),
    end_frame: 500,
    entries: [newShot(330), newShot(480)],
  });
  function gamesWith(target = rally): Game[] {
    return [
      { number: 1, rallies: [{ ...newRally(1, 100), end_frame: 200 }] },
      { number: 2, rallies: [newRally(1), target] },
      { number: 3, rallies: [newRally(1, 600)] },
    ];
  }

  it.each([
    ["start", 100, 201, "Stopped after G1 R1 (frame 201)"],
    ["start", 450, 330, "Stopped at Shot 1's contact (frame 330)"],
    ["end", 400, 480, "Stopped at Shot 2's contact (frame 480)"],
    ["end", 650, 599, "Stopped before G3 R1 (frame 599)"],
  ] as const)("clamps the %s at frame %i to %i", (edge, target, frame, reason) => {
    expect(moveRallyEdge(gamesWith(), selection, edge, target)).toEqual({ frame, reason });
  });

  it("moves freely within the limits and stops at the other edge when there are no Shots", () => {
    const games = gamesWith({ ...rally, entries: [] });
    expect(moveRallyEdge(games, selection, "start", 390)).toEqual({ frame: 390, reason: null });
    expect(moveRallyEdge(games, selection, "start", 550)).toEqual({
      frame: 500,
      reason: "Stopped at this Rally's end (frame 500)",
    });
    expect(moveRallyEdge(games, selection, "end", 250)).toEqual({
      frame: 300,
      reason: "Stopped at this Rally's start (frame 300)",
    });
  });

  it("offers only the start edge on an open-ended Rally and neither edge on an Unseen Rally", () => {
    const games = gamesWith({ ...rally, end_frame: null });
    expect(moveRallyEdge(games, selection, "start", 320)).toEqual({ frame: 320, reason: null });
    expect(moveRallyEdge(games, selection, "start", 450).frame).toBe(330);
    expect(moveRallyEdge(games, selection, "end", 450).frame).toBeNull();
    expect(moveRallyEdge(games, { ...selection, rally: 0 }, "start", 250).frame).toBeNull();
  });

  it("keeps a start edge after an earlier open-ended Rally's start", () => {
    const games: Game[] = [
      {
        number: 1,
        rallies: [{ ...newRally(1, 0), end_frame: 40 }, newRally(2, 100), { ...rally, number: 3 }],
      },
    ];
    expect(moveRallyEdge(games, { game: 0, rally: 2, entry: null }, "start", 50)).toEqual({
      frame: 101,
      reason: "Stopped after the start of G1 R2 (frame 101)",
    });
  });

  it("stops at frame zero and respects an unnumbered Shot's known contact", () => {
    const games = [{ number: 1, rallies: [{ ...rally, entries: [newShot(330)] }] }];
    const first = { game: 0, rally: 0, entry: null };
    expect(moveRallyEdge(games, first, "start", -10)).toEqual({
      frame: 0,
      reason: "Stopped at the start of the video (frame 0)",
    });
    expect(moveRallyEdge(games, first, "start", 400)).toEqual({
      frame: 330,
      reason: "Stopped at a Shot's contact (frame 330)",
    });
  });

  it("commits a clamped frame and keeps the selected Shot", () => {
    const games = gamesWith();
    const pickedShot = { ...selection, entry: 1 };
    const edit = setRallyEdge(ctx(games, pickedShot), "start", 450);
    expect(edit.selection).toEqual(pickedShot);
    expect(selectedRally(edit.games, pickedShot)).toMatchObject({
      start_frame: 330,
      end_frame: 500,
      status: "in_progress",
    });
    expect(selectedRally(games, pickedShot)?.start_frame).toBe(300);
  });

  it("leaves the Rally alone if no end frame fits between the last Shot and next Rally", () => {
    const games = gamesWith({ ...rally, entries: [newShot(620)] });
    const edit = setRallyEdge(ctx(games, selection), "end", 580);
    expect(edit.games).toBe(games);
    expect(edit.message).toBe("No frame fits this Rally's end limits");
  });

  it("keeps Shift+O's warning for an end before the last Shot", () => {
    const edit = markRallyEnd(ctx(gamesWith(), selection, 400));
    expect(selectedRally(edit.games, selection)?.end_frame).toBe(400);
    expect(edit.message).toContain("before its last Shot (frame 480)");
  });
});

describe("Split Rally at playhead", () => {
  it("cuts [start, end] into [start, T-1] and [T, end] (including T === end) and rejects invalid bounds", () => {
    const base = run([
      [100, markRallyStart],
      [400, markRallyEnd],
    ]);

    // T <= start and T > end are no-ops with clear reasons.
    for (const [frame, pattern] of [
      [50, /past this Rally’s start \(frame 100\)/],
      [100, /past this Rally’s start \(frame 100\)/],
      [401, /to or before this Rally’s end \(frame 400\)/],
    ] as const) {
      const rejected = splitRally(ctx(base.games, base.selection, frame));
      expect(rejected.games).toBe(base.games);
      expect(rejected.selection).toEqual(base.selection);
      expect(rejected.message).toMatch(pattern);
    }

    // No Rally selected or Unseen Rally or 1-frame Rally are no-ops.
    expect(splitRally(ctx(base.games, NO_SELECTION, 250)).message).toBe("Select a Rally first");
    const unseen: Game[] = [{ number: 1, rallies: [newRally(1)] }];
    expect(splitRally(ctx(unseen, { game: 0, rally: 0, entry: null }, 250)).message).toBe(
      "An Unseen Rally has no frames",
    );
    const singleFrame: Game[] = [{ number: 1, rallies: [{ ...newRally(1, 100), end_frame: 100 }] }];
    expect(splitRally(ctx(singleFrame, { game: 0, rally: 0, entry: null }, 100)).message).toBe(
      "This Rally is only one frame long",
    );

    // Mid-Rally split: [100, 249] and [250, 400], both In progress, selects the second Rally.
    const mid = splitRally(ctx(base.games, base.selection, 250));
    expect(
      mid.games[0]!.rallies.map((r) => [r.number, r.start_frame, r.end_frame, r.status]),
    ).toEqual([
      [1, 100, 249, "in_progress"],
      [2, 250, 400, "in_progress"],
    ]);
    expect(mid.selection).toEqual({ game: 0, rally: 1, entry: null });
    expect(mid.message).toBe("Split Rally: G1 R1 (100–249) and G1 R2 (250–400)");

    // Split at T === end: [100, 399] and 1-frame [400, 400].
    const atEnd = splitRally(ctx(base.games, base.selection, 400));
    expect(atEnd.games[0]!.rallies.map((r) => [r.start_frame, r.end_frame])).toEqual([
      [100, 399],
      [400, 400],
    ]);
  });

  it("splits an open-ended Rally leaving the second open-ended and prevents overlapping a later Rally", () => {
    const open = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, null)],
      [280, (c) => addShot(c, null)],
    ]);
    const split = splitRally(ctx(open.games, open.selection, 200));
    expect(split.games[0]!.rallies.map((r) => [r.start_frame, r.end_frame, r.status])).toEqual([
      [100, 199, "in_progress"],
      [200, null, "in_progress"],
    ]);
    expect(split.games[0]!.rallies[0]!.entries).toHaveLength(1);
    expect(split.games[0]!.rallies[1]!.entries).toHaveLength(1);
    expect(split.message).toBe("Split Rally: G1 R1 (100–199) and G1 R2 (200–…)");

    // With a later Rally at frame 500, splitting at >= 500 is refused while 499 succeeds.
    const withNext: Game[] = [
      {
        number: 1,
        rallies: [open.games[0]!.rallies[0]!, { ...newRally(2, 500), end_frame: 700 }],
      },
    ];
    const overlap = splitRally(ctx(withNext, { game: 0, rally: 0, entry: null }, 500));
    expect(overlap.games).toBe(withNext);
    expect(overlap.message).toBe("Rallies can't overlap: G1 R2 starts at frame 500");

    const tight: Game[] = [
      {
        number: 1,
        rallies: [newRally(1, 100), { ...newRally(2, 101), end_frame: 200 }],
      },
    ];
    expect(splitRally(ctx(tight, { game: 0, rally: 0, entry: null }, 100)).message).toBe(
      "No room to Split Rally before G1 R2 (frame 101)",
    );

    const beforeNext = splitRally(ctx(withNext, { game: 0, rally: 0, entry: null }, 499));
    expect(beforeNext.games[0]!.rallies.map((r) => [r.number, r.start_frame, r.end_frame])).toEqual(
      [
        [1, 100, 498],
        [2, 499, null],
        [3, 500, 700],
      ],
    );
  });

  it("assigns Shots by contact frame (>= T to second) and keeps Observation Gaps at the split with the first", () => {
    const rally = numberShots({
      ...newRally(1, 100),
      end_frame: 400,
      entries: [
        newShot(120),
        { type: "gap", missing: "odd" },
        newShot(200),
        { type: "gap", missing: "even" },
        newShot(260),
      ],
    });
    const games: Game[] = [{ number: 1, rallies: [rally] }];
    const split = splitRally(ctx(games, { game: 0, rally: 0, entry: null }, 200));
    const [first, second] = split.games[0]!.rallies;
    // Shot 120 and the Gap sitting right at the split stay with the first Rally.
    expect(
      first!.entries.map((e) => (e.type === "shot" ? e.contact_frame.value : e.missing)),
    ).toEqual([120, "odd"]);
    // Shot at exactly T = 200 goes to the second Rally, along with the Gap after it and Shot 260.
    expect(
      second!.entries.map((e) => (e.type === "shot" ? e.contact_frame.value : e.missing)),
    ).toEqual([200, "even", 260]);
    // Shot 200 (previously after the odd gap -> Unknown number) becomes Shot 1; Shot 260 stays Unknown after the even gap.
    const secondShots = second!.entries.filter((e) => e.type === "shot");
    expect(secondShots.map((s) => s.shot_number)).toEqual([observed(1), UNKNOWN]);

    // A leading Observation Gap stays with the first Rally when all Shots are >= T.
    const leadGapRally = numberShots({
      ...newRally(1, 100),
      end_frame: 400,
      entries: [{ type: "gap", missing: "odd" }, newShot(250), newShot(300)],
    });
    const leadSplit = splitRally(
      ctx([{ number: 1, rallies: [leadGapRally] }], { game: 0, rally: 0, entry: null }, 200),
    );
    expect(leadSplit.games[0]!.rallies[0]!.entries).toEqual([{ type: "gap", missing: "odd" }]);
    const leadSecondShots = leadSplit.games[0]!.rallies[1]!.entries as Shot[];
    expect(leadSecondShots.map((s) => s.shot_number.value)).toEqual([1, 2]);
  });

  it("distributes start and end facts, marks both In progress, fills second via side-out, and cascades later Rallies", () => {
    const challenge = {
      challenger_id: observed("b1"),
      original_call: observed("Out"),
      ruling: observed("upheld" as const),
    };
    const combined = numberShots({
      ...newRally(1, 100),
      end_frame: 500,
      status: "done",
      score: observed({ serving: 0, receiving: 0, server_number: 2 }),
      serving_team_id: observed("A"),
      server_id: observed("a1"),
      returner_id: observed("b1"),
      referee_call: observed("side_out"),
      challenge,
      scoreboard_winner_id: observed("B"),
      winner_id: observed("B"),
      winner_source: "challenge",
      entries: [
        { ...newShot(120), hitter_id: inferred("a1") },
        {
          ...newShot(160),
          hitter_id: inferred("b1"),
          contact_kind: inferred("bounce"),
          // Rally 1 actually ended here with b1's Net Error -> Team A won a Point (0-0-2 -> 1-0-2).
          error: { kind: observed("net"), player_id: observed("b1") },
        },
        { ...newShot(260), hitter_id: inferred("a1"), contact_kind: inferred("bounce") },
        { ...newShot(310), hitter_id: inferred("b1") },
        { ...newShot(360), hitter_id: inferred("a1") },
      ],
    });
    const laterInferred: Rally = {
      ...newRally(2, 600),
      end_frame: 800,
      status: "done",
      score: inferred({ serving: 0, receiving: 0, server_number: 1 }),
      serving_team_id: inferred("B"),
      server_id: inferred("b1"),
      returner_id: inferred("a1"),
      referee_call: observed("point"),
    };
    const laterObserved: Rally = {
      ...newRally(3, 900),
      end_frame: 1100,
      status: "done",
      score: observed({ serving: 5, receiving: 5, server_number: 1 }),
      serving_team_id: inferred("B"),
      server_id: observed("b2"),
      returner_id: inferred("a2"),
    };
    const games: Game[] = [{ number: 1, rallies: [combined, laterInferred, laterObserved] }];

    const split = splitRally(ctx(games, { game: 0, rally: 0, entry: 0 }, 260));
    const [r1, r2, r3, r4] = split.games[0]!.rallies;
    expect(split.games[0]!.rallies.map((r) => r.number)).toEqual([1, 2, 3, 4]);

    // First Rally keeps start facts, clears end facts, becomes In progress, resolves winner from Shot 2 Error.
    expect(r1).toMatchObject({
      number: 1,
      start_frame: 100,
      end_frame: 259,
      status: "in_progress",
      score: observed({ serving: 0, receiving: 0, server_number: 2 }),
      serving_team_id: observed("A"),
      server_id: observed("a1"),
      returner_id: observed("b1"),
      referee_call: UNKNOWN,
      challenge: null,
      scoreboard_winner_id: UNKNOWN,
      winner_id: inferred("A"),
      winner_source: "play",
    });

    // Second Rally gets end facts, becomes In progress, and side-out pre-fills 1-0-2 A a1->b2 (Inferred).
    expect(r2).toMatchObject({
      number: 2,
      start_frame: 260,
      end_frame: 500,
      status: "in_progress",
      score: inferred({ serving: 1, receiving: 0, server_number: 2 }),
      serving_team_id: inferred("A"),
      server_id: inferred("a1"),
      returner_id: inferred("b2"),
      referee_call: observed("side_out"),
      challenge,
      scoreboard_winner_id: observed("B"),
      winner_id: observed("B"),
      winner_source: "challenge",
    });

    // Second Rally's Shots renumber 1..3 and recompute Inferred hitters (b2 Returner!) & Contact Kinds.
    const r2Shots = r2!.entries as Shot[];
    expect(r2Shots.map((s) => s.shot_number.value)).toEqual([1, 2, 3]);
    expect(r2Shots.map((s) => s.hitter_id)).toEqual([
      inferred("a1"),
      inferred("b2"),
      inferred("a1"),
    ]);
    expect(r2Shots.map((s) => s.contact_kind)).toEqual([
      UNKNOWN,
      inferred("bounce"),
      inferred("bounce"),
    ]);

    // Later Rallies renumber and cascade from r2 (1-0-2 side out -> 0-1-1 B b1->a2), preserving Observed facts.
    expect(r3).toMatchObject({
      number: 3,
      status: "done",
      score: inferred({ serving: 0, receiving: 1, server_number: 1 }),
      serving_team_id: inferred("B"),
      server_id: inferred("b1"),
      returner_id: inferred("a2"),
    });
    expect(r4).toMatchObject({
      number: 4,
      status: "done",
      // Observed score and server survive; non-Observed facts recompute from r3's Point (B wins -> 1-1-1, Returner flips a2 -> a1).
      score: observed({ serving: 5, receiving: 5, server_number: 1 }),
      serving_team_id: inferred("B"),
      server_id: observed("b2"),
      returner_id: inferred("a1"),
    });
  });

  it("moves a manual Observed play winner to the second Rally and keeps Observed Shot facts untouched for rule checks", () => {
    const manualRally = numberShots({
      ...newRally(1, 100),
      end_frame: 400,
      score: observed({ serving: 0, receiving: 0, server_number: 2 }),
      serving_team_id: observed("A"),
      server_id: observed("a1"),
      returner_id: observed("b1"),
      winner_id: observed("A"),
      winner_source: "play",
      entries: [
        // Shot 1 ends the first Rally with b1's Body Hit -> Team A wins a Point, so second Rally pre-fills Serving Team A (Server a1).
        {
          ...newShot(120),
          hitter_id: observed("a1"),
          error: { kind: observed("body_hit"), player_id: observed("b1") },
        },
        // Old Shot 2 (Inferred Bounce) becomes new Shot 1 -> Contact Kind becomes Unknown, hitter flips to Server a1.
        {
          ...newShot(200),
          hitter_id: inferred("b1"),
          contact_kind: inferred("bounce"),
          positions: snapshot,
          contact_zone: observed("backcourt"),
        },
        // Old Shot 3 with Observed Volley and Observed wrong-Team hitter (a2) becomes new Shot 2 -> preserved so rule checks flag both!
        {
          ...newShot(250),
          hitter_id: observed("a2"),
          contact_kind: observed("volley"),
          shot_class: observed("hard"),
          erne: observed(true),
          atp: observed(true),
          landing: observed({ x: 3, y: 12 }),
          positions: snapshot,
          contact_zone: observed("midcourt"),
          error: { kind: observed("out"), player_id: observed("a2") },
        },
        // Old Shot 4 with Inferred hitter and Inferred Error player aligns to new alternating hitter.
        {
          ...newShot(300),
          hitter_id: inferred("a1"),
          contact_kind: UNKNOWN,
          positions: snapshot,
          contact_zone: observed("backcourt"),
          error: { kind: observed("net"), player_id: inferred("a1") },
        },
      ],
    });
    const games: Game[] = [{ number: 1, rallies: [manualRally] }];
    const split = splitRally(ctx(games, { game: 0, rally: 0, entry: 0 }, 200));
    const [r1, r2] = split.games[0]!.rallies;

    expect(r1!.winner_id).toEqual(inferred("A"));
    expect(r1!.winner_source).toBe("play");
    // Manual Observed play winner moved to r2 and survived normalizeGame (outranks r2's last-Shot Error).
    expect(r2!.winner_id).toEqual(observed("A"));
    expect(r2!.winner_source).toBe("play");

    const [s1, s2, s3] = r2!.entries as Shot[];
    expect(s1!.shot_number).toEqual(observed(1));
    expect(s1!.hitter_id).toEqual(inferred("a1"));
    expect(s1!.contact_kind).toEqual(UNKNOWN);
    expect(s1!.contact_zone).toEqual(observed("backcourt"));

    // All Observed facts on new Shot 2 survive untouched.
    expect(s2!.shot_number).toEqual(observed(2));
    expect(s2!.hitter_id).toEqual(observed("a2"));
    expect(s2!.contact_kind).toEqual(observed("volley"));
    expect(s2!.shot_class).toEqual(observed("hard"));
    expect(s2!.erne).toEqual(observed(true));
    expect(s2!.atp).toEqual(observed(true));
    expect(s2!.landing).toEqual(observed({ x: 3, y: 12 }));
    expect(s2!.contact_zone).toEqual(observed("midcourt"));
    expect(s2!.error).toEqual({ kind: observed("out"), player_id: observed("a2") });

    // New Shot 3 alternates from Observed Shot 2 (Team A -> Team B = b1), gets Inferred Bounce,
    // updates its position-derived Contact Zone and Inferred Error player.
    expect(s3!.shot_number).toEqual(observed(3));
    expect(s3!.hitter_id).toEqual(inferred("b1"));
    expect(s3!.contact_kind).toEqual(inferred("bounce"));
    expect(s3!.error).toEqual({ kind: observed("net"), player_id: inferred("b1") });

    // Rule checks flag the Observed Volley on Shot 2 (two-bounce rule) and wrong-Team Shot 2!
    const issues = checkMatch(split.games, ROSTER).filter((i) => i.rallyIndex === 1);
    expect(issues.some((i) => i.code === "two_bounce_rule" && i.entryIndex === 1)).toBe(true);
    expect(issues.some((i) => i.code === "team_alternation" && i.entryIndex === 1)).toBe(true);
  });

  it("clears first Rally's manual winner when no Error remains and infers opposite Server from Observed Shot 2 when Serving Team is Unknown", () => {
    const rally = numberShots({
      ...newRally(1, 100),
      end_frame: 400,
      winner_id: observed("B"),
      winner_source: "play",
      entries: [
        { ...newShot(120), hitter_id: inferred("a1") },
        { ...newShot(200), hitter_id: inferred("a1") },
        { ...newShot(250), hitter_id: observed("a2") },
      ],
    });
    const split = splitRally(
      ctx([{ number: 1, rallies: [rally] }], { game: 0, rally: 0, entry: 0 }, 200),
    );
    const [r1, r2] = split.games[0]!.rallies;
    expect(r1!.winner_id).toEqual(UNKNOWN);
    expect(r1!.winner_source).toBeNull();
    expect(r2!.winner_id).toEqual(observed("B"));
    expect(r2!.winner_source).toBe("play");
    expect(r2!.score).toEqual(UNKNOWN);
    expect(r2!.returner_id).toEqual(inferred("a2"));
    const [s1, s2] = r2!.entries as Shot[];
    expect(s1!.hitter_id).toEqual(inferred("b1"));
    expect(s2!.hitter_id).toEqual(observed("a2"));
  });

  it("restores the original Rally exactly in a single undo step without mutating prior state", () => {
    const initial = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [170, (c) => addShot(c, snapshot)],
      [250, (c) => addShot(c, snapshot)],
      [300, (c) => addShot(c, snapshot)],
      [400, markRallyEnd],
      [400, (c) => setRefereeCall(c, "point")],
      [400, markRallyDone],
    ]);
    const beforeSnapshot = structuredClone(initial.games);
    const history = startHistory(initial.games);
    const split = splitRally(ctx(history.present, { game: 0, rally: 0, entry: 0 }, 250));
    const afterSplit = commit(history, split.games);
    expect(afterSplit.present[0]!.rallies).toHaveLength(2);
    // Original state was not mutated.
    expect(history.present).toEqual(beforeSnapshot);
    // One undo step restores the original Rally exactly (including status "done", frames, Shots, facts).
    const undone = undo(afterSplit);
    expect(undone.present).toEqual(beforeSnapshot);
    expect(undone.past).toHaveLength(0);
  });
});

describe("Shot entry", () => {
  it("M snapshots positions, defaults hitters by alternating Teams and infers Bounce", () => {
    const edit = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [170, (c) => addShot(c, snapshot)],
      [230, (c) => addShot(c, snapshot)],
      [290, (c) => addShot(c, snapshot)],
    ]);
    const shots = selectedRally(edit.games, edit.selection)!.entries as Shot[];
    expect(shots.map((s) => s.shot_number.value)).toEqual([1, 2, 3, 4]);
    expect(shots.map((s) => s.hitter_id.value)).toEqual(["a1", "b1", "a1", "b1"]);
    expect(shots.every((s) => s.hitter_id.certainty === "inferred")).toBe(true);
    expect(shots.map((s) => s.contact_kind)).toEqual([
      UNKNOWN,
      inferred("bounce"),
      inferred("bounce"),
      UNKNOWN,
    ]);
    expect(shots[0]!.erne).toEqual(observed(false));
    expect(shots[0]!.error).toBeNull();
    expect(shots[0]!.positions.a1).toEqual(snapshot.a1);
    expect(shots[0]!.contact_zone).toEqual(observed("backcourt"));
    expect(edit.selection.entry).toBe(3);
  });

  it("leaves positions Unknown without Player Tracking, and refuses bad frames", () => {
    const edit = run([
      [100, markRallyStart],
      [400, markRallyEnd],
      [150, (c) => addShot(c, null)],
    ]);
    const shot = selectedShot(edit.games, edit.selection)!;
    expect(Object.values(shot.positions).every((p) => p.position.certainty === "unknown")).toBe(
      true,
    );
    expect(shot.contact_zone).toEqual(UNKNOWN);
    expect(addShot(ctx(edit.games, edit.selection, 150), null).message).toMatch(/already a Shot/);
    expect(addShot(ctx(edit.games, edit.selection, 50), null).message).toMatch(/starts at frame/);
    expect(addShot(ctx(edit.games, edit.selection, 500), null).message).toMatch(/ends at frame/);
    expect(addShot(ctx([], NO_SELECTION, 50), null).message).toMatch(/Shift\+I/);
  });

  it("X swaps to the partner and Shift+H to the other Team, both Observed", () => {
    const edit = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [120, swapHitterToPartner],
    ]);
    const serve = selectedShot(edit.games, edit.selection)!;
    expect(serve.hitter_id).toEqual(observed("a2"));
    expect(serve.contact_zone).toEqual(observed("backcourt"));
    // Shot 1's Observed hitter becomes the Server.
    expect(selectedRally(edit.games, edit.selection)!.server_id).toEqual(inferred("a2"));
    const other = switchHitterTeam(ctx(edit.games, edit.selection));
    expect(selectedShot(other.games, other.selection)!.hitter_id).toEqual(observed("b1"));
  });

  it("Observation Gaps make later Shot Numbers Unknown and shift the expected Team", () => {
    const edit = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, null)],
      [120, (c) => toggleGap(c, "odd")],
      [300, (c) => addShot(c, null)],
    ]);
    const entries = selectedRally(edit.games, edit.selection)!.entries;
    expect(entries.map((e) => e.type)).toEqual(["shot", "gap", "shot"]);
    const after = shotAt(edit, 2);
    expect(after.shot_number).toEqual(UNKNOWN);
    // One missing Shot (odd): the same Team as Shot 1 hits next.
    expect(after.hitter_id.value).toBe("a1");

    // Same key removes, the other key flips.
    const onFirst = { ...edit.selection, entry: 0 };
    const flipped = toggleGap(ctx(edit.games, onFirst), "even");
    expect(selectedRally(flipped.games, flipped.selection)!.entries[1]).toEqual({
      type: "gap",
      missing: "even",
    });
    const removed = toggleGap(ctx(edit.games, onFirst), "odd");
    expect(selectedRally(removed.games, removed.selection)!.entries.map((e) => e.type)).toEqual([
      "shot",
      "shot",
    ]);
  });

  it("puts a leading gap before any Shot", () => {
    const edit = run([
      [100, markRallyStart],
      [100, (c) => toggleGap(c, "even")],
      [300, (c) => addShot(c, null)],
    ]);
    const entries = selectedRally(edit.games, edit.selection)!.entries;
    expect(entries[0]).toEqual({ type: "gap", missing: "even" });
    const shot = shotAt(edit, 1);
    expect(shot.shot_number).toEqual(UNKNOWN);
    expect(shot.hitter_id.value).toBe("a1");
  });

  it("Body Hit defaults to the opponent nearest the landing and repeats cycle opponents", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [120, (c) => setLanding(c, { x: -3, y: 6 })],
      [120, (c) => setError(c, "body_hit")],
    ]);
    const error = selectedShot(base.games, base.selection)!.error!;
    expect(error.kind).toEqual(observed("body_hit"));
    expect(error.player_id).toEqual(inferred("b2"));
    const cycled = setError(ctx(base.games, base.selection), "body_hit");
    expect(selectedShot(cycled.games, cycled.selection)!.error!.player_id).toEqual(observed("b1"));
    // The Error decides the winner: A, the Team that wasn't hit.
    expect(selectedRally(base.games, base.selection)!.winner_id).toEqual(inferred("A"));

    const cleared = setError(ctx(base.games, base.selection), null);
    expect(selectedShot(cleared.games, cleared.selection)!.error).toBeNull();
    expect(selectedRally(cleared.games, cleared.selection)!.winner_id).toEqual(UNKNOWN);
  });

  it("a winner from an Error goes with its Shot, but one entered by hand survives clearing it", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [120, (c) => setError(c, "net")],
    ]);
    expect(selectedRally(base.games, base.selection)!.winner_id).toEqual(inferred("B"));
    const deleted = deleteEntry(ctx(base.games, base.selection));
    expect(selectedRally(deleted.games, deleted.selection)!.winner_id).toEqual(UNKNOWN);

    const rally = selectedRally(base.games, base.selection)!;
    const byHand = setRallyDetails(ctx(base.games, base.selection), {
      score: rally.score,
      serving_team_id: rally.serving_team_id,
      server_id: rally.server_id,
      returner_id: rally.returner_id,
      scoreboard_winner_id: rally.scoreboard_winner_id,
      manual_winner: "A",
    });
    const cleared = setError(ctx(byHand.games, byHand.selection), null);
    expect(selectedRally(cleared.games, cleared.selection)!.winner_id).toEqual(observed("A"));
    expect(selectedRally(cleared.games, cleared.selection)!.winner_source).toBe("play");
  });

  it("Kitchen Fault defaults to the hitter and repeats cycle to the partner", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [120, (c) => setError(c, "kitchen_fault")],
    ]);
    expect(selectedShot(base.games, base.selection)!.error!.player_id).toEqual(inferred("a1"));
    const cycled = setError(ctx(base.games, base.selection), "kitchen_fault");
    expect(selectedShot(cycled.games, cycled.selection)!.error!.player_id).toEqual(observed("a2"));
  });

  it("dragging a dot edits only that Shot, and out of the Frontcourt isn't Settled", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [150, (c) => addShot(c, snapshot)],
    ]);
    const onFirst = { ...base.selection, entry: 0 };
    const moved = moveShotPosition(ctx(base.games, onFirst), "b2", { x: 1, y: 14 });
    const first = shotAt(moved, 0);
    expect(first.positions.b2).toEqual({
      position: observed({ x: 1, y: 14 }),
      settled: observed(false),
    });
    expect(shotAt(moved, 1).positions.b2).toEqual(snapshot.b2);
    // The hitter's Contact Zone follows their dot.
    const hitterMoved = moveShotPosition(ctx(base.games, onFirst), "a1", { x: 0, y: -8 });
    expect(shotAt(hitterMoved, 0).contact_zone).toEqual(observed("frontcourt"));
  });

  it("swapping teammates on the selected Shot swaps positions, hitter and Error", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, snapshot)],
      [120, (c) => setError(c, "net")],
    ]);
    const swapped = swapShotTeammates(ctx(base.games, base.selection), "A");
    const shot = selectedShot(swapped.games, swapped.selection)!;
    expect(shot.positions.a1).toEqual(snapshot.a2);
    expect(shot.positions.a2).toEqual(snapshot.a1);
    expect(shot.hitter_id.value).toBe("a2");
    expect(shot.error!.player_id.value).toBe("a2");
  });

  it("moving a contact re-sorts the Shots and keeps the moved one selected", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, null)],
      [150, (c) => addShot(c, null)],
    ]);
    const moved = moveContact(ctx(base.games, { ...base.selection, entry: 0 }), 0, 200);
    const frames = selectedRally(moved.games, moved.selection)!.entries.map((e) =>
      e.type === "shot" ? e.contact_frame.value : null,
    );
    expect(frames).toEqual([150, 200]);
    expect(moved.selection.entry).toBe(1);
    expect(moveContact(ctx(base.games, base.selection), 0, 150).message).toMatch(/already/);
  });

  it("Backspace deletes the selected Shot", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, null)],
      [150, (c) => addShot(c, null)],
    ]);
    const deleted = deleteEntry(ctx(base.games, base.selection));
    expect(selectedRally(deleted.games, deleted.selection)!.entries).toHaveLength(1);
    expect(deleted.selection.entry).toBe(0);
  });

  it("C cycles Observed → Inferred → Unknown and back, restoring the stashed value", () => {
    const base = run([
      [100, markRallyStart],
      [120, (c) => addShot(c, null)],
    ]);
    let state = { games: base.games, selection: base.selection };
    let stash: ReadonlyMap<string, unknown> = new Map();
    const step = () => {
      const result = cycleCertainty(ctx(state.games, state.selection), "shot", "erne", stash);
      state = result.edit;
      stash = result.stash;
      return selectedShot(state.games, state.selection)!.erne;
    };
    expect(step()).toEqual(inferred(false));
    expect(step()).toEqual(UNKNOWN);
    expect(step()).toEqual(observed(false));
    expect(stash.size).toBe(0);
  });
});

function trackedPlayer(id: string, known: boolean) {
  return {
    player_id: id,
    position_x: known ? 1 : null,
    position_y: known ? -20 : null,
    position_certainty: known ? ("inferred" as const) : ("unknown" as const),
    zone: null,
    settled: known ? false : null,
    settled_certainty: known ? ("inferred" as const) : ("unknown" as const),
    image_x: null,
    image_y: null,
    bbox: null,
    anchor_kind: null,
  };
}

/** A tracked frame where only a1 is known (or nobody). */
function trackedFrame(known: boolean) {
  return {
    frame: 10,
    near_team_id: null,
    players: ["a1", "a2", "b1", "b2"].map((id) => trackedPlayer(id, known && id === "a1")),
    detections: [],
  };
}

describe("positionsFromTracking", () => {
  it("keeps Tracking's certainties, and gives nothing when Tracking knows nothing", async () => {
    const { positionsFromTracking } = await import("./rallyLog");
    const positions = positionsFromTracking(ROSTER, trackedFrame(true))!;
    expect(positions.a1).toEqual({
      position: inferred({ x: 1, y: -20 }),
      settled: inferred(false),
    });
    expect(positions.b2).toEqual({ position: UNKNOWN, settled: UNKNOWN });
    expect(positionsFromTracking(ROSTER, trackedFrame(false))).toBeNull();
    expect(positionsFromTracking(ROSTER, undefined)).toBeNull();
  });
});
