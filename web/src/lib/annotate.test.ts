import { describe, expect, it } from "vitest";
import type { Game, Shot, ShotPosition } from "../api/client";
import {
  type AnnotateContext,
  type AnnotateEdit,
  addShot,
  cycleCertainty,
  deleteEntry,
  deleteGame,
  deleteRally,
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
  setRefereeCall,
  startNextGame,
  swapHitterToPartner,
  swapShotTeammates,
  switchHitterTeam,
  toggleGap,
} from "./annotate";
import { inferred, newRally, newShot, numberShots, observed, UNKNOWN } from "./rallyLog";
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

  it("keeps Shift+O's warning for an end before the last Shot", () => {
    const edit = markRallyEnd(ctx(gamesWith(), selection, 400));
    expect(selectedRally(edit.games, selection)?.end_frame).toBe(400);
    expect(edit.message).toContain("before its last Shot (frame 480)");
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
