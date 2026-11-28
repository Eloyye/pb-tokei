// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { frameToSeekTime } from "../lib/frames";
import { newRally, newShot, numberShots, observed } from "../lib/rallyLog";
import { ROSTER } from "../lib/testRoster";
import { ShortcutSheet } from "../shell/ShortcutSheet";
import { wheelEvent } from "../test/wheelEvent";
import { Workspace } from "./Workspace";

const apiMocks = vi.hoisted(() => ({
  getPlaySegments: vi.fn<() => Promise<PlaySegment[]>>(),
  replacePlaySegments: vi.fn<(id: string, segments: PlaySegment[]) => Promise<PlaySegment[]>>(),
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
    replacePlaySegments: apiMocks.replacePlaySegments,
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
  total_rallies: 2,
  fix_command: null,
  source_url: null,
  original_present: true,
  footage_dir: "/data/footage",
  source_video_path: null,
  tournament_id: "t-1",
  tour: "ppa",
  franchise_match_id: null,
  franchise_a_id: null,
  franchise_b_id: null,
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
      { ...newShot(110), hitter_id: observed("a1"), landing: observed({ x: 0, y: 15 }) },
      {
        ...newShot(150),
        hitter_id: observed("b1"),
        contact_kind: observed("volley"),
        landing: observed({ x: 0, y: -18 }),
      }, // Red Check 4
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
  const client = new QueryClient();
  const tree = (active: typeof workspace) => (
    <QueryClientProvider client={client}>
      <Workspace match={MATCH} workspace={active} />
    </QueryClientProvider>
  );
  const result = render(tree(workspace));
  return { ...result, setWorkspace: (active: typeof workspace) => result.rerender(tree(active)) };
}

beforeEach(() => {
  // happy-dom lacks requestVideoFrameCallback / cancelVideoFrameCallback on HTMLVideoElement.
  HTMLVideoElement.prototype.requestVideoFrameCallback = () => 1;
  HTMLVideoElement.prototype.cancelVideoFrameCallback = () => {};
  apiMocks.getPlaySegments.mockResolvedValue([]);
  apiMocks.replacePlaySegments.mockImplementation(async (_id, segments) => segments);
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
  localStorage.clear();
  vi.clearAllMocks();
});

describe("Workspace Court layout", () => {
  it("swaps slots in Annotate and Review, preserves the video and sizes, and restores on reload", () => {
    const { container, setWorkspace, unmount } = renderWorkspace("annotate", []);
    const monitor = container.querySelector<HTMLElement>('[data-panel="monitor"]')!;
    const court = container.querySelector<HTMLElement>('[data-panel="court"]')!;
    const sizes = container.querySelector<HTMLElement>(".workspace")!.style.cssText;
    const video = loadVideoMetadata(container);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(monitor.classList.contains("area-main")).toBe(true);
    expect(court.classList.contains("area-side")).toBe(true);
    expect(court.querySelector("svg")?.getAttribute("data-orientation")).toBe("vertical");

    fireEvent.click(within(monitor).getByRole("button", { name: "Swap Court and Monitor" }));
    expect(court.classList.contains("area-main")).toBe(true);
    expect(monitor.classList.contains("area-side")).toBe(true);
    expect(court.querySelector("svg")?.getAttribute("data-orientation")).toBe("horizontal");
    expect(container.querySelector<HTMLElement>(".workspace")!.style.cssText).toBe(sizes);
    expect(monitor.querySelector("video")).toBe(video);
    expect(video.currentTime).toBe(frameToSeekTime(1));
    expect(within(monitor).getByRole("button", { name: "Play" })).toBeTruthy();
    expect(monitor.querySelector(".panel-head .monitor-readout")?.textContent).toBe("00:00:00:01");
    const players = within(monitor).getByRole("button", { name: "Players" });
    fireEvent.click(players);
    expect(players.getAttribute("aria-pressed")).toBe("false");
    for (const name of ["Swap A", "Swap B", "Swap ends"]) {
      expect(within(monitor).getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.pointerDown(court);
    fireEvent.pointerDown(video);
    expect(monitor.classList.contains("focused")).toBe(true);

    setWorkspace("calibrate");
    expect(monitor.classList.contains("area-main")).toBe(true);
    expect(screen.queryByRole("button", { name: "Swap Court and Monitor" })).toBeNull();
    fireEvent.keyDown(window, { key: "`" });
    expect(monitor.classList.contains("area-main")).toBe(true);

    setWorkspace("review");
    expect(monitor.classList.contains("area-side")).toBe(true);
    fireEvent.keyDown(window, { key: "`" });
    expect(monitor.classList.contains("area-main")).toBe(true);
    fireEvent.click(
      within(container.querySelector<HTMLElement>('[data-panel="court"]')!).getByRole("button", {
        name: "Swap Court and Monitor",
      }),
    );
    expect(monitor.classList.contains("area-side")).toBe(true);
    unmount();

    const reloaded = renderWorkspace("annotate", []);
    expect(reloaded.container.querySelector('[data-panel="court"].area-main')).toBeTruthy();
    expect(reloaded.container.querySelector('[data-panel="monitor"].area-side')).toBeTruthy();
  });

  it("remembers the orientation of each slot separately", () => {
    const { container, unmount } = renderWorkspace("annotate", []);
    const orientation = () =>
      within(container)
        .getByRole("img", { name: "Court diagram" })
        .getAttribute("data-orientation");
    fireEvent.click(screen.getByRole("button", { name: "Vertical" }));
    expect(orientation()).toBe("horizontal");
    fireEvent.keyDown(window, { key: "`" });
    expect(orientation()).toBe("horizontal");
    fireEvent.click(screen.getByRole("button", { name: "Horizontal" }));
    expect(orientation()).toBe("vertical");
    unmount();

    const reloaded = renderWorkspace("annotate", []);
    const svg = within(reloaded.container).getByRole("img", { name: "Court diagram" });
    expect(svg.getAttribute("data-orientation")).toBe("vertical");
    fireEvent.keyDown(window, { key: "`" });
    expect(svg.getAttribute("data-orientation")).toBe("horizontal");
  });

  it.each(["annotate", "calibrate"] as const)(
    "uses Space for a Court pan and for standalone playback in %s",
    (workspace) => {
      const { container } = renderWorkspace(workspace, []);
      const video = loadVideoMetadata(container);
      const play = vi.spyOn(video, "play").mockResolvedValue();
      if (workspace === "calibrate") {
        fireEvent.click(screen.getByRole("tab", { name: "Players" }));
      }
      const svg = container.querySelector<SVGSVGElement>("svg.court")!;
      vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
        DOMRect.fromRect({ width: 320, height: 672 }),
      );
      svg.setPointerCapture = vi.fn<(pointerId: number) => void>();
      fireEvent(svg, wheelEvent({ clientX: 160, clientY: 336, deltaY: -100 }));
      const drawing = svg.querySelector(".surround")!.parentElement!;
      expect(drawing.getAttribute("transform")).toBe("matrix(1.5 0 0 1.5 0 0)");

      const fit = screen.getByRole("button", { name: "Fit" });
      if (workspace === "annotate") fit.focus();
      const keyTarget = workspace === "annotate" ? fit : window;
      fireEvent.keyDown(keyTarget, { key: " " });
      fireEvent.pointerDown(svg, { pointerId: 1, clientX: 160, clientY: 336 });
      fireEvent.pointerMove(svg, { pointerId: 1, clientX: 190, clientY: 360 });
      fireEvent.pointerUp(svg, { pointerId: 1, clientX: 190, clientY: 360 });
      expect(fireEvent.keyUp(keyTarget, { key: " " })).toBe(false);
      expect(drawing.getAttribute("transform")).toBe("matrix(1.5 0 0 1.5 30 24)");
      expect(play).not.toHaveBeenCalled();

      fireEvent.click(fit);
      expect(drawing.getAttribute("transform")).toBe("matrix(1 0 0 1 0 0)");
      fireEvent.keyDown(window, { key: " " });
      fireEvent.keyUp(window, { key: " " });
      expect(play).toHaveBeenCalledTimes(1);
    },
  );

  it("drops a pending Space playback action on blur or when focus moves into a text input", () => {
    const { container } = renderWorkspace("annotate", []);
    const play = vi.spyOn(loadVideoMetadata(container), "play").mockResolvedValue();

    fireEvent.keyDown(window, { key: " " });
    fireEvent.blur(window);
    fireEvent.keyUp(window, { key: " " });
    expect(play).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "/" });
    const input = screen.getByRole("textbox", { name: /go to a frame number/i });
    expect(document.activeElement).toBe(input);
    fireEvent.keyUp(input, { key: " " });
    expect(play).not.toHaveBeenCalled();
  });

  it("lets a focused Court control handle Space without toggling playback", () => {
    const { container } = renderWorkspace("annotate", []);
    const play = vi.spyOn(loadVideoMetadata(container), "play").mockResolvedValue();
    const fit = screen.getByRole("button", { name: "Fit" });
    fit.focus();

    expect(fireEvent.keyDown(fit, { key: " " })).toBe(true);
    expect(fireEvent.keyUp(fit, { key: " " })).toBe(true);
    expect(play).not.toHaveBeenCalled();
  });

  it("replays the selected Rally from its start on Space release at its end", async () => {
    const { container } = renderWorkspace("annotate", sampleGames());
    const video = loadVideoMetadata(container);
    const play = vi.spyOn(video, "play").mockResolvedValue();
    await screen.findByTitle("Game 1 Rally 1: frames 100–300");
    fireEvent.click(container.querySelector(".r-row")!);
    fireEvent.keyDown(window, { key: "/" });
    const input = screen.getByRole("textbox", { name: /go to a frame number/i });
    fireEvent.change(input, { target: { value: "300" } });
    fireEvent.submit(input.closest("form")!);
    expect(video.currentTime).toBe(frameToSeekTime(300));

    fireEvent.keyDown(window, { key: " " });
    expect(play).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { key: " " });
    expect(video.currentTime).toBe(frameToSeekTime(100));
    expect(play).toHaveBeenCalledTimes(1);
  });
});

