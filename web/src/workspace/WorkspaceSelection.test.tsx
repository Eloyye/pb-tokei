// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CalibrationOut,
  CameraMotionFramesOut,
  CameraMotionOut,
  Game,
  MatchDetail,
  OperatorTime,
  PlayerAnchor,
  PlayerTrackingFramesOut,
  PlayerTrackingOut,
  PlaySegment,
  ShotPosition,
  TeamEnd,
} from "../api/client";
import { unproject } from "../lib/calibrations";
import { inferred, newRally, newShot, numberShots, observed } from "../lib/rallyLog";
import { ROSTER } from "../lib/testRoster";
import type { OperatorWorkspace as WorkspaceName } from "../lib/workspaces";
import { ShortcutSheet } from "../shell/ShortcutSheet";
import { Workspace } from "./Workspace";

const apiMocks = vi.hoisted(() => ({
  getPlaySegments: vi.fn<() => Promise<PlaySegment[]>>(),
  replacePlaySegments: vi.fn<(id: string, segments: PlaySegment[]) => Promise<PlaySegment[]>>(),
  getCalibrations: vi.fn<() => Promise<CalibrationOut[]>>(),
  getPlayerAnchors: vi.fn<() => Promise<PlayerAnchor[]>>(),
  replacePlayerAnchors: vi.fn<(id: string, anchors: PlayerAnchor[]) => Promise<PlayerAnchor[]>>(),
  getTeamEnds: vi.fn<() => Promise<TeamEnd[]>>(),
  replaceTeamEnds: vi.fn<(id: string, ends: TeamEnd[]) => Promise<TeamEnd[]>>(),
  getGames: vi.fn<() => Promise<Game[]>>(),
  replaceGames: vi.fn<(id: string, games: Game[]) => Promise<Game[]>>(),
  getCameraMotion: vi.fn<() => Promise<CameraMotionOut>>(),
  getCameraMotionFrames: vi.fn<() => Promise<CameraMotionFramesOut>>(),
  getPlayerTracking: vi.fn<() => Promise<PlayerTrackingOut>>(),
  getPlayerTrackingFrames: vi.fn<() => Promise<PlayerTrackingFramesOut>>(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getPlaySegments: apiMocks.getPlaySegments,
    replacePlaySegments: apiMocks.replacePlaySegments,
    getCalibrations: apiMocks.getCalibrations,
    getPlayerAnchors: apiMocks.getPlayerAnchors,
    replacePlayerAnchors: apiMocks.replacePlayerAnchors,
    getTeamEnds: apiMocks.getTeamEnds,
    replaceTeamEnds: apiMocks.replaceTeamEnds,
    getGames: apiMocks.getGames,
    replaceGames: apiMocks.replaceGames,
    getCameraMotion: apiMocks.getCameraMotion,
    getCameraMotionFrames: apiMocks.getCameraMotionFrames,
    getPlayerTracking: apiMocks.getPlayerTracking,
    getPlayerTrackingFrames: apiMocks.getPlayerTrackingFrames,
    upsertOperatorSession: vi.fn<() => Promise<OperatorTime>>(async () => ({
      active_seconds: 0,
      calibrate_seconds: 0,
      annotate_seconds: 0,
      review_seconds: 0,
    })),
  };
});

const MATCH: MatchDetail = {
  id: "match-selection",
  date: "2026-04-12",
  tournament: "PPA Atlanta Open 2026",
  team_a: ["Anna Bright", "Ben Johns"],
  team_b: ["Cara Lee", "Dan Kim"],
  franchise_a: null,
  franchise_b: null,
  video_status: "ready",
  annotation_mode: "gold",
  assisted_ratio_budget: 0.25,
  broadcast_seconds: null,
  operator_time_ratio: null,
  operator_time: {
    active_seconds: 0,
    calibrate_seconds: 0,
    annotate_seconds: 0,
    review_seconds: 0,
  },
  footage_job: null,
  done_rallies: 0,
  total_rallies: 1,
  fix_command: null,
  source_url: null,
  original_present: true,
  team_a_id: "A",
  team_b_id: "B",
  players: [...ROSTER.players],
};

const at = (x: number, y: number): ShotPosition => ({
  position: observed({ x, y }),
  settled: inferred(Math.abs(y) <= 9),
});

function sampleGames(): Game[] {
  const r1 = numberShots({
    ...newRally(1, 100),
    end_frame: 300,
    status: "in_progress",
    score: observed({ serving: 0, receiving: 0, server_number: 2 }),
    serving_team_id: observed("A"),
    server_id: observed("a1"),
    returner_id: observed("b1"),
    entries: [
      {
        ...newShot(120),
        hitter_id: observed("a1"),
        positions: {
          a1: at(-4, -20),
          a2: at(4, -20),
          b1: at(4, 20),
          b2: at(-4, 8),
        },
      },
      {
        ...newShot(180),
        hitter_id: observed("b1"),
        positions: {
          a1: at(-3, -15),
          a2: at(3, -14),
          b1: at(3, 18),
          b2: at(-3, 7),
        },
      },
    ],
  });
  return [{ number: 1, rallies: [r1] }];
}

function liveTrackingFrames(): PlayerTrackingFramesOut {
  // Live tracked positions at frame 120 (distinct from Shot 1's recorded (-4, -20)).
  return {
    start_frame: 120,
    end_frame: 120,
    frames: [
      {
        frame: 120,
        near_team_id: "A",
        players: [
          {
            player_id: "a1",
            position_x: 2,
            position_y: -8,
            position_certainty: "inferred",
            zone: "frontcourt",
            settled: true,
            settled_certainty: "inferred",
            image_x: null,
            image_y: null,
            bbox: null,
            anchor_kind: null,
          },
          {
            player_id: "a2",
            position_x: -2,
            position_y: -8,
            position_certainty: "inferred",
            zone: "frontcourt",
            settled: true,
            settled_certainty: "inferred",
            image_x: null,
            image_y: null,
            bbox: null,
            anchor_kind: null,
          },
          {
            player_id: "b1",
            position_x: 1,
            position_y: 9,
            position_certainty: "inferred",
            zone: "frontcourt",
            settled: false,
            settled_certainty: "inferred",
            image_x: null,
            image_y: null,
            bbox: null,
            anchor_kind: null,
          },
          {
            player_id: "b2",
            position_x: -1,
            position_y: 9,
            position_certainty: "inferred",
            zone: "frontcourt",
            settled: false,
            settled_certainty: "inferred",
            image_x: null,
            image_y: null,
            bbox: null,
            anchor_kind: null,
          },
        ],
        detections: [],
      },
    ],
  };
}

function renderWorkspace(workspace: WorkspaceName, games = sampleGames()) {
  apiMocks.getGames.mockResolvedValue(games);
  apiMocks.replaceGames.mockImplementation(async (_id: string, next: Game[]) => next);
  apiMocks.replacePlayerAnchors.mockImplementation(
    async (_id: string, next: PlayerAnchor[]) => next,
  );
  apiMocks.replaceTeamEnds.mockImplementation(async (_id: string, next: TeamEnd[]) => next);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Workspace match={MATCH} workspace={workspace} />
    </QueryClientProvider>,
  );
  const video = view.container.querySelector<HTMLVideoElement>("video")!;
  Object.defineProperties(video, {
    duration: { value: 20, configurable: true },
    clientWidth: { value: 1000, configurable: true },
    clientHeight: { value: 500, configurable: true },
    videoWidth: { value: 1000, configurable: true },
    videoHeight: { value: 500, configurable: true },
    offsetLeft: { value: 0, configurable: true },
    offsetTop: { value: 0, configurable: true },
  });
  fireEvent(video, new Event("loadedmetadata"));
  return { ...view, video };
}

