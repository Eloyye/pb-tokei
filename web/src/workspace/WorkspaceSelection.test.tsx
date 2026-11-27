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
import { inferred, newRally, newShot, numberShots, observed } from "../lib/rallyLog";
import { ROSTER } from "../lib/testRoster";
import { ShortcutSheet } from "../shell/ShortcutSheet";
import { Workspace } from "./Workspace";

const apiMocks = vi.hoisted(() => ({
  getPlaySegments: vi.fn<() => Promise<PlaySegment[]>>(),
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

function renderWorkspace(workspace: "annotate" | "review" | "calibrate", games = sampleGames()) {
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
    expect(screen.getByText("Deselect the armed Player in Annotate")).toBeTruthy();
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
    await waitFor(() =>
      expect(container.querySelector(".player-layer.landing-click")).not.toBeNull(),
    );

    const layer = container.querySelector<HTMLElement>(".player-layer")!;
    mockLayerRect(layer);

    // Click at image (0.7, 0.3) -> (700, 150) on bounce frame 121.
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 700, clientY: 150 });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalled());

    const savedShot = apiMocks.replaceGames.mock.calls.at(-1)![1][0]!.rallies[0]!.entries[0]!;
    if (savedShot.type !== "shot") throw new Error("expected Shot");
    expect(savedShot.landing.certainty).toBe("observed");
    expect(savedShot.landing.value).not.toBeNull();
    // With CONTACT_MATRIX (no lens), (0.7, 0.3) would map to (5, 10); with BOUNCE_MATRIX + BOUNCE_LENS
    // it maps to roughly (7.3, 12.2).
    expect(savedShot.landing.value!.x).toBeGreaterThan(6.5);
    expect(savedShot.landing.value!.y).toBeGreaterThan(11.5);

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
    fireEvent.pointerDown(layerNoPlayers, { pointerId: 2, button: 0, clientX: 520, clientY: 240 });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalledTimes(2));

    // One undo step reverts the second landing click back to the first.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() =>
      expect(
        Number.parseFloat(container.querySelector<SVGSVGElement>(".monitor-landing")!.style.left),
      ).toBeCloseTo(70, 1),
    );
  });

  it("treats unmapped frames (outside segment, no Calibration, unmapped motion, above horizon) as no-ops with status reasons", async () => {
    // Frame 120: unmapped by Camera Motion. Frame 700: outside Play Segment (0..600).
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
    apiMocks.getCameraMotionFrames.mockResolvedValue({
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

    const { container } = renderWorkspace("annotate");
    const rallyList = container.querySelector<HTMLElement>(".rally-list")!;
    const rallyRow = await within(rallyList).findByRole("button", { name: /R1/ });
    fireEvent.click(rallyRow);
    await waitFor(() => expect(apiMocks.getCameraMotion).toHaveBeenCalled());

    const layer = container.querySelector<HTMLElement>(".player-layer")!;
    mockLayerRect(layer);

    // 1) Frame 120 is unmapped by Camera Motion.
    fireEvent.pointerDown(layer, { pointerId: 1, button: 0, clientX: 500, clientY: 250 });
    expect(
      screen.getByText("Frame unmapped by Camera Motion; set the landing on the Court"),
    ).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // 2) Step to frame 121 (mapped with horizon at y_img = 0.2): clicking above horizon (y = 0.1) is a no-op.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(container.querySelector(".player-layer.landing-click")).not.toBeNull(),
    );
    fireEvent.pointerDown(layer, { pointerId: 2, button: 0, clientX: 500, clientY: 50 });
    expect(screen.getByText(/above the court plane/i)).toBeTruthy();
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    // 3) Step past frame 600 (Alt+→ jumps +600 frames to 721, outside Play Segment).
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

    // Open inline form (Shift+S): first Esc closes only the form; second Esc clears selected Player
    // (preserving Shot 1!); third Esc deselects Shot 1; fourth Esc deselects Rally 1.
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
