// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MatchDetail,
  PlayerAnchor,
  PlayerTrackingFrameOut,
  PlayerTrackingOut,
  TeamEnd,
} from "../api/client";
import { CourtDiagram } from "./CourtDiagram";
import { PlayerOverlay } from "./PlayerOverlay";
import { PlayersPanel } from "./PlayersPanel";

afterEach(() => {
  cleanup();
});

const MATCH: MatchDetail = {
  id: "match-1",
  tournament: "PPA Atlanta Open 2026",
  team_a: ["Anna Bright", "Ben Johns"],
  team_b: ["Cara Lee", "Dan Kim"],
  franchise_a: null,
  franchise_b: null,
  video_status: "ready",
  footage_job: null,
  fix_command: null,
  source_url: "https://example.com/v",
  original_present: true,
  team_a_id: "team-a",
  team_b_id: "team-b",
  players: [
    { id: "p-a1", name: "Anna Bright", team_id: "team-a", team: "a" },
    { id: "p-a2", name: "Ben Johns", team_id: "team-a", team: "a" },
    { id: "p-b1", name: "Cara Lee", team_id: "team-b", team: "b" },
    { id: "p-b2", name: "Dan Kim", team_id: "team-b", team: "b" },
  ],
};

const FRAME_DATA: PlayerTrackingFrameOut = {
  frame: 120,
  near_team_id: "team-a",
  players: [
    {
      player_id: "p-a1",
      position_x: -4,
      position_y: -7.5,
      position_certainty: "observed",
      zone: "frontcourt",
      settled: true,
      settled_certainty: "observed",
      image_x: 0.3,
      image_y: 0.7,
      bbox: [0.25, 0.45, 0.35, 0.72],
      anchor_kind: "identity",
    },
    {
      player_id: "p-a2",
      position_x: 4,
      position_y: -12,
      position_certainty: "inferred",
      zone: "midcourt",
      settled: false,
      settled_certainty: "inferred",
      image_x: 0.7,
      image_y: 0.75,
      bbox: [0.65, 0.5, 0.75, 0.76],
      anchor_kind: null,
    },
    {
      player_id: "p-b1",
      position_x: null,
      position_y: null,
      position_certainty: "unknown",
      zone: null,
      settled: null,
      settled_certainty: "unknown",
      image_x: null,
      image_y: null,
      bbox: null,
      anchor_kind: null,
    },
    {
      player_id: "p-b2",
      position_x: 3,
      position_y: 8,
      position_certainty: "observed",
      zone: "frontcourt",
      settled: false,
      settled_certainty: "observed",
      image_x: 0.6,
      image_y: 0.3,
      bbox: [0.56, 0.15, 0.64, 0.31],
      anchor_kind: null,
    },
  ],
  detections: [
    {
      x1: 0.25,
      y1: 0.45,
      x2: 0.35,
      y2: 0.72,
      foot_x: 0.3,
      foot_y: 0.7,
      score: 0.94,
      ankles_visible: true,
      feet_cropped: false,
      court_x: -4,
      court_y: -7.5,
      player_id: "p-a1",
    },
  ],
};

function makeVideoRef() {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    clientWidth: { value: 1000, configurable: true },
    clientHeight: { value: 500, configurable: true },
    videoWidth: { value: 1000, configurable: true },
    videoHeight: { value: 500, configurable: true },
    offsetLeft: { value: 0, configurable: true },
    offsetTop: { value: 0, configurable: true },
  });
  return { current: video };
}

describe("PlayersPanel", () => {
  it("renders device badge, tracking controls, 4-Player checklist, swap buttons, and anchor/end lists", () => {
    const onTrack = vi.fn<() => void>();
    const onCancel = vi.fn<() => void>();
    const onSwapTeam = vi.fn<(team: "a" | "b") => void>();
    const onSwapEnds = vi.fn<() => void>();
    const onSeek = vi.fn<(frame: number) => void>();
    const onDeleteAnchor = vi.fn<(frame: number, playerId: string) => void>();
    const onDeleteTeamEnd = vi.fn<(effectiveFromFrame: number) => void>();
    const tracking: PlayerTrackingOut = {
      status: "idle",
      error: null,
      device: "mps",
      progress: 0,
      tracked_segments: 0,
      total_segments: 1,
      spans: [
        {
          start_frame: 26,
          end_frame: 2465,
          camera_view: "main",
          tracked: false,
          status: "pending",
        },
      ],
    };
    const anchors: PlayerAnchor[] = [
      { frame: 120, player_id: "p-a1", kind: "identity", image_x: 0.3, image_y: 0.7 },
    ];
    const ends: TeamEnd[] = [{ effective_from_frame: 0, near_team_id: "team-a" }];

    render(
      <PlayersPanel
        match={MATCH}
        frame={120}
        tracking={tracking}
        frameData={FRAME_DATA}
        anchors={anchors}
        teamEnds={ends}
        selectedPlayerId="p-a1"
        onSelectPlayer={vi.fn<(playerId: string) => void>()}
        onTrack={onTrack}
        onCancelTrack={onCancel}
        onSwapTeam={onSwapTeam}
        onSwapEnds={onSwapEnds}
        onMovePlayerOnCourt={vi.fn<(playerId: string, pt: { x: number; y: number }) => void>()}
        onPlacePlayerOnCourt={vi.fn<(courtPoint: { x: number; y: number }) => void>()}
        onSeek={onSeek}
        onDeleteAnchor={onDeleteAnchor}
        onDeleteTeamEnd={onDeleteTeamEnd}
      />,
    );

    expect(screen.getByText("MPS")).toBeTruthy();
    expect(screen.getByText("Anna Bright")).toBeTruthy();
    expect(screen.getByText("Settled")).toBeTruthy();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Track Players" }));
    expect(onTrack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Swap A/i }));
    expect(onSwapTeam).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: /Swap B/i }));
    expect(onSwapTeam).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: /Swap ends/i }));
    expect(onSwapEnds).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("button", { name: /Delete Anna Bright anchor on frame 120/i }),
    );
    expect(onDeleteAnchor).toHaveBeenCalledWith(120, "p-a1");
    fireEvent.click(screen.getByRole("button", { name: /Delete end change from frame 0/i }));
    expect(onDeleteTeamEnd).toHaveBeenCalledWith(0);
  });
});

