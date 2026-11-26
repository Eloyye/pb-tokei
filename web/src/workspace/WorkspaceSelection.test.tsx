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
  getTeamEnds: vi.fn<() => Promise<TeamEnd[]>>(),
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
    getTeamEnds: apiMocks.getTeamEnds,
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

function renderWorkspace(workspace: "annotate" | "review", games = sampleGames()) {
  apiMocks.getGames.mockResolvedValue(games);
  apiMocks.replaceGames.mockImplementation(async (_id: string, next: Game[]) => next);
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <Workspace match={MATCH} workspace={workspace} />
    </QueryClientProvider>,
  );
  const video = view.container.querySelector<HTMLVideoElement>("video")!;
  Object.defineProperty(video, "duration", { value: 20, configurable: true });
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

  it("documents Esc deselection in the ShortcutSheet", () => {
    HTMLDialogElement.prototype.showModal = vi.fn<() => void>();
    render(<ShortcutSheet onClose={vi.fn<() => void>()} />);
    expect(screen.getByText("Close a form, or deselect the Shot then the Rally")).toBeTruthy();
  });
});
