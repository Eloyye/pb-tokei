import { describe, expect, it } from "vitest";
import type {
  FrameDetectionOut,
  MatchDetail,
  PlayerAnchor,
  PlayerTrackingFrameOut,
  TeamEnd,
} from "../api/client";
import {
  courtPointToImage,
  deletePlayerAnchor,
  deleteTeamEnd,
  findDetectionAtPoint,
  imagePointToCourt,
  nearTeamKeyFor,
  playerInitialsMap,
  setPlayerAnchor,
  swapTeamEnds,
  swapTeamPartners,
  teamEndAt,
} from "./players";

const MATCH: Pick<MatchDetail, "team_a_id" | "team_b_id" | "team_a" | "team_b" | "players"> = {
  team_a_id: "team-a",
  team_b_id: "team-b",
  team_a: ["Anna Bright", "Anna-Leigh Waters"],
  team_b: ["Jorja Johnson", "Tyra Black"],
  players: [
    { id: "p-a1", name: "Anna Bright", handedness: "right", team_id: "team-a", team: "a" },
    { id: "p-a2", name: "Anna-Leigh Waters", handedness: "right", team_id: "team-a", team: "a" },
    { id: "p-b1", name: "Jorja Johnson", handedness: "right", team_id: "team-b", team: "b" },
    { id: "p-b2", name: "Tyra Black", handedness: "right", team_id: "team-b", team: "b" },
  ],
};