describe("PlayerOverlay", () => {
  it("binds identity on clicking inside a detected box and moves position on foot-dot drag", () => {
    const onAssign =
      vi.fn<(playerId: string, click: { x: number; y: number }, detection: unknown) => void>();
    const onMove = vi.fn<(playerId: string, pt: { x: number; y: number }) => void>();
    const onSelect = vi.fn<(playerId: string) => void>();
    const { container } = render(
      <PlayerOverlay
        videoRef={makeVideoRef()}
        players={MATCH.players}
        frameData={FRAME_DATA}
        selectedPlayerId="p-b1"
        editable
        clickEmptyPlaces
        onSelectPlayer={onSelect}
        onAssignDetection={onAssign}
        onMovePlayer={onMove}
      />,
    );

    const layer = container.querySelector<HTMLElement>(".player-layer")!;
    layer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 1000,
        height: 500,
        right: 1000,
        bottom: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    layer.setPointerCapture = vi.fn<(pointerId: number) => void>();
    layer.hasPointerCapture = () => true;
    layer.releasePointerCapture = vi.fn<(pointerId: number) => void>();

    // Click inside detection box [0.25..0.35, 0.45..0.72] -> (300, 300)
    fireEvent.pointerDown(layer, { pointerId: 1, clientX: 300, clientY: 300 });
    expect(onAssign).toHaveBeenCalledWith("p-b1", { x: 0.3, y: 0.6 }, FRAME_DATA.detections[0]);

    // Drag Anna Bright's foot dot to (400, 400) -> position anchor at (0.4, 0.8)
    const dot = screen.getByRole("button", { name: "Anna Bright foot position" });
    fireEvent.pointerDown(dot, { pointerId: 2, clientX: 300, clientY: 350 });
    fireEvent.pointerMove(layer, { pointerId: 2, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(layer, { pointerId: 2, clientX: 400, clientY: 400 });
    expect(onMove).toHaveBeenCalledWith("p-a1", { x: 0.4, y: 0.8 });
  });
});

describe("CourtDiagram", () => {
  it("renders Observed, Inferred, and hollow dashed Unknown Player dots with near/far Team labels", () => {
    const { container } = render(
      <CourtDiagram
        nearTeam="Cara Lee / Dan Kim"
        farTeam="Anna Bright / Ben Johns"
        nearTeamKey="b"
        players={[
          {
            id: "p-a1",
            name: "Anna Bright",
            initials: "AB",
            team: "a",
            x: -4,
            y: 8,
            certainty: "observed",
          },
          {
            id: "p-a2",
            name: "Ben Johns",
            initials: "BJ",
            team: "a",
            x: 4,
            y: 12,
            certainty: "inferred",
          },
          {
            id: "p-b1",
            name: "Cara Lee",
            initials: "CL",
            team: "b",
            x: null,
            y: null,
            certainty: "unknown",
          },
          {
            id: "p-b2",
            name: "Dan Kim",
            initials: "DK",
            team: "b",
            x: 3,
            y: -8,
            certainty: "observed",
          },
        ]}
      />,
    );

    expect(container.querySelector('[data-player-id="p-a1"]')?.classList.contains("observed")).toBe(
      true,
    );
    expect(container.querySelector('[data-player-id="p-a2"]')?.classList.contains("inferred")).toBe(
      true,
    );
    expect(container.querySelector('[data-player-id="p-b1"]')?.classList.contains("unknown")).toBe(
      true,
    );
    expect(screen.getByText("Cara Lee / Dan Kim")).toBeTruthy();
  });
});