function loadVideoMetadata(container: HTMLElement) {
  const video = container.querySelector<HTMLVideoElement>("video")!;
  Object.defineProperty(video, "duration", { value: 20, configurable: true });
  fireEvent(video, new Event("loadedmetadata"));
  return video;
}

function mockFullTimelineRuler(container: HTMLElement) {
  const ruler = container.querySelector<HTMLElement>(".ruler")!;
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(DOMRect.fromRect({ width: 1200 }));
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

    // F8 in Review cycles through issues and shows hints in the status bar.
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
    expect(container.querySelectorAll(".r-row")[0]!.getAttribute("aria-pressed")).toBe("true");
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

  it("warns on missing Serve and Return landings across Timeline, Inspector, and StatusBar, and clears live on landing click", async () => {
    const games: Game[] = [
      {
        number: 1,
        rallies: [
          numberShots({
            ...newRally(1, 100),
            end_frame: 300,
            status: "in_progress",
            score: observed({ serving: 0, receiving: 0, server_number: 2 }),
            serving_team_id: observed("A"),
            server_id: observed("a1"),
            returner_id: observed("b1"),
            entries: [
              { ...newShot(110), hitter_id: observed("a1") },
              { ...newShot(150), hitter_id: observed("b1"), contact_kind: observed("bounce") },
            ],
          }),
        ],
      },
    ];
    const { container } = renderWorkspace("annotate", games);
    loadVideoMetadata(container);

    // StatusBar shows 2 amber issues (Serve and Return) and Timeline shows 2 amber triangles.
    const statusIssues = await screen.findByRole("button", { name: /● 2\s*issues/ });
    expect(statusIssues.querySelector(".sb-red")).toBeNull();
    expect(statusIssues.querySelector(".sb-amber")?.textContent).toBe("● 2");
    expect(container.querySelectorAll(".issue-tri.amber")).toHaveLength(2);

    // F8 jumps to Shot 1's Landing row with an inline amber badge.
    fireEvent.keyDown(window, { key: "F8" });
    expect(screen.getByText(/Issue 1\/2 · G1 R1 · Serve has no landing/)).toBeTruthy();
    const landingRow = screen.getByRole("button", { name: "Landing" }).closest(".insp-row")!;
    expect(landingRow.className).toContain("cursor");
    expect(landingRow.querySelector(".badge.amber")?.textContent).toContain("Serve has no landing");

    // Enter (Mark Done) is never blocked by the warning.
    fireEvent.keyDown(window, { key: "Enter" });
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalled());
    expect(container.querySelector(".r-row .st.done")).toBeTruthy();

    // Clicking the Court diagram records the Serve's landing and clears its warning live.
    const svg = container.querySelector<SVGSVGElement>("svg.court")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 672 }),
    );
    fireEvent.pointerDown(svg.querySelector(".zone-bc")!, {
      pointerId: 1,
      clientX: 160,
      clientY: 136,
    });
    await screen.findByRole("button", { name: /● 1\s*issue$/ });
    expect(container.querySelectorAll(".issue-tri.amber")).toHaveLength(1);
  });
});

