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
  date: "2026-04-12",
  tournament: "PPA Atlanta Open 2026",
  team_a: ["Anna Bright", "Ben Johns"],
  team_b: ["Cara Lee", "Dan Kim"],
  franchise_a: null,
  franchise_b: null,
  video_status: "ready",
  annotation_mode: "gold",
  assisted_ratio_budget: 0.25,
  broadcast_seconds: 120,
  operator_time: {
    active_seconds: 0,
    calibrate_seconds: 0,
    annotate_seconds: 0,
    review_seconds: 0,
  },
  operator_time_ratio: 0,
  footage_job: null,
  done_rallies: 0,
  total_rallies: 0,
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

function setupLayerRect(layer: HTMLElement) {
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
      opposite_end_flip_y_ft: 2.0,
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

  it("calls onBackgroundClick (play/pause) instead of saving an anchor in Annotate before tracking loads", () => {
    const onAssign =
      vi.fn<(playerId: string, click: { x: number; y: number }, detection: unknown) => void>();
    const onMove = vi.fn<(playerId: string, pt: { x: number; y: number }) => void>();
    const onSelect = vi.fn<(playerId: string) => void>();
    const onBackgroundClick = vi.fn<() => void>();

    const { container } = render(
      <PlayerOverlay
        videoRef={makeVideoRef()}
        players={MATCH.players}
        frameData={undefined}
        selectedPlayerId="p-a1"
        editable
        clickEmptyPlaces={false}
        onSelectPlayer={onSelect}
        onAssignDetection={onAssign}
        onMovePlayer={onMove}
        onBackgroundClick={onBackgroundClick}
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

    fireEvent.pointerDown(layer, { pointerId: 1, clientX: 500, clientY: 250 });
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    expect(onMove).not.toHaveBeenCalled();
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("handles landing clicks, Alt+click override over Players, click-to-deselect, cancel, and team-none marker", () => {
    const onAssign =
      vi.fn<(playerId: string, click: { x: number; y: number }, detection: unknown) => void>();
    const onMove = vi.fn<(playerId: string, pt: { x: number; y: number }) => void>();
    const onSelect = vi.fn<(playerId: string) => void>();
    const onDeselect = vi.fn<() => void>();
    const onSetLanding = vi.fn<(pt: { x: number; y: number }) => void>();
    const onBackgroundClick = vi.fn<() => void>();

    // Shot selected, no Player selected: plain click on empty video sets landing, not background play.
    const { container, rerender } = render(
      <PlayerOverlay
        videoRef={makeVideoRef()}
        players={MATCH.players}
        frameData={FRAME_DATA}
        selectedPlayerId={null}
        editable
        clickEmptyPlaces={false}
        landing={{ at: { x: 0.55, y: 0.42 }, team: "a" }}
        landingMapped
        onSetLanding={onSetLanding}
        onSelectPlayer={onSelect}
        onDeselectPlayer={onDeselect}
        onAssignDetection={onAssign}
        onMovePlayer={onMove}
        onBackgroundClick={onBackgroundClick}
      />,
    );
    const layer = container.querySelector<HTMLElement>(".player-layer")!;
    setupLayerRect(layer);

    expect(layer.classList.contains("landing-click")).toBe(true);
    const marker = container.querySelector<SVGSVGElement>(".monitor-landing.team-a");
    expect(marker).not.toBeNull();
    expect(Number.parseFloat(marker!.style.left)).toBeCloseTo(55, 6);
    expect(Number.parseFloat(marker!.style.top)).toBeCloseTo(42, 6);

    // Plain click on empty video sets landing; right-click does nothing.
    fireEvent.pointerDown(layer, { pointerId: 1, button: 2, clientX: 500, clientY: 250 });
    expect(onSetLanding).not.toHaveBeenCalled();
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 500, clientY: 250 });
    expect(onSetLanding).toHaveBeenCalledExactlyOnceWith({ x: 0.5, y: 0.5 });
    expect(onBackgroundClick).not.toHaveBeenCalled();

    // Plain click on a foot dot selects Player (does not set landing).
    onSetLanding.mockClear();
    const dot = screen.getByRole("button", { name: "Anna Bright foot position" });
    fireEvent.pointerDown(dot, { pointerId: 2, button: 0, clientX: 300, clientY: 350 });
    fireEvent.pointerUp(dot, { pointerId: 2, button: 0, clientX: 300, clientY: 350 });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("p-a1");
    expect(onDeselect).not.toHaveBeenCalled();
    expect(onSetLanding).not.toHaveBeenCalled();

    // Alt+click directly on a foot dot sets landing instead of selecting/dragging the Player.
    onSelect.mockClear();
    fireEvent.pointerDown(dot, {
      pointerId: 3,
      button: 0,
      altKey: true,
      clientX: 300,
      clientY: 350,
    });
    expect(onSetLanding).toHaveBeenCalledExactlyOnceWith({ x: 0.3, y: 0.7 });
    expect(onSelect).not.toHaveBeenCalled();

    // With an already-selected Player (p-a1), plain click on their foot dot without moving calls
    // onDeselectPlayer on pointerUp, while dragging moves them instead, and cancel/lostCapture aborts.
    onSetLanding.mockClear();
    rerender(
      <PlayerOverlay
        videoRef={makeVideoRef()}
        players={MATCH.players}
        frameData={FRAME_DATA}
        selectedPlayerId="p-a1"
        editable
        clickEmptyPlaces={false}
        landing={{ at: { x: 0.5, y: 0.5 }, team: null }}
        landingMapped
        onSetLanding={onSetLanding}
        onSelectPlayer={onSelect}
        onDeselectPlayer={onDeselect}
        onAssignDetection={onAssign}
        onMovePlayer={onMove}
        onBackgroundClick={onBackgroundClick}
      />,
    );
    expect(container.querySelector(".monitor-landing.team-none")).not.toBeNull();

    const selectedDot = screen.getByRole("button", { name: "Anna Bright foot position" });
    fireEvent.pointerDown(selectedDot, { pointerId: 4, button: 0, clientX: 300, clientY: 350 });
    expect(onDeselect).not.toHaveBeenCalled();
    fireEvent.pointerUp(layer, { pointerId: 4, button: 0, clientX: 300, clientY: 350 });
    expect(onDeselect).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();

    onDeselect.mockClear();
    fireEvent.pointerDown(selectedDot, { pointerId: 5, button: 0, clientX: 300, clientY: 350 });
    fireEvent.pointerMove(layer, { pointerId: 5, clientX: 350, clientY: 360 });
    fireEvent.pointerUp(layer, { pointerId: 5, button: 0, clientX: 350, clientY: 360 });
    expect(onMove).toHaveBeenCalledExactlyOnceWith("p-a1", { x: 0.35, y: 0.72 });
    expect(onDeselect).not.toHaveBeenCalled();

    // pointerCancel and lostPointerCapture abort the drag cleanly without moving or deselecting.
    onMove.mockClear();
    fireEvent.pointerDown(selectedDot, { pointerId: 11, button: 0, clientX: 300, clientY: 350 });
    fireEvent.pointerMove(layer, { pointerId: 11, clientX: 360, clientY: 360 });
    fireEvent.pointerCancel(layer, { pointerId: 11 });
    fireEvent.pointerUp(layer, { pointerId: 11, button: 0, clientX: 360, clientY: 360 });
    expect(onMove).not.toHaveBeenCalled();
    expect(onDeselect).not.toHaveBeenCalled();

    fireEvent.pointerDown(selectedDot, { pointerId: 12, button: 0, clientX: 300, clientY: 350 });
    fireEvent.lostPointerCapture(layer, { pointerId: 12 });
    fireEvent.pointerUp(layer, { pointerId: 12, button: 0, clientX: 300, clientY: 350 });
    expect(onMove).not.toHaveBeenCalled();
    expect(onDeselect).not.toHaveBeenCalled();

    // With p-b1 (Unknown on this frame) armed for placement:
    // - plain click in detection box binds p-b1;
    // - plain click on empty video places p-b1;
    // - Alt+click over box or empty video still sets landing.
    onAssign.mockClear();
    onMove.mockClear();
    onSetLanding.mockClear();
    rerender(
      <PlayerOverlay
        videoRef={makeVideoRef()}
        players={MATCH.players}
        frameData={FRAME_DATA}
        selectedPlayerId="p-b1"
        editable
        clickEmptyPlaces={false}
        landingMapped
        onSetLanding={onSetLanding}
        onSelectPlayer={onSelect}
        onDeselectPlayer={onDeselect}
        onAssignDetection={onAssign}
        onMovePlayer={onMove}
      />,
    );
    expect(layer.classList.contains("placing")).toBe(true);
    fireEvent.pointerDown(layer, { pointerId: 6, button: 0, clientX: 300, clientY: 300 });
    expect(onAssign).toHaveBeenCalledExactlyOnceWith(
      "p-b1",
      { x: 0.3, y: 0.6 },
      FRAME_DATA.detections[0],
    );
    expect(onSetLanding).not.toHaveBeenCalled();

    fireEvent.pointerDown(layer, { pointerId: 7, button: 0, clientX: 800, clientY: 250 });
    expect(onMove).toHaveBeenCalledExactlyOnceWith("p-b1", { x: 0.8, y: 0.5 });
    expect(onSetLanding).not.toHaveBeenCalled();

    fireEvent.pointerDown(layer, {
      pointerId: 8,
      button: 0,
      altKey: true,
      clientX: 300,
      clientY: 300,
    });
    expect(onSetLanding).toHaveBeenCalledWith({ x: 0.3, y: 0.6 });
    fireEvent.pointerDown(layer, {
      pointerId: 9,
      button: 0,
      altKey: true,
      clientX: 800,
      clientY: 250,
    });
    expect(onSetLanding).toHaveBeenCalledWith({ x: 0.8, y: 0.5 });

    // With showPlayers=false, Player boxes/dots are hidden, landing ✕ still renders, and plain click sets landing.
    onSetLanding.mockClear();
    onAssign.mockClear();
    onMove.mockClear();
    rerender(
      <PlayerOverlay
        videoRef={makeVideoRef()}
        players={MATCH.players}
        frameData={FRAME_DATA}
        selectedPlayerId="p-b1"
        editable
        showPlayers={false}
        clickEmptyPlaces={false}
        landing={{ at: { x: 0.4, y: 0.6 }, team: "b" }}
        landingMapped
        onSetLanding={onSetLanding}
        onSelectPlayer={onSelect}
        onDeselectPlayer={onDeselect}
        onAssignDetection={onAssign}
        onMovePlayer={onMove}
      />,
    );
    expect(container.querySelectorAll(".player-box")).toHaveLength(0);
    expect(container.querySelectorAll(".player-dot")).toHaveLength(0);
    expect(container.querySelector(".monitor-landing.team-b")).not.toBeNull();
    fireEvent.pointerDown(layer, { pointerId: 10, button: 0, clientX: 300, clientY: 300 });
    expect(onSetLanding).toHaveBeenCalledExactlyOnceWith({ x: 0.3, y: 0.6 });
    expect(onAssign).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
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

  it("calls onDeselectPlayer on unmoved pointerUp when interactive, and on pointerDown when non-interactive", () => {
    const onSelect = vi.fn<(playerId: string) => void>();
    const onDeselect = vi.fn<() => void>();
    const onMove = vi.fn<(playerId: string, pt: { x: number; y: number }) => void>();
    const playerDot = [
      {
        id: "p-a1",
        name: "Anna Bright",
        initials: "AB",
        team: "a" as const,
        x: -4,
        y: -8,
        certainty: "observed" as const,
        selected: true,
      },
    ];
    const { container, rerender } = render(
      <CourtDiagram
        nearTeam="Anna Bright / Ben Johns"
        farTeam="Cara Lee / Dan Kim"
        interactive
        selectedPlayerId="p-a1"
        onSelectPlayer={onSelect}
        onDeselectPlayer={onDeselect}
        onMovePlayer={onMove}
        players={playerDot}
      />,
    );
    const svg = container.querySelector<SVGSVGElement>("svg.court")!;
    svg.setPointerCapture = vi.fn<(pointerId: number) => void>();
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 672 }),
    );
    const dot = svg.querySelector<SVGGElement>('[data-player-id="p-a1"]')!;

    // Click without dragging: does not fire on pointerDown, fires onDeselectPlayer on pointerUp.
    fireEvent.pointerDown(dot, { pointerId: 1, button: 0, clientX: 120, clientY: 416 });
    expect(onDeselect).not.toHaveBeenCalled();
    fireEvent.pointerUp(svg, { pointerId: 1, button: 0, clientX: 120, clientY: 416 });
    expect(onDeselect).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();

    // Dragging an already-selected dot moves it without calling onSelectPlayer or onDeselectPlayer.
    onDeselect.mockClear();
    fireEvent.pointerDown(dot, { pointerId: 2, button: 0, clientX: 120, clientY: 416 });
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 160, clientY: 380 });
    fireEvent.pointerUp(svg, { pointerId: 2, button: 0, clientX: 160, clientY: 380 });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDeselect).not.toHaveBeenCalled();
    expect(onMove).toHaveBeenCalledTimes(1);

    // Non-interactive CourtDiagram calls onDeselectPlayer directly on pointerDown.
    rerender(
      <CourtDiagram
        nearTeam="Anna Bright / Ben Johns"
        farTeam="Cara Lee / Dan Kim"
        interactive={false}
        selectedPlayerId="p-a1"
        onSelectPlayer={onSelect}
        onDeselectPlayer={onDeselect}
        players={playerDot}
      />,
    );
    fireEvent.pointerDown(dot, { pointerId: 3, button: 0, clientX: 120, clientY: 416 });
    expect(onDeselect).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
