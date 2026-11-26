import { describe, expect, it } from "vitest";
import type { Rally, Shot, ShotClass, Zone } from "../api/client";
import { rallyPhase, shotType, teamStatuses } from "./derived";
import { newRally, newShot, numberShots, observed } from "./rallyLog";
import { ROSTER } from "./testRoster";

function pos(y: number) {
  return { position: observed({ x: 0, y }), settled: observed(false) };
}

/** A Shot with each Player's |y| depth (A at the near end, B at the far end). */
function shot(
  frame: number,
  depths: [number, number, number, number],
  fields: { hitter?: string; shotClass?: ShotClass; zone?: Zone } = {},
): Shot {
  const [a1, a2, b1, b2] = depths;
  return {
    ...newShot(frame),
    hitter_id: fields.hitter ? observed(fields.hitter) : newShot(frame).hitter_id,
    shot_class: fields.shotClass ? observed(fields.shotClass) : newShot(frame).shot_class,
    contact_zone: fields.zone ? observed(fields.zone) : newShot(frame).contact_zone,
    positions: { a1: pos(-a1), a2: pos(-a2), b1: pos(b1), b2: pos(b2) },
  };
}

function rallyOf(...entries: Rally["entries"]): Rally {
  return numberShots({ ...newRally(1, 0), entries });
}

describe("Team Status", () => {
  it("is Established once both are in the Frontcourt, until either is past 12 ft", () => {
    const rally = rallyOf(
      shot(1, [22, 21, 21, 8]),
      shot(2, [15, 8, 20, 21]),
      shot(3, [8, 7, 9, 8]),
      shot(4, [11, 12, 13, 8]),
    );
    const statuses = [...teamStatuses(ROSTER, rally).values()];
    expect(statuses.map((s) => s.A)).toEqual(["back", "split", "established", "established"]);
    expect(statuses.map((s) => s.B)).toEqual(["split", "back", "established", "split"]);
  });
});

describe("Rally Phase", () => {
  it("names Serve, Return, Transition, Frontcourt Battle and Scramble", () => {
    const rally = rallyOf(
      shot(1, [22, 21, 21, 8]),
      shot(2, [15, 8, 20, 21]),
      shot(3, [8, 15, 9, 8]),
      shot(4, [8, 7, 9, 8]),
      shot(5, [8, 7, 15, 8]),
    );
    expect([0, 1, 2, 3, 4].map((i) => rallyPhase(ROSTER, rally, i))).toEqual([
      "serve",
      "return",
      "transition",
      "frontcourt_battle",
      "scramble",
    ]);
  });
});

describe("Shot Type", () => {
  it("works from Shot Class, Contact Zone and whether the incoming Shot was an Attack", () => {
    const depths: [number, number, number, number] = [8, 8, 8, 8];
    const rally = rallyOf(
      shot(1, depths, { hitter: "a1", shotClass: "hard" }),
      shot(2, depths, { hitter: "b1", shotClass: "hard" }),
      shot(3, depths, { hitter: "a1", shotClass: "soft", zone: "frontcourt" }),
      shot(4, depths, { hitter: "b1", shotClass: "hard", zone: "frontcourt" }),
      shot(5, depths, { hitter: "a1", shotClass: "hard", zone: "frontcourt" }),
      shot(6, depths, { hitter: "b1", shotClass: "soft", zone: "midcourt" }),
      shot(7, depths, { hitter: "a1", shotClass: "lob", zone: "frontcourt" }),
      shot(8, [8, 8, 20, 20], { hitter: "b1", shotClass: "lob", zone: "backcourt" }),
      shot(9, depths, { hitter: "a1", shotClass: "hard", zone: "backcourt" }),
      shot(9.5, depths, { hitter: "b1", shotClass: "soft", zone: "backcourt" }),
      { type: "gap", missing: "odd" },
      shot(10, depths, { hitter: "a1", shotClass: "soft", zone: "frontcourt" }),
      shot(11, depths, { hitter: "b1", shotClass: "soft", zone: "midcourt" }),
    );
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12].map((i) => shotType(ROSTER, rally, i))).toEqual([
      "serve",
      "return",
      "block",
      "speedup",
      "counter",
      "reset",
      "offensive_lob",
      "defensive_lob",
      "drive",
      "reset",
      // After an Observation Gap the incoming Shot is unknown.
      null,
      "drop",
    ]);
  });
});