describe("Workspace Timeline edge edits", () => {
  it.each(["annotate", "review"] as const)(
    "renders and commits Play Segment edges in %s",
    async (workspace) => {
      apiMocks.getPlaySegments.mockResolvedValue([
        { start_frame: 400, end_frame: 600, camera_view: "main" },
        { start_frame: 650, end_frame: 800, camera_view: "sideline" },
      ]);
      const { container } = renderWorkspace(workspace, sampleGames());
      loadVideoMetadata(container);
      mockFullTimelineRuler(container);
      const segment = await screen.findByTitle("Main View Play Segment, frames 400–600");
      expect(segment.querySelector(".seg-handle.start")).toBeTruthy();
      const handle = segment.querySelector(".seg-handle.end")!;
      fireEvent.pointerDown(handle, { pointerId: 1, clientX: 601 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
      expect(apiMocks.replacePlaySegments).not.toHaveBeenCalled();

      fireEvent.pointerUp(handle, { pointerId: 1, clientX: 700 });
      await waitFor(() =>
        expect(apiMocks.replacePlaySegments).toHaveBeenCalledExactlyOnceWith(MATCH.id, [
          { start_frame: 400, end_frame: 649, camera_view: "main" },
          { start_frame: 650, end_frame: 800, camera_view: "sideline" },
        ]),
      );
    },
  );

  it("previews the pointer frame and records one undoable Rally edit in Review", async () => {
    const games = sampleGames();
    const { container } = renderWorkspace("review", games);
    const video = loadVideoMetadata(container);
    mockFullTimelineRuler(container);
    const clip = await screen.findByTitle("Game 1 Rally 1: frames 100–300");
    const handle = clip.querySelector(".seg-handle.end")!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 301 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120 });
    expect(screen.getByText("Stopped at Shot 2's contact (frame 150)")).toBeTruthy();
    expect(video.currentTime).toBe(frameToSeekTime(120));
    expect(container.querySelector<HTMLElement>(".playhead")?.style.left).toBe("0%");
    expect(screen.getByRole("tab", { name: "Rally" }).getAttribute("aria-selected")).toBe("true");
    expect(apiMocks.replaceGames).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 120 });
    expect(video.currentTime).toBe(frameToSeekTime(0));
    expect(screen.getByTitle("Game 1 Rally 1: frames 100–150")).toBe(clip);
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenCalledTimes(1));

    fireEvent.pointerDown(handle, { pointerId: 2, clientX: 151 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 200 });
    expect(video.currentTime).toBe(frameToSeekTime(200));
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(video.currentTime).toBe(frameToSeekTime(0));
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 200 });
    expect(screen.getByTitle("Game 1 Rally 1: frames 100–300")).toBe(clip);
    await waitFor(() => expect(apiMocks.replaceGames).toHaveBeenLastCalledWith(MATCH.id, games));

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(screen.getByText("Nothing to undo")).toBeTruthy();
    expect(apiMocks.replaceGames).toHaveBeenCalledTimes(2);
  });
});