function renderAnnotateWorkspace(games = sampleGames()) {
  return renderWorkspace("annotate", games);
}

beforeEach(() => {
  HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
  HTMLVideoElement.prototype.cancelVideoFrameCallback = () => {};
  apiMocks.getPlaySegments.mockResolvedValue([
    { start_frame: 0, end_frame: 600, camera_view: "main" },
  ]);
  apiMocks.replacePlaySegments.mockImplementation(async (_id, segments) => segments);
  apiMocks.getCalibrations.mockResolvedValue([]);
  apiMocks.getPlayerAnchors.mockResolvedValue([]);
  apiMocks.getTeamEnds.mockResolvedValue([]);
  apiMocks.getCameraMotion.mockResolvedValue({
    status: "ready",
    total_spans: 1,
    tracked_spans: 1,
    unmapped_ranges: [],
    spans: [],
    error: null,
  });
  apiMocks.getCameraMotionFrames.mockResolvedValue({
    start_frame: 0,
    end_frame: 0,
    court_to_image: [],
    lens: [],
    unmapped: [],
  });
  apiMocks.getPlayerTracking.mockResolvedValue({
    status: "ready",
    device: "cpu",
    total_segments: 1,
    tracked_segments: 1,
    progress: 100,
    spans: [],
    error: null,
    opposite_end_flip_y_ft: 2.0,
  });
  apiMocks.getPlayerTrackingFrames.mockResolvedValue(liveTrackingFrames());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Workspace Timeline paging", () => {
  it("keeps playing and resumes paging on the next frame after a middle drag", async () => {
    let frameCallback: VideoFrameRequestCallback | null = null;
    HTMLVideoElement.prototype.requestVideoFrameCallback = (callback) => {
      frameCallback = callback;
      return 1;
    };
    const { container, video } = renderAnnotateWorkspace();
    await screen.findByTitle("Game 1 Rally 1: frames 100–300");
    const ruler = container.querySelector<HTMLElement>(".ruler")!;
    const overviewWindow = container.querySelector<HTMLElement>(".overview-window")!;
    const timecode = container.querySelector(".timeline-timecode")!;
    vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 600 }));

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    Object.defineProperty(video, "paused", { value: false, configurable: true });
    fireEvent(video, new Event("play"));
    const pause = vi.spyOn(video, "pause");
    const emitFrame = (frame: number) =>
      act(() => frameCallback?.(0, { mediaTime: frame / 60 } as VideoFrameCallbackMetadata));

    fireEvent.pointerDown(ruler, { pointerId: 1, button: 1, buttons: 4, clientX: 300 });
    emitFrame(810);
    expect(overviewWindow.style.left).toBe("0%");

    fireEvent.pointerMove(ruler, { pointerId: 1, buttons: 4, clientX: 240 });
    expect(Number.parseFloat(overviewWindow.style.left)).toBeCloseTo((80 / 1200) * 100);
    const panned = overviewWindow.style.left;
    emitFrame(900);
    expect(timecode.textContent).toBe("00:00:15:00");
    expect(overviewWindow.style.left).toBe(panned);

    fireEvent.pointerUp(ruler, { pointerId: 1, button: 1, clientX: 240 });
    expect(overviewWindow.style.left).toBe(panned);
    emitFrame(960);
    expect(Number.parseFloat(overviewWindow.style.left)).toBeCloseTo((400 / 1200) * 100);
    expect(pause).not.toHaveBeenCalled();
  });
});