describe("players helpers", () => {
  it("resolves teamEndAt with effective-from semantics and nearTeamKeyFor", () => {
    const ends: TeamEnd[] = [
      { effective_from_frame: 100, near_team_id: "team-a" },
      { effective_from_frame: 500, near_team_id: "team-b" },
    ];
    expect(teamEndAt([], 50)).toBeUndefined();
    expect(teamEndAt(ends, 50)?.near_team_id).toBe("team-a");
    expect(teamEndAt(ends, 100)?.near_team_id).toBe("team-a");
    expect(teamEndAt(ends, 499)?.near_team_id).toBe("team-a");
    expect(teamEndAt(ends, 500)?.near_team_id).toBe("team-b");
    expect(nearTeamKeyFor(MATCH, ends, 500)).toBe("b");
    expect(nearTeamKeyFor(MATCH, [], 50, "team-b")).toBe("b");
  });

  it("computes initials and disambiguates collisions", () => {
    const map = playerInitialsMap([
      { id: "1", name: "Anna Wright", handedness: "right", team_id: "team-a", team: "a" },
      { id: "2", name: "Anna Waters", handedness: "right", team_id: "team-a", team: "a" },
      { id: "3", name: "Tyra Black", handedness: "right", team_id: "team-b", team: "b" },
    ]);
    expect(map.get("1")).toBe("AWR");
    expect(map.get("2")).toBe("AWA");
    expect(map.get("3")).toBe("TB");
  });

  it("picks the smallest detected person box containing a click", () => {
    const detections: FrameDetectionOut[] = [
      {
        x1: 0.1,
        y1: 0.1,
        x2: 0.6,
        y2: 0.9,
        foot_x: 0.35,
        foot_y: 0.9,
        score: 0.9,
        ankles_visible: true,
        feet_cropped: false,
        court_x: -2,
        court_y: -10,
        player_id: null,
      },
      {
        x1: 0.25,
        y1: 0.2,
        x2: 0.4,
        y2: 0.6,
        foot_x: 0.32,
        foot_y: 0.6,
        score: 0.85,
        ankles_visible: true,
        feet_cropped: false,
        court_x: -1,
        court_y: -7,
        player_id: null,
      },
    ];
    expect(findDetectionAtPoint(detections, { x: 0.3, y: 0.4 })).toBe(detections[1]);
    expect(findDetectionAtPoint(detections, { x: 0.9, y: 0.9 })).toBeNull();
  });

  it("seeds teamEnds on first anchor, flips on opposite end, and auto-advances selection", () => {
    const first = setPlayerAnchor([], [], MATCH, 120, "p-a1", "identity", { x: 0.3, y: 0.7 }, -10);
    expect(first.anchors).toEqual([
      { frame: 120, player_id: "p-a1", kind: "identity", image_x: 0.3, image_y: 0.7 },
    ]);
    expect(first.teamEnds).toEqual([{ effective_from_frame: 0, near_team_id: "team-a" }]);
    expect(first.nextSelected).toBe("p-a2");

    // Placing Team A player clearly on the far end (y = +10) records an end flip from frame 600.
    const flipped = setPlayerAnchor(
      first.anchors,
      first.teamEnds,
      MATCH,
      600,
      "p-a1",
      "position",
      { x: 0.5, y: 0.2 },
      10,
    );
    expect(flipped.teamEnds).toEqual([
      { effective_from_frame: 0, near_team_id: "team-a" },
      { effective_from_frame: 600, near_team_id: "team-b" },
    ]);

    const removed = deletePlayerAnchor(flipped.anchors, flipped.teamEnds, 120, "p-a1");
    expect(removed.anchors).toHaveLength(1);
    const removedEnd = deleteTeamEnd(removed.anchors, removed.teamEnds, 600);
    expect(removedEnd.teamEnds).toHaveLength(1);
  });

  it("swaps Team partners and Team ends from playhead forward", () => {
    const frameData: PlayerTrackingFrameOut = {
      frame: 200,
      near_team_id: "team-a",
      players: [
        {
          player_id: "p-a1",
          position_x: -4,
          position_y: -8,
          position_certainty: "observed",
          zone: "frontcourt",
          settled: true,
          settled_certainty: "observed",
          image_x: 0.3,
          image_y: 0.7,
          bbox: [0.25, 0.4, 0.35, 0.72],
          anchor_kind: null,
        },
        {
          player_id: "p-a2",
          position_x: 4,
          position_y: -8,
          position_certainty: "observed",
          zone: "frontcourt",
          settled: true,
          settled_certainty: "observed",
          image_x: 0.7,
          image_y: 0.7,
          bbox: [0.65, 0.4, 0.75, 0.72],
          anchor_kind: null,
        },
      ],
      detections: [
        {
          x1: 0.25,
          y1: 0.4,
          x2: 0.35,
          y2: 0.72,
          foot_x: 0.3,
          foot_y: 0.7,
          score: 0.9,
          ankles_visible: true,
          feet_cropped: false,
          court_x: -4,
          court_y: -8,
          player_id: "p-a1",
        },
        {
          x1: 0.65,
          y1: 0.4,
          x2: 0.75,
          y2: 0.72,
          foot_x: 0.7,
          foot_y: 0.7,
          score: 0.9,
          ankles_visible: true,
          feet_cropped: false,
          court_x: 4,
          court_y: -8,
          player_id: "p-a2",
        },
      ],
    };
    const swapped = swapTeamPartners([], [], MATCH, "a", 200, frameData);
    expect(swapped.anchors).toEqual<PlayerAnchor[]>([
      { frame: 200, player_id: "p-a1", kind: "identity", image_x: 0.7, image_y: 0.7 },
      { frame: 200, player_id: "p-a2", kind: "identity", image_x: 0.3, image_y: 0.7 },
    ]);

    const endsSwapped = swapTeamEnds(
      [],
      [{ effective_from_frame: 0, near_team_id: "team-a" }],
      MATCH,
      400,
    );
    expect(endsSwapped.teamEnds).toEqual([
      { effective_from_frame: 0, near_team_id: "team-a" },
      { effective_from_frame: 400, near_team_id: "team-b" },
    ]);
  });

  it("round-trips courtPointToImage and imagePointToCourt through radial lens distortion", () => {
    const matrix = [
      [0.04, 0, 0.5],
      [0, -0.02, 0.5],
      [0, 0, 1],
    ];
    const lens = { k1: 0.09, aspect: 16 / 9 };
    const img = courtPointToImage({ x: 6, y: -12 }, matrix, lens);
    expect(img).not.toBeNull();
    const back = imagePointToCourt(img!, matrix, lens);
    expect(back).not.toBeNull();
    expect(back!.x).toBeCloseTo(6, 2);
    expect(back!.y).toBeCloseTo(-12, 2);
  });
});
