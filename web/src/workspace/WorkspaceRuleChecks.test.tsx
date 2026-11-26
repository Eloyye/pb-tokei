// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  TeamEnd,
} from "../api/client";
import { newRally, newShot, numberShots, observed } from "../lib/rallyLog";
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
  id: "match-rule-checks",
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
  total_rallies: 2,
  fix_command: null,
  source_url: null,
  original_present: true,
  team_a_id: "A",
  team_b_id: "B",
  players: [...ROSTER.players],
};

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
      { ...newShot(110), hitter_id: observed("a1") },
      { ...newShot(150), hitter_id: observed("b1"), contact_kind: observed("volley") }, // Red Check 4
    ],
  });
  const r2Unseen = numberShots({
    ...newRally(2, null),
    end_frame: null,
    status: "in_progress",
    score: observed({ serving: -1, receiving: 0, server_number: 2 }), // Red Check 8
    serving_team_id: observed("A"),
  });
  return [{ number: 1, rallies: [r1, r2Unseen] }];
}

function renderWorkspace(workspace: "annotate" | "review" | "calibrate", games: Game[]) {
  apiMocks.getGames.mockResolvedValue(games);
  apiMocks.replaceGames.mockImplementation(async (_id: string, next: Game[]) => next);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Workspace match={MATCH} workspace={workspace} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // happy-dom lacks requestVideoFrameCallback / cancelVideoFrameCallback on HTMLVideoElement.
  HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
  HTMLVideoElement.prototype.cancelVideoFrameCallback = () => {};
  apiMocks.getPlaySegments.mockResolvedValue([]);
  apiMocks.getCalibrations.mockResolvedValue([]);
  apiMocks.getPlayerAnchors.mockResolvedValue([]);
  apiMocks.getTeamEnds.mockResolvedValue([]);
  apiMocks.getCameraMotion.mockResolvedValue({
    status: "idle",
    total_spans: 0,
    tracked_spans: 0,
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
    status: "idle",
    device: "cpu",
    total_segments: 0,
    tracked_segments: 0,
    progress: 0,
    spans: [],
    error: null,
    opposite_end_flip_y_ft: 2.0,
  });
  apiMocks.getPlayerTrackingFrames.mockResolvedValue({
    start_frame: 0,
    end_frame: 0,
    frames: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function loadVideoMetadata(container: HTMLElement) {
  const video = container.querySelector<HTMLVideoElement>("video")!;
  Object.defineProperty(video, "duration", { value: 20, configurable: true });
  fireEvent(video, new Event("loadedmetadata"));
}

describe("Workspace live rule checks and F8 navigation", () => {
  it("cycles issues with F8 / Shift+F8 (including Unseen Rallies), updates live on edit & undo/redo, and never blocks Enter", async () => {
    const { container } = renderWorkspace("annotate", sampleGames());
    loadVideoMetadata(container);
    // Wait for Games to load and StatusBar to display 2 red issues.
    const statusIssues = await screen.findByRole("button", { name: /● 2\s*issues/ });
    expect(statusIssues).toBeTruthy();

    // F8 jumps to Issue 1/2: G1 R1 Shot 2 two-bounce rule -> Shot tab, Contact Kind cursor.
    fireEvent.keyDown(window, { key: "F8" });
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Contact Kind" }).closest(".insp-row")?.className,
    ).toContain("cursor");

    // F8 again jumps to Issue 2/2: Unseen G1 R2 negative score -> Rally tab, Score called cursor.
    fireEvent.keyDown(window, { key: "F8" });
    expect(screen.getByText(/Issue 2\/2 · G1 R2 · Score cannot be negative\./)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Score called" }).closest(".insp-row")?.className,
    ).toContain("cursor");

    // Shift+F8 steps back to Issue 1/2 (Shot 2).
    fireEvent.keyDown(window, { key: "F8", shiftKey: true });
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();

    // Held/repeated F8 keydown is ignored and does not advance selection.
    fireEvent.keyDown(window, { key: "F8", repeat: true });
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();

    // F8 is ignored inside a text input.
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      fireEvent.keyDown(input, { key: "F8" });
      expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();
    } finally {
      input.remove();
    }

    // Pressing Enter (Mark Done) is NEVER blocked by Red issues!
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalled());
    const r1Row = container.querySelectorAll(".r-row")[0]!;
    expect(r1Row.querySelector(".st.done")).toBeTruthy();

    // Clicking the Timeline Shot triangle selects Shot 2, switches to Shot tab, and focuses Contact Kind.
    const tri = container.querySelector<HTMLButtonElement>(".issue-tri")!;
    fireEvent.click(tri);
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();

    // Fixing Shot 2 to Bounce (`b`) clears Issue 1 live across StatusBar, Timeline, and Rallies.
    fireEvent.keyDown(window, { key: "b" });
    await screen.findByRole("button", { name: /● 1\s*issue$/ });
    expect(container.querySelectorAll(".issue-tri")).toHaveLength(0);

    // Undo (Cmd+Z) restores Issue 1 live, and Redo (Shift+Cmd+Z) clears it again!
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await screen.findByRole("button", { name: /● 2\s*issues/ });
    expect(container.querySelectorAll(".issue-tri")).toHaveLength(1);

    fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
    await screen.findByRole("button", { name: /● 1\s*issue$/ });
    expect(container.querySelectorAll(".issue-tri")).toHaveLength(0);

    // StatusBar click jumps straight to the remaining Unseen Rally issue.
    fireEvent.click(screen.getByRole("button", { name: /● 1\s*issue$/ }));
    expect(screen.getByText(/Issue 1\/1 · G1 R2 · Score cannot be negative\./)).toBeTruthy();
  });

  it("navigates via F8 / Shift+F8 and 'Shot issues in this Rally' in Review", async () => {
    const { container } = renderWorkspace("review", sampleGames());
    await screen.findByRole("button", { name: /● 2\s*issues/ });

    // F8 in Review cycles through issues and shows hints via reviewMessage.
    fireEvent.keyDown(window, { key: "F8" });
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Contact Kind" }).closest(".insp-row")?.className,
    ).toContain("cursor");

    // F8 again advances to Unseen Rally 2 on the Rally tab; Shift+F8 steps back.
    fireEvent.keyDown(window, { key: "F8" });
    expect(screen.getByText(/Issue 2\/2 · G1 R2 · Score cannot be negative\./)).toBeTruthy();
    fireEvent.keyDown(window, { key: "F8", shiftKey: true });
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();

    // Clicking 'Shot issues in this Rally' from the Rally tab jumps back to Shot 2.
    fireEvent.click(container.querySelectorAll(".r-row")[0]!);
    fireEvent.click(screen.getByRole("tab", { name: "Rally" }));
    const shotIssueBtn = screen.getByRole("button", { name: /Shot 2:.*two-bounce rule/ });
    fireEvent.click(shotIssueBtn);
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Shot 2 must be a Bounce/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Contact Kind" }).closest(".insp-row")?.className,
    ).toContain("cursor");
  });

  it("shows 'No rule issues in this Match' on F8 when clean, and works in Review", async () => {
    const clean: Game[] = [
      {
        number: 1,
        rallies: [
          numberShots({
            ...newRally(1, 100),
            end_frame: 300,
            score: observed({ serving: 0, receiving: 0, server_number: 2 }),
            serving_team_id: observed("A"),
          }),
        ],
      },
    ];
    renderWorkspace("review", clean);
    await screen.findByRole("button", { name: "No issues" });
    fireEvent.keyDown(window, { key: "F8" });
    expect(screen.getByText("No rule issues in this Match")).toBeTruthy();
  });

  it("lists F8 / Shift+F8 in ShortcutSheet", () => {
    const showModal = vi.fn<() => void>();
    HTMLDialogElement.prototype.showModal = showModal;
    render(<ShortcutSheet onClose={vi.fn<() => void>()} />);
    expect(screen.getByText("Next / previous rule issue")).toBeTruthy();
    expect(screen.getByText("F8")).toBeTruthy();
    expect(screen.getByText("⇧F8")).toBeTruthy();
  });
});