describe("Workspace Shot and Rally deselection", () => {
  it("switches Court back to live tracked positions and Live header when deselecting a Shot", async () => {
    const { container } = renderAnnotateWorkspace();
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });

    // Select Rally 1 (selects Shot 1 at contact frame 120).
    fireEvent.click(rallyRow);
    await waitFor(() =>
      expect(container.querySelector(".court-mode")?.textContent).toBe(
        "Shot 1 · contact 00:00:02:00",
      ),
    );
    // Shot 1 has a1 recorded at (-4, -20) -> SVG translate(-40, 200).
    expect(container.querySelector('[data-player-id="a1"]')?.getAttribute("transform")).toBe(
      "translate(-40, 200)",
    );

    // Clicking the Live button deselects the Shot, keeps the Rally, switches Inspector to Rally tab,
    // and renders live Player Tracking at frame 120: a1 at (2, -8) -> translate(20, 80).
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    await waitFor(() => {
      expect(container.querySelector(".court-mode")?.textContent).toBe("Live · 00:00:02:00");
      expect(container.querySelector('[data-player-id="a1"]')?.getAttribute("transform")).toBe(
        "translate(20, 80)",
      );
    });
    expect(screen.queryByRole("button", { name: "Live" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Rally" }).getAttribute("aria-selected")).toBe("true");
    expect(rallyRow.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Shot deselected: Court shows live tracking (Esc)")).toBeTruthy();

    // Selecting Shot 1 again and deselecting via its pin shows the shorter hint on repeat.
    const pin1 = screen.getByRole("button", { name: "Shot 1 at frame 120" });
    fireEvent.pointerDown(pin1, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(pin1, { pointerId: 1, clientX: 120 });
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    fireEvent.pointerDown(pin1, { pointerId: 2, clientX: 120 });
    fireEvent.pointerUp(pin1, { pointerId: 2, clientX: 120 });
    expect(container.querySelector(".court-mode")?.textContent).toBe("Live · 00:00:02:00");
    expect(screen.getByText("Shot deselected")).toBeTruthy();
  });

  it("Esc closes an inline form first, then steps from Shot to Rally to nothing", async () => {
    const { container } = renderAnnotateWorkspace();
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });
    fireEvent.click(rallyRow);
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    // Open Rally details form with Shift+S; Esc only closes the form, preserving Shot selection.
    fireEvent.keyDown(window, { key: "S", code: "KeyS", shiftKey: true });
    expect(screen.getByRole("form", { name: "Rally details" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Rally details" })).toBeNull();
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    // First Esc with no form open deselects the Shot and switches to the Rally tab.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".court-mode")?.textContent).toBe("Live · 00:00:02:00");
    expect(screen.getByRole("tab", { name: "Rally" }).getAttribute("aria-selected")).toBe("true");
    expect(rallyRow.getAttribute("aria-pressed")).toBe("true");

    // Second Esc deselects the Rally.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(rallyRow.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Rally deselected")).toBeTruthy();
    expect(screen.getByText(/No Rally selected/)).toBeTruthy();
  });

  it("clicking the selected Rally row or Timeline clip deselects both Rally and Shot, and Shift+I starts a new Rally", async () => {
    const { container } = renderAnnotateWorkspace();
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });
    fireEvent.click(rallyRow);
    expect(rallyRow.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    // Clicking the selected Rally row deselects it.
    fireEvent.click(rallyRow);
    expect(rallyRow.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".court-mode")?.textContent).toBe("Live · 00:00:02:00");
    expect(screen.getByText("Rally deselected")).toBeTruthy();

    // Selecting again and clicking its Timeline clip also deselects both Rally and Shot.
    fireEvent.click(rallyRow);
    const clip = container.querySelector<HTMLButtonElement>(".clip.on")!;
    fireEvent.click(clip);
    expect(rallyRow.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".clip.on")).toBeNull();
    expect(container.querySelector(".pin.on")).toBeNull();

    // Step forward past Rally 1 (120 + 600 = 720); with no Rally selected, Shift+I starts R2 there.
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(window, { key: "I", code: "KeyI", shiftKey: true });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalled());
    const rows = within(rallyList).getAllByRole("button", { name: /R\d/ });
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain("720–…");
  });

  it("pauses at a Rally end when selected, and plays past it once the Rally is deselected", async () => {
    let frameCallback: VideoFrameRequestCallback | null = null;
    HTMLVideoElement.prototype.requestVideoFrameCallback = (cb) => {
      frameCallback = cb;
      return 1;
    };
    const { container, video } = renderAnnotateWorkspace();
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });

    let paused = true;
    Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
    const pauseSpy = vi.spyOn(video, "pause").mockImplementation(() => {
      paused = true;
      video.dispatchEvent(new Event("pause"));
    });

    const emitFrame = (f: number) =>
      act(() => {
        frameCallback?.(0, {
          mediaTime: f / 60,
        } as VideoFrameCallbackMetadata);
      });

    // With Rally 1 selected (100–300), playing past frame 300 pauses at the Rally end.
    fireEvent.click(rallyRow);
    paused = false;
    fireEvent(video, new Event("play"));
    emitFrame(305);
    await waitFor(() => expect(pauseSpy).toHaveBeenCalledTimes(1));

    // Deselect Rally 1, seek back inside it (120), and play past 300: playback does not pause.
    fireEvent.click(rallyRow);
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    pauseSpy.mockClear();
    paused = false;
    fireEvent(video, new Event("play"));
    emitFrame(305);
    await waitFor(() =>
      expect(container.querySelector(".court-mode")?.textContent).toBe("Live · 00:00:05:05"),
    );
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it("deselects an Observation Gap without consuming the one-time Shot deselect hint", async () => {
    const games = sampleGames();
    const rally = games[0]!.rallies[0]!;
    rally.entries = [rally.entries[0]!, { type: "gap", missing: "odd" }, rally.entries[1]!];

    const { container } = renderAnnotateWorkspace(games);
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });
    const gapPill = container.querySelector<HTMLButtonElement>(".gap-pill")!;

    // Select the Observation Gap, then click it again to deselect.
    fireEvent.click(gapPill);
    expect(gapPill.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(gapPill);
    expect(gapPill.getAttribute("aria-pressed")).toBe("false");
    expect(rallyRow.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("tab", { name: "Rally" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Observation Gap deselected")).toBeTruthy();

    // Selecting the gap and pressing Esc also deselects it and keeps the Rally.
    fireEvent.click(gapPill);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(gapPill.getAttribute("aria-pressed")).toBe("false");
    expect(rallyRow.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("tab", { name: "Rally" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Observation Gap deselected")).toBeTruthy();

    // The one-time Shot hint is still unused: deselecting a Shot shows the full message.
    const pin1 = screen.getByRole("button", { name: "Shot 1 at frame 120" });
    fireEvent.pointerDown(pin1, { pointerId: 1, clientX: 120 });
    fireEvent.pointerUp(pin1, { pointerId: 1, clientX: 120 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("Shot deselected: Court shows live tracking (Esc)")).toBeTruthy();
  });

  it("handles Esc in Review mode (closes form first, steps Shot → Rally, ignores repeat/modifiers)", async () => {
    const { container } = renderWorkspace("review");
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });

    // Select Rally 1 (selects Shot 1).
    fireEvent.click(rallyRow);
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    // Repeat and modified Esc presses do nothing.
    fireEvent.keyDown(window, { key: "Escape", repeat: true });
    fireEvent.keyDown(window, { key: "Escape", shiftKey: true });
    fireEvent.keyDown(window, { key: "Escape", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Escape", metaKey: true });
    fireEvent.keyDown(window, { key: "Escape", altKey: true });
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    // Open Rally details form via the Rally tab; Esc closes only the form, keeping Shot 1 selected.
    fireEvent.click(screen.getByRole("tab", { name: "Rally" }));
    fireEvent.click(screen.getByRole("button", { name: "Score called" }));
    expect(screen.getByRole("form", { name: "Rally details" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Rally details" })).toBeNull();
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    // First Esc with no form open deselects Shot 1 (keeps Rally 1).
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".court-mode")?.textContent).toBe("Live · 00:00:02:00");
    expect(rallyRow.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("tab", { name: "Rally" }).getAttribute("aria-selected")).toBe("true");

    // Second Esc deselects Rally 1.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(rallyRow.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Rally deselected")).toBeTruthy();
  });

  it("documents Esc deselection and Monitor landing clicks in the ShortcutSheet", () => {
    HTMLDialogElement.prototype.showModal = vi.fn<() => void>();
    render(<ShortcutSheet onClose={vi.fn<() => void>()} />);
    expect(
      screen.getByText(
        "Close a form, cancel Player placement, or deselect the Shot then the Rally",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Set the landing (ground bounce on mapped frames; Alt+click video over a Player)",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Cancel Player placement in Annotate")).toBeTruthy();
    expect(
      screen.getByText("Split Rally at playhead (when strictly inside the selected Rally)"),
    ).toBeTruthy();
  });
});

function mockLayerRect(layer: HTMLElement) {
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

function mappedCalibration(
  courtToImage: number[][] | null,
  cameraView: "main" | "sideline" = "main",
): CalibrationOut {
  return {
    camera_view: cameraView,
    effective_from_frame: 0,
    reference_frame: 0,
    landmarks: {},
    not_visible: [],
    complete: courtToImage !== null,
    image_to_court: courtToImage,
    court_to_image: courtToImage,
    errors: {},
    resolved_landmarks: {},
    unmapped_landmarks: [],
    worst_error_ft: courtToImage ? 0.1 : null,
    needs_attention: false,
  };
}

describe("Monitor landing clicks and leaving Player placement (#94)", () => {
  const CONTACT_MATRIX = [
    [0.04, 0, 0.5],
    [0, -0.02, 0.5],
    [0, 0, 1],
  ];
  // Shifted matrix at the bounce frame (distinct from contact frame) so tests prove the playhead
  // frame's matrix + lens is used rather than the Shot's contact frame.
  const BOUNCE_MATRIX = [
    [0.025, 0, 0.52],
    [0, -0.015, 0.48],
    [0, 0, 1],
  ];
  const BOUNCE_LENS = { k1: 0.09, aspect: 16 / 9 };

  it("maps Monitor click at the playhead frame with lens distortion, draws landing ✕, works with Players off, and undoes in one step", async () => {
    apiMocks.getPlaySegments.mockResolvedValue([
      { start_frame: 0, end_frame: 600, camera_view: "sideline" },
    ]);
    apiMocks.getCalibrations.mockResolvedValue([mappedCalibration(CONTACT_MATRIX, "sideline")]);
    apiMocks.getCameraMotion.mockResolvedValue({
      status: "ready",
      total_spans: 1,
      tracked_spans: 1,
      unmapped_ranges: [],
      spans: [
        {
          start_frame: 0,
          end_frame: 600,
          camera_view: "sideline",
          calibration_effective_from: 0,
          calibration_reference_frame: 0,
          tracked: true,
          mapped_frames: 601,
          unmapped_frames: 0,
          unmapped_ranges: [],
        },
      ],
      error: null,
    });
    apiMocks.getCameraMotionFrames.mockResolvedValue({
      start_frame: 0,
      end_frame: 600,
      court_to_image: Array.from({ length: 601 }, (_, f) =>
        f === 121 ? BOUNCE_MATRIX : CONTACT_MATRIX,
      ),
      lens: Array.from({ length: 601 }, (_, f) => (f === 121 ? BOUNCE_LENS : null)),
      unmapped: Array.from({ length: 601 }, () => false),
    });

    const { container } = renderWorkspace("annotate");
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });
    fireEvent.click(rallyRow);
    // Step 1 frame forward from contact frame 120 -> bounce frame 121.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    // A static Calibration can show the crosshair before the tracked window starts loading.
    await waitFor(() => {
      expect(apiMocks.getCameraMotionFrames).toHaveBeenCalled();
      expect(container.querySelector(".player-layer.landing-click")).not.toBeNull();
    });

    const layer = container.querySelector<HTMLElement>(".player-layer")!;
    mockLayerRect(layer);

    // Click at image (0.7, 0.3) -> (700, 150) on bounce frame 121.
    const click = { x: 0.7, y: 0.3 };
    const expected = unproject(BOUNCE_MATRIX, click, BOUNCE_LENS)!;
    const withoutLens = unproject(BOUNCE_MATRIX, click, null)!;
    expect(Math.hypot(expected.x - withoutLens.x, expected.y - withoutLens.y)).toBeGreaterThan(0.2);

    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 700, clientY: 150 });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalled());

    const savedShot = apiMocks.replaceGames.mock.calls.at(-1)![1][0]!.rallies[0]!.entries[0]!;
    if (savedShot.type !== "shot") throw new Error("expected Shot");
    expect(savedShot.landing.certainty).toBe("observed");
    expect(savedShot.landing.value).not.toBeNull();
    expect(savedShot.landing.value!.x).toBeCloseTo(expected.x, 5);
    expect(savedShot.landing.value!.y).toBeCloseTo(expected.y, 5);

    // Landing ✕ appears on both the Monitor and the Court in Team A colour (hitter is a1).
    const monitorMark = container.querySelector<SVGSVGElement>(".monitor-landing.team-a");
    expect(monitorMark).not.toBeNull();
    expect(Number.parseFloat(monitorMark!.style.left)).toBeCloseTo(70, 1);
    expect(Number.parseFloat(monitorMark!.style.top)).toBeCloseTo(30, 1);
    expect(container.querySelector(".court .landing.team-a")).not.toBeNull();

    // Toggling the Players overlay off still shows the landing ✕ and accepts landing clicks.
    fireEvent.click(screen.getByRole("button", { name: "Players" }));
    expect(container.querySelector(".monitor-landing.team-a")).not.toBeNull();
    const layerNoPlayers = container.querySelector<HTMLElement>(".player-layer")!;
    mockLayerRect(layerNoPlayers);
    // Click near the edge (0.95, 0.01): unprojects just past COURT_BOUNDS (~18.6, ~33.8) and clamps to (16, 32).
    fireEvent.pointerDown(layerNoPlayers, { pointerId: 2, button: 0, clientX: 950, clientY: 5 });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalledTimes(2));
    const clampedShot = apiMocks.replaceGames.mock.calls.at(-1)![1][0]!.rallies[0]!.entries[0]!;
    if (clampedShot.type !== "shot") throw new Error("expected Shot");
    expect(clampedShot.landing).toEqual(observed({ x: 16, y: 32 }));

    // One undo step reverts the second landing click back to the first.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() =>
      expect(
        Number.parseFloat(container.querySelector<SVGSVGElement>(".monitor-landing")!.style.left),
      ).toBeCloseTo(70, 1),
    );
  });

  it("treats unmapped frames (loading, outside segment, no Calibration, unmapped motion, above/near horizon) as no-ops with status reasons", async () => {
    let resolveFrames!: (value: CameraMotionFramesOut) => void;
    const pendingFrames = new Promise<CameraMotionFramesOut>((resolve) => {
      resolveFrames = resolve;
    });
    apiMocks.getPlaySegments.mockResolvedValue([
      { start_frame: 0, end_frame: 600, camera_view: "main" },
    ]);
    apiMocks.getCalibrations.mockResolvedValue([mappedCalibration(CONTACT_MATRIX, "main")]);
    apiMocks.getCameraMotion.mockResolvedValue({
      status: "ready",
      total_spans: 1,
      tracked_spans: 1,
      unmapped_ranges: [{ start_frame: 120, end_frame: 120, camera_view: "main" }],
      spans: [
        {
          start_frame: 0,
          end_frame: 600,
          camera_view: "main",
          calibration_effective_from: 0,
          calibration_reference_frame: 0,
          tracked: true,
          mapped_frames: 600,
          unmapped_frames: 1,
          unmapped_ranges: [{ start_frame: 120, end_frame: 120, camera_view: "main" }],
        },
      ],
      error: null,
    });
    apiMocks.getCameraMotionFrames.mockReturnValueOnce(pendingFrames);

    const { container } = renderWorkspace("annotate");
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });
    fireEvent.click(rallyRow);
    await waitFor(() => expect(apiMocks.getCameraMotionFrames).toHaveBeenCalled());

    const layer = container.querySelector<HTMLElement>(".player-layer")!;
    mockLayerRect(layer);

    // 0) Frame 121 while tracked Camera Motion window is still loading -> no-op with loading reason.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.pointerDown(layer, { pointerId: 10, button: 0, clientX: 500, clientY: 250 });
    expect(
      screen.getByText("Loading Camera Motion for this frame; try again in a moment"),
    ).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // Resolve Camera Motion frames (horizon at y_img = 0.2 on frame 121).
    await act(async () => {
      resolveFrames({
        start_frame: 0,
        end_frame: 600,
        court_to_image: Array.from({ length: 601 }, (_, f) =>
          f === 120
            ? null
            : [
                [0.02, 0, 0.5],
                [0, 0.01, 0.6],
                [0, 0.05, 1],
              ],
        ),
        lens: Array.from({ length: 601 }, () => null),
        unmapped: Array.from({ length: 601 }, (_, f) => f === 120),
      });
      await pendingFrames;
    });
    await waitFor(() =>
      expect(container.querySelector(".player-layer.landing-click")).not.toBeNull(),
    );

    // 1) Above horizon (y_img = 0.1) and just below horizon (y_img = 0.22 -> y = 380 ft): both rejected.
    fireEvent.pointerDown(layer, { pointerId: 2, button: 0, clientX: 500, clientY: 50 });
    expect(screen.getByText(/off the court plane/i)).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    fireEvent.pointerDown(layer, { pointerId: 20, button: 0, clientX: 500, clientY: 110 });
    expect(screen.getByText(/off the court plane/i)).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // 2) Step back to frame 120: unmapped by Camera Motion.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 500, clientY: 250 });
    expect(
      screen.getByText("Frame unmapped by Camera Motion; set the landing on the Court"),
    ).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // 3) Step past frame 600 (Alt+→ jumps +600 frames to 720, outside Play Segment).
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    fireEvent.pointerDown(layer, { pointerId: 3, button: 0, clientX: 500, clientY: 250 });
    expect(
      screen.getByText("Frame is outside a Play Segment; set the landing on the Court"),
    ).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // 4) Uncalibrated Play Segment: no Calibration for Main View.
    cleanup();
    apiMocks.getCalibrations.mockResolvedValue([]);
    apiMocks.getCameraMotion.mockResolvedValue({
      status: "ready",
      total_spans: 0,
      tracked_spans: 0,
      unmapped_ranges: [],
      spans: [],
      error: null,
    });
    const noCal = renderWorkspace("annotate");
    const noCalRally = await within(
      noCal.container.querySelector<HTMLElement>(".rally-list")!,
    ).findByRole("button", { name: /R1/ });
    fireEvent.click(noCalRally);
    const noCalLayer = noCal.container.querySelector<HTMLElement>(".player-layer")!;
    mockLayerRect(noCalLayer);
    fireEvent.pointerDown(noCalLayer, { pointerId: 1, button: 0, clientX: 500, clientY: 250 });
    expect(screen.getByText("No Main View Calibration; set the landing on the Court")).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();
  });

  it("Esc clears a selected Player before deselecting the Shot, and clicking the selected Player again deselects them", async () => {
    apiMocks.getCalibrations.mockResolvedValue([mappedCalibration(CONTACT_MATRIX, "main")]);
    apiMocks.getPlayerTrackingFrames.mockResolvedValue({
      start_frame: 120,
      end_frame: 120,
      frames: [
        {
          frame: 120,
          near_team_id: "A",
          players: [
            {
              player_id: "a1",
              position_x: -4,
              position_y: -8,
              position_certainty: "observed",
              zone: "frontcourt",
              settled: true,
              settled_certainty: "observed",
              image_x: 0.3,
              image_y: 0.7,
              bbox: [0.25, 0.45, 0.35, 0.72],
              anchor_kind: null,
            },
            {
              player_id: "a2",
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
          ],
          detections: [
            {
              x1: 0.25,
              y1: 0.45,
              x2: 0.35,
              y2: 0.72,
              foot_x: 0.3,
              foot_y: 0.7,
              score: 0.9,
              ankles_visible: true,
              feet_cropped: false,
              court_x: -4,
              court_y: -8,
              player_id: "a1",
            },
          ],
        },
      ],
    });

    const { container } = renderWorkspace("annotate");
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });
    fireEvent.click(rallyRow);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Anna Bright foot position" })).toBeTruthy(),
    );

    const layer = container.querySelector<HTMLElement>(".player-layer")!;
    mockLayerRect(layer);
    const svg = container.querySelector<SVGSVGElement>("svg.court")!;
    svg.setPointerCapture = vi.fn<(pointerId: number) => void>();
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 672 }),
    );

    // Select Unknown Player a2 on the Court diagram -> arms `.placing` crosshair on Monitor.
    const courtA2 = svg.querySelector<SVGGElement>('[data-player-id="a2"]')!;
    fireEvent.pointerDown(courtA2, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(svg, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
    expect(courtA2.classList.contains("selected")).toBe(true);
    expect(layer.classList.contains("placing")).toBe(true);

    // Open Go-to popup (`/`): Esc closes only Go-to, preserving the selected Player and Shot.
    fireEvent.keyDown(window, { key: "/" });
    const gotoInput = screen.getByLabelText(/Go to a frame number/);
    fireEvent.keyDown(gotoInput, { key: "Escape" });
    expect(screen.queryByLabelText(/Go to a frame number/)).toBeNull();
    expect(layer.classList.contains("placing")).toBe(true);

    // Open inline form (Shift+S): Esc closes only the form; next Esc clears selected Player
    // (preserving Shot 1!); next Esc deselects Shot 1; final Esc deselects Rally 1.
    fireEvent.keyDown(window, { key: "S", code: "KeyS", shiftKey: true });
    expect(screen.getByRole("form", { name: "Rally details" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Rally details" })).toBeNull();
    expect(layer.classList.contains("placing")).toBe(true);
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(layer.classList.contains("placing")).toBe(false);
    expect(courtA2.classList.contains("selected")).toBe(false);
    expect(screen.getByText("Player placement cancelled")).toBeTruthy();
    expect(container.querySelector(".court-mode")?.textContent).toBe(
      "Shot 1 · contact 00:00:02:00",
    );

    // Now plain click on Monitor sets the landing cleanly (not blocked by a stuck placing state).
    fireEvent.pointerDown(layer, { pointerId: 2, button: 0, clientX: 500, clientY: 250 });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalledTimes(1));

    // Clicking a2 again on the Court selects then deselects a2.
    fireEvent.pointerDown(courtA2, { pointerId: 3, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(svg, { pointerId: 3, button: 0, clientX: 200, clientY: 200 });
    expect(courtA2.classList.contains("selected")).toBe(true);
    fireEvent.pointerDown(courtA2, { pointerId: 4, button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(svg, { pointerId: 4, button: 0, clientX: 200, clientY: 200 });
    expect(courtA2.classList.contains("selected")).toBe(false);

    // Clicking a1's foot dot on the Monitor overlay selects then deselects a1.
    const dotA1 = screen.getByRole("button", { name: "Anna Bright foot position" });
    fireEvent.pointerDown(dotA1, { pointerId: 5, button: 0, clientX: 300, clientY: 350 });
    fireEvent.pointerUp(layer, { pointerId: 5, button: 0, clientX: 300, clientY: 350 });
    expect(dotA1.classList.contains("selected")).toBe(true);
    fireEvent.pointerDown(dotA1, { pointerId: 6, button: 0, clientX: 300, clientY: 350 });
    fireEvent.pointerUp(layer, { pointerId: 6, button: 0, clientX: 300, clientY: 350 });
    expect(dotA1.classList.contains("selected")).toBe(false);

    // With no Player selected, Esc steps Shot -> Rally.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".court-mode")?.textContent).toBe("Live · 00:00:02:00");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("Rally deselected")).toBeTruthy();
  });

  it("leaves Calibrate → Players selection and Esc behaviour unchanged", async () => {
    const { container } = renderWorkspace("calibrate");
    fireEvent.click(screen.getByRole("tab", { name: "Players" }));
    const annaButton = screen.getByRole("button", { name: "Anna Bright" });
    expect(annaButton.getAttribute("aria-pressed")).toBe("true");

    // Clicking the already-selected Player in Calibrate → Players keeps them selected.
    fireEvent.click(annaButton);
    expect(annaButton.getAttribute("aria-pressed")).toBe("true");

    // Esc in Calibrate does not clear the selected Player.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(annaButton.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).not.toContain("Player placement cancelled");
  });
});

function openContextMenu(target: Element, name: string) {
  const mouse = { button: 2, clientX: 425, clientY: 200 };
  fireEvent.pointerDown(target, { ...mouse, pointerId: 1 });
  expect(fireEvent.contextMenu(target, mouse)).toBe(false);
  return within(screen.getByRole("menu", { name }));
}

function expectMenuItems(menu: ReturnType<typeof within>, items: [string, string?, string?][]) {
  expect(menu.getAllByRole("menuitem")).toHaveLength(items.length);
  for (const [name, shortcut, shortcutLabel = shortcut] of items) {
    const option = menu.getByRole("menuitem", { name });
    expect(option.getAttribute("aria-keyshortcuts")).toBe(shortcut ?? null);
    expect(option.querySelector("kbd")?.textContent).toBe(shortcutLabel);
  }
}

const rallyActions: [string, string?, string?][] = [
  ["Rally start at playhead", "Shift+I"],
  ["Rally end at playhead", "Shift+O"],
  ["Split Rally at playhead", "Meta+K Control+K", "⌘K / Ctrl+K"],
  ["Insert Unseen Rally after", "Shift+U"],
  ["Delete Rally", "Shift+Backspace"],
  ["Mark Done", "Enter"],
  ["Fit Rally"],
  ["Rally details", "Shift+S"],
];

describe("Workspace context menus", () => {
  it("opens the same menu on Rally clips and rows, selects without seeking, and dismisses it", async () => {
    const games = sampleGames();
    games[0]!.rallies.push(newRally(2));
    const { video, container } = renderAnnotateWorkspace(games);
    const playhead = video.currentTime;
    const clip = await screen.findByTitle("Game 1 Rally 1: frames 100–300");
    const row = within(container.querySelector<HTMLElement>(".rally-list")!).getByRole("button", {
      name: /R2/,
    });
    let menu = openContextMenu(clip, "Rally actions");
    expectMenuItems(menu, rallyActions);
    expect(clip.getAttribute("aria-pressed")).toBe("true");
    expect(video.currentTime).toBe(playhead);

    const first = menu.getByRole("menuitem", { name: "Rally start at playhead" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    const details = menu.getByRole("menuitem", { name: "Rally details" });
    expect(document.activeElement).toBe(details);
    fireEvent.keyDown(details, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(clip);
    expect(clip.getAttribute("aria-pressed")).toBe("true");

    menu = openContextMenu(row, "Rally actions");
    expectMenuItems(menu, rallyActions);
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(clip.getAttribute("aria-pressed")).toBe("false");
    expect(video.currentTime).toBe(playhead);
    const fit = menu.getByRole("menuitem", { name: "Fit Rally" });
    expect(fit.getAttribute("aria-disabled")).toBe("true");
    expect(fit.title).toBe("Select a framed Rally first");
    fireEvent.click(fit);
    expect(screen.queryByRole("menu")).toBeTruthy();
    fireEvent.click(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("explains why an open Rally's start can't move past its first Shot", async () => {
    const games = sampleGames();
    games[0]!.rallies[0]!.end_frame = null;
    renderAnnotateWorkspace(games);
    const clip = await screen.findByTitle("Game 1 Rally 1: frames 100–open");
    for (let step = 0; step < 3; step++) {
      fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    }
    const menu = openContextMenu(clip, "Rally actions");
    const start = menu.getByRole("menuitem", { name: "Rally start at playhead" });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(start.title).toBe("A Rally must start at or before its first Shot (frame 120)");
    fireEvent.click(start);
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();
  });

  it("selects a Shot or Observation Gap and flips its parity with the existing command", async () => {
    const games = sampleGames();
    const rally = games[0]!.rallies[0]!;
    rally.entries.splice(1, 0, { type: "gap", missing: "odd" });
    const { video } = renderAnnotateWorkspace(games);
    const playhead = video.currentTime;
    const pin = await screen.findByRole("button", { name: "Shot 2 at frame 180" });
    const gap = screen.getByRole("button", { name: "odd gap" });
    const shotMenu = openContextMenu(pin, "Shot actions");
    expectMenuItems(shotMenu, [
      ["Delete Shot", "Backspace"],
      ["Odd Observation Gap after", "G"],
      ["Even Observation Gap after", "Shift+G"],
      ["Swap hitter to partner", "X"],
      ["Switch hitter’s Team", "Shift+H"],
    ]);
    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(video.currentTime).toBe(playhead);

    const gapMenu = openContextMenu(gap, "Observation Gap actions");
    expectMenuItems(gapMenu, [
      ["Delete Observation Gap", "Backspace"],
      ["Change to even", "Shift+G"],
    ]);
    expect(gap.getAttribute("aria-pressed")).toBe("true");
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(video.currentTime).toBe(playhead);
    fireEvent.click(gapMenu.getByRole("menuitem", { name: "Change to even" }));
    expect(screen.getByText("Gap is now even")).toBeTruthy();
    const evenGap = screen.getByRole("button", { name: "even gap" });
    expectMenuItems(openContextMenu(evenGap, "Observation Gap actions"), [
      ["Delete Observation Gap", "Backspace"],
      ["Change to odd", "G"],
    ]);
  });

  it.each(["annotate", "calibrate", "review"] as const)(
    "shows the right Segment, Rally and empty lane availability in %s",
    async (workspace) => {
      const { container, video } = renderWorkspace(workspace);
      vi.spyOn(container.querySelector(".ruler")!, "getBoundingClientRect").mockReturnValue(
        DOMRect.fromRect({ width: 1200 }),
      );
      const segment = await screen.findByRole("button", {
        name: "Main View Play Segment, frames 0–600",
      });
      const row = container.querySelector<HTMLButtonElement>(".r-row")!;
      const playhead = video.currentTime;
      const segmentMenu = openContextMenu(segment, "Play Segment actions");
      expectMenuItems(segmentMenu, [
        ["Set Main View", "1"],
        ["Set Sideline View", "2"],
        ["Delete Play Segment", "Backspace"],
        ["Play Segment start at playhead", "Shift+I"],
        ["Play Segment end at playhead", "Shift+O"],
        ["Split Play Segment at playhead", "Meta+K Control+K", "⌘K / Ctrl+K"],
      ]);
      expect(segment.getAttribute("aria-pressed")).toBe("true");
      for (const option of segmentMenu.getAllByRole("menuitem")) {
        const reason =
          workspace !== "calibrate"
            ? "Available in Calibrate"
            : option.textContent?.startsWith("Split Play Segment")
              ? "Move the playhead past this Play Segment’s first frame"
              : "";
        expect(option.getAttribute("aria-disabled")).toBe(reason ? "true" : null);
        expect(option.title).toBe(reason);
      }
      if (workspace !== "calibrate") {
        fireEvent.click(segmentMenu.getByRole("menuitem", { name: "Delete Play Segment" }));
      }
      expect(apiMocks.replacePlaySegments).not.toHaveBeenCalled();

      const rallyMenu = openContextMenu(row, "Rally actions");
      const done = rallyMenu.getByRole("menuitem", { name: "Mark Done" });
      expect(done.getAttribute("aria-disabled")).toBe(workspace === "annotate" ? null : "true");
      expect(done.title).toBe(workspace === "annotate" ? "" : "Available in Annotate");

      const laneMenu = openContextMenu(
        container.querySelector(".lane.segments")!,
        "Timeline actions",
      );
      expectMenuItems(laneMenu, [
        ["Fit Rally"],
        ["Fit video"],
        ["Rally start at playhead", "Shift+I"],
      ]);
      expect(
        laneMenu.getByRole("menuitem", { name: "Fit Rally" }).getAttribute("aria-disabled"),
      ).toBe(workspace === "calibrate" ? "true" : null);
      expect(
        laneMenu.getByRole("menuitem", { name: "Fit video" }).getAttribute("aria-disabled"),
      ).toBeNull();
      expect(laneMenu.getByRole("menuitem", { name: "Rally start at playhead" }).title).toBe(
        workspace === "annotate" ? "" : "Available in Annotate",
      );
      expect(row.getAttribute("aria-pressed")).toBe("true");
      expect(video.currentTime).toBe(playhead);
    },
  );

  it("deletes the right-clicked Shot with the same save, status and undo as Backspace", async () => {
    const games = sampleGames();
    renderAnnotateWorkspace(games);
    const pin = await screen.findByRole("button", { name: "Shot 2 at frame 180" });
    const menu = openContextMenu(pin, "Shot actions");
    fireEvent.click(menu.getByRole("menuitem", { name: "Delete Shot" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("Shot deleted")).toBeTruthy();
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalledTimes(1));
    const edited = apiMocks.replaceGames.mock.lastCall![1];
    expect(edited[0]!.rallies[0]!.entries).toHaveLength(1);
    expect(edited[0]!.rallies[0]!.entries[0]).toMatchObject({ contact_frame: observed(120) });

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenLastCalledWith(MATCH.id, games));
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(screen.getByText("Nothing to undo")).toBeTruthy();
    const restored = screen.getByRole("button", { name: "Shot 2 at frame 180" });
    openContextMenu(restored, "Shot actions");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(screen.getByText("Shot deleted")).toBeTruthy();
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenLastCalledWith(MATCH.id, edited));
  });

  it("relabels a Play Segment from its clip menu or with 2 over the segment", async () => {
    const segments: PlaySegment[] = [
      { start_frame: 0, end_frame: 299, camera_view: "main" },
      { start_frame: 400, end_frame: 600, camera_view: "main" },
    ];
    apiMocks.getPlaySegments.mockResolvedValue(segments);
    const { video } = renderWorkspace("calibrate");
    const playhead = video.currentTime;
    const target = await screen.findByRole("button", {
      name: "Main View Play Segment, frames 400–600",
    });
    const menu = openContextMenu(target, "Play Segment actions");
    const markOut = menu.getByRole("menuitem", { name: "Play Segment end at playhead" });
    expect(markOut.getAttribute("aria-disabled")).toBe("true");
    expect(markOut.title).toBe("Move the playhead to or after this Play Segment’s start");
    fireEvent.click(menu.getByRole("menuitem", { name: "Set Sideline View" }));
    const changed = [segments[0]!, { ...segments[1]!, camera_view: "sideline" }];
    expect(screen.getByText("Sideline View Play Segment, frames 400–600")).toBeTruthy();
    expect(video.currentTime).toBe(playhead);
    await waitFor(() =>
      expect(apiMocks.replacePlaySegments).toHaveBeenCalledExactlyOnceWith(MATCH.id, changed),
    );

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() =>
      expect(apiMocks.replacePlaySegments).toHaveBeenLastCalledWith(MATCH.id, segments),
    );
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    const keyFrame = video.currentTime;
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByText("Sideline View Play Segment, frames 400–600")).toBeTruthy();
    expect(video.currentTime).toBe(keyFrame);
    await waitFor(() =>
      expect(apiMocks.replacePlaySegments).toHaveBeenLastCalledWith(MATCH.id, changed),
    );
  });

  it("splits the targeted Play Segment without seeking when the playhead is inside it", async () => {
    const first: PlaySegment = { start_frame: 0, end_frame: 80, camera_view: "main" };
    const second: PlaySegment = { start_frame: 100, end_frame: 200, camera_view: "sideline" };
    apiMocks.getPlaySegments.mockResolvedValue([first, second]);
    const { video } = renderWorkspace("calibrate");
    const target = await screen.findByRole("button", {
      name: "Sideline View Play Segment, frames 100–200",
    });
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    const blocked = openContextMenu(target, "Play Segment actions").getByRole("menuitem", {
      name: "Split Play Segment at playhead",
    });
    expect(blocked.title).toBe("Move the playhead inside this Play Segment");
    fireEvent.click(blocked);
    expect(apiMocks.replacePlaySegments).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    const playhead = video.currentTime;
    const split = openContextMenu(target, "Play Segment actions").getByRole("menuitem", {
      name: "Split Play Segment at playhead",
    });
    expect(split.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(split);
    await waitFor(() =>
      expect(apiMocks.replacePlaySegments).toHaveBeenCalledExactlyOnceWith(MATCH.id, [
        first,
        { ...second, end_frame: 119 },
        { ...second, start_frame: 120 },
      ]),
    );
    expect(video.currentTime).toBe(playhead);
  });

  it("keeps Play Segment shortcuts tied to the playhead and pending segment after clip clicks", async () => {
    const first: PlaySegment = { start_frame: 100, end_frame: 200, camera_view: "main" };
    const second: PlaySegment = { start_frame: 450, end_frame: 650, camera_view: "main" };
    apiMocks.getPlaySegments.mockResolvedValue([first, second]);
    const { container } = renderWorkspace("calibrate");
    vi.spyOn(container.querySelector(".ruler")!, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 1200 }),
    );
    const clip = await screen.findByTitle("Main View Play Segment, frames 100–200");
    fireEvent.pointerDown(clip, { pointerId: 1, clientX: 150 });
    fireEvent.pointerUp(clip, { pointerId: 1, clientX: 150 });
    expect(clip.getAttribute("aria-pressed")).toBe("true");
    for (let step = 0; step < 3; step++) {
      fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    }
    fireEvent.keyDown(window, { key: "I", shiftKey: true });
    expect(
      screen.getByText("Main View Play Segment from frame 330: Shift+O on its last frame"),
    ).toBeTruthy();
    expect(apiMocks.replacePlaySegments).not.toHaveBeenCalled();

    const laterClip = screen.getByTitle("Main View Play Segment, frames 450–650");
    fireEvent.pointerDown(laterClip, { pointerId: 2, clientX: 500 });
    fireEvent.pointerUp(laterClip, { pointerId: 2, clientX: 500 });
    expect(laterClip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByText("Pending: Sideline View")).toBeTruthy();
    fireEvent.keyDown(window, { key: "O", shiftKey: true });
    await waitFor(() =>
      expect(apiMocks.replacePlaySegments).toHaveBeenCalledExactlyOnceWith(MATCH.id, [
        first,
        { start_frame: 330, end_frame: 449, camera_view: "sideline" },
        second,
      ]),
    );
  });

  it("splits a Rally via ⌘K and context menu, autosaves, shows reasons when unavailable, and undoes in one step", async () => {
    const games = sampleGames();
    const { container } = renderAnnotateWorkspace(games);
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });

    // With no Rally selected, ⌘K is a no-op with a status-bar reason.
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByText("Select a Rally first")).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // Right-click Rally 1 while playhead is at frame 0 (before start 100): Split Rally is disabled with reason.
    const menuAtZero = openContextMenu(rallyRow, "Rally actions");
    const splitDisabled = menuAtZero.getByRole("menuitem", { name: "Split Rally at playhead" });
    expect(splitDisabled.getAttribute("aria-disabled")).toBe("true");
    expect(splitDisabled.title).toBe("Move the playhead past this Rally’s start (frame 100)");
    fireEvent.keyDown(splitDisabled, { key: "Escape" });

    // Select Rally 1 (seeks to Shot 1 at frame 120) and step +60 frames to Shot 2 at frame 180.
    fireEvent.click(rallyRow);
    fireEvent.click(rallyRow); // click once to deselect, then once to select & seek to 120
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });

    // Split with ⌘K at frame 180 (repeat press must not cascade into a second split):
    // R1 is 100–179 (Shot 120), R2 is 180–300 (Shot 180).
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true, repeat: true });
    expect(screen.getByText("Split Rally: G1 R1 (100–179) and G1 R2 (180–300)")).toBeTruthy();
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalledTimes(1));
    const afterSplit = apiMocks.replaceGames.mock.lastCall![1];
    expect(afterSplit[0]!.rallies.map((r) => [r.number, r.start_frame, r.end_frame])).toEqual([
      [1, 100, 179],
      [2, 180, 300],
    ]);

    // One undo step restores the original Rally exactly.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenLastCalledWith(MATCH.id, games));
    expect(within(rallyList).getAllByRole("button", { name: /R\d/ })).toHaveLength(1);

    // Split from the Rally clip context menu at frame 180 produces the same result and undoes cleanly.
    const clip = await screen.findByTitle("Game 1 Rally 1: frames 100–300");
    const menuInside = openContextMenu(clip, "Rally actions");
    const splitEnabled = menuInside.getByRole("menuitem", { name: "Split Rally at playhead" });
    expect(splitEnabled.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(splitEnabled);
    expect(screen.getByText("Split Rally: G1 R1 (100–179) and G1 R2 (180–300)")).toBeTruthy();
    await waitFor(() =>
      expect(apiMocks.replaceGames).toHaveBeenLastCalledWith(MATCH.id, afterSplit),
    );

    // Undo and split from the Rallies panel row context menu (enabled state).
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenLastCalledWith(MATCH.id, games));
    const restoredRow = within(rallyList).getByRole("button", { name: /R1/ });
    const rowMenu = openContextMenu(restoredRow, "Rally actions");
    const rowSplit = rowMenu.getByRole("menuitem", { name: "Split Rally at playhead" });
    expect(rowSplit.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(rowSplit);
    await waitFor(() =>
      expect(apiMocks.replaceGames).toHaveBeenLastCalledWith(MATCH.id, afterSplit),
    );
  });

  it("splits a non-G1-R1 Rally (G2 R2) from its context menu without touching earlier Rallies", async () => {
    const g1r1 = sampleGames()[0]!.rallies[0]!;
    const g2r1 = { ...newRally(1, 350), end_frame: 420 };
    const g2r2 = { ...newRally(2, 450), end_frame: 650 };
    const games: Game[] = [
      { number: 1, rallies: [g1r1] },
      { number: 2, rallies: [g2r1, g2r2] },
    ];
    const { container } = renderAnnotateWorkspace(games);
    const clip = await screen.findByTitle("Game 2 Rally 2: frames 450–650");
    // Click G2 R2 (seeks to frame 450), then step +60 frames to 510 (inside G2 R2).
    fireEvent.click(clip);
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });

    const menu = openContextMenu(clip, "Rally actions");
    fireEvent.click(menu.getByRole("menuitem", { name: "Split Rally at playhead" }));
    expect(screen.getByText("Split Rally: G2 R2 (450–509) and G2 R3 (510–650)")).toBeTruthy();
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalledTimes(1));
    const saved = apiMocks.replaceGames.mock.lastCall![1];
    expect(saved[0]!.rallies).toHaveLength(1);
    expect(saved[1]!.rallies.map((r) => [r.number, r.start_frame, r.end_frame])).toEqual([
      [1, 350, 420],
      [2, 450, 509],
      [3, 510, 650],
    ]);
    expect(
      within(container.querySelector<HTMLElement>(".rally-list")!).getAllByRole("button", {
        name: /R\d/,
      }),
    ).toHaveLength(4);
  });

  it("handles ⌘K before Rallies load and without a video loaded, leaving other Annotate keys ignored while loading", async () => {
    // 1) Before recording loads: ⌘K shows "Wait for Rallies to load", while other keys (e.g. M) stay ignored.
    let resolveGames!: (value: Game[]) => void;
    apiMocks.getGames.mockReturnValueOnce(
      new Promise<Game[]>((resolve) => {
        resolveGames = resolve;
      }),
    );
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <Workspace match={MATCH} workspace="annotate" />
      </QueryClientProvider>,
    );
    const addShotEvent = new KeyboardEvent("keydown", { key: "m", cancelable: true });
    window.dispatchEvent(addShotEvent);
    expect(addShotEvent.defaultPrevented).toBe(false);

    const splitWhileLoading = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(splitWhileLoading);
    });
    expect(splitWhileLoading.defaultPrevented).toBe(true);
    expect(screen.getByText("Wait for Rallies to load")).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // 2) Once Rallies load, with no video metadata loaded (totalFrames === 0), ⌘K explains "Load the video first".
    await act(async () => {
      resolveGames(sampleGames());
    });
    await within(view.container.querySelector<HTMLElement>(".rally-list")!).findByRole("button", {
      name: /R1/,
    });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByText("Load the video first")).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();
  });

  it("does not split Rallies on ⌘K in Calibrate or Review and explains the no-op in Review", async () => {
    const calibrate = renderWorkspace("calibrate");
    const calibrateRow = await within(
      calibrate.container.querySelector<HTMLElement>(".rally-list")!,
    ).findByRole("button", { name: /R1/ });
    // Select R1 (seeks to frame 120, inside both R1 and the Main View Play Segment 0–600).
    fireEvent.click(calibrateRow);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();
    await waitFor(() => expect(apiMocks.replacePlaySegments).toHaveBeenCalledTimes(1));

    cleanup();
    vi.clearAllMocks();

    const review = renderWorkspace("review");
    const reviewRow = await within(
      review.container.querySelector<HTMLElement>(".rally-list")!,
    ).findByRole("button", { name: /R1/ });
    fireEvent.click(reviewRow);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(
      screen.getByText(
        "Split Rally is available in Annotate; Split Play Segment is available in Calibrate",
      ),
    ).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();
    expect(apiMocks.replacePlaySegments).not.toHaveBeenCalled();
  });
});

describe("Split Play Segment shortcut", () => {
  const shortcut = { key: "k", metaKey: true };

  it("autosaves both halves in one undo step from Calibrate → Players", async () => {
    const original: PlaySegment = { start_frame: 0, end_frame: 120, camera_view: "sideline" };
    apiMocks.getPlaySegments.mockResolvedValue([original]);
    renderWorkspace("calibrate");
    await screen.findByTitle("Sideline View Play Segment, frames 0–120");
    fireEvent.keyDown(window, shortcut);
    expect(screen.getByText("Move the playhead past this Play Segment’s first frame")).toBeTruthy();
    expect(apiMocks.replacePlaySegments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Players" }));
    fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(window, shortcut);
    fireEvent.keyDown(window, { ...shortcut, repeat: true });
    expect(screen.getByText("Split Play Segment at frame 60")).toBeTruthy();
    await waitFor(() =>
      expect(apiMocks.replacePlaySegments).toHaveBeenCalledExactlyOnceWith(MATCH.id, [
        { ...original, end_frame: 59 },
        { ...original, start_frame: 60 },
      ]),
    );

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() =>
      expect(apiMocks.replacePlaySegments).toHaveBeenLastCalledWith(MATCH.id, [original]),
    );
    expect(screen.getByTitle("Sideline View Play Segment, frames 0–120")).toBeTruthy();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(screen.getByText("Nothing to undo")).toBeTruthy();
    expect(apiMocks.replacePlaySegments).toHaveBeenCalledTimes(2);
  });

  it("explains the no-op in review without changing Play Segments", async () => {
    renderWorkspace("review");
    await screen.findByTitle("Main View Play Segment, frames 0–600");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, shortcut);
    expect(
      screen.getByText(
        "Split Rally is available in Annotate; Split Play Segment is available in Calibrate",
      ),
    ).toBeTruthy();
    expect(apiMocks.replacePlaySegments).not.toHaveBeenCalled();
  });
});
