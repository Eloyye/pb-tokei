// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Match, type MatchDetail } from "../api/client";
import { MatchList } from "./MatchList";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  listMatches: vi.fn<Client["listMatches"]>(),
  updateMatch: vi.fn<Client["updateMatch"]>(),
}));

import { listMatches, updateMatch } from "../api/client";

function makeMatch(id: string, overrides: Partial<Match> = {}): Match {
  return {
    id,
    date: "2026-04-12",
    tournament: "PPA Atlanta Open 2026",
    team_a: ["Anna Bright", "Ben Johns"],
    team_b: ["Cara Lee", "Dan Kim"],
    discipline: "mixed_doubles",
    franchise_a: null,
    franchise_b: null,
    annotation_mode: "gold",
    assisted_ratio_budget: 0.25,
    broadcast_seconds: null,
    operator_time: {
      active_seconds: 0,
      calibrate_seconds: 0,
      annotate_seconds: 0,
      review_seconds: 0,
    },
    operator_time_ratio: null,
    video_status: "none",
    footage_job: null,
    done_rallies: 0,
    total_rallies: 0,
    ...overrides,
  };
}

function makeMatchDetail(match: Match): MatchDetail {
  return {
    ...match,
    fix_command: null,
    source_url: null,
    original_present: false,
    footage_dir: "/data/footage",
    source_video_path: null,
    tournament_id: "t-1",
    tour: "ppa",
    franchise_match_id: null,
    franchise_a_id: null,
    franchise_b_id: null,
    team_a_id: "team-a",
    team_b_id: "team-b",
    players: [
      {
        id: "a1",
        name: match.team_a[0]!,
        handedness: "right",
        gender: "female",
        team_id: "team-a",
        team: "a",
      },
      {
        id: "a2",
        name: match.team_a[1]!,
        handedness: "right",
        gender: "male",
        team_id: "team-a",
        team: "a",
      },
      {
        id: "b1",
        name: match.team_b[0]!,
        handedness: "left",
        gender: "female",
        team_id: "team-b",
        team: "b",
      },
      {
        id: "b2",
        name: match.team_b[1]!,
        handedness: "right",
        gender: "male",
        team_id: "team-b",
        team: "b",
      },
    ],
  };
}

function renderList() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: MatchList,
  });
  const editRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/matches/$matchId/edit",
    component: () => <div>Edit Match</div>,
  });
  const matchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/matches/$matchId/$workspace",
    component: () => <div>Match</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, editRoute, matchRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MatchList Video pills", () => {
  it("links each Match to its Edit page and Report", async () => {
    vi.mocked(listMatches).mockResolvedValue([makeMatch("m1"), makeMatch("m2")]);
    renderList();
    expect(
      (await screen.findAllByRole("link", { name: "Edit" })).map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual(["/matches/m1/edit", "/matches/m2/edit"]);
    expect(
      screen.getAllByRole("link", { name: "Report" }).map((link) => link.getAttribute("href")),
    ).toEqual(["/matches/m1/report", "/matches/m2/report"]);
  });

  it("offers New Match when the Rally Log has no Matches", async () => {
    vi.mocked(listMatches).mockResolvedValue([]);
    renderList();

    const link = await screen.findByRole("link", { name: "New Match" });
    expect(link.getAttribute("href")).toBe("/matches/new");
    expect(screen.getByText("No Matches yet.")).toBeTruthy();
  });

  it("shows live download/convert progress, Queued (n), Fetch failed, and static statuses", async () => {
    vi.mocked(listMatches).mockResolvedValue([
      makeMatch("m1", { video_status: "ready" }),
      makeMatch("m2", {
        video_status: "none",
        footage_job: { state: "downloading", queue_position: null, percent: 42.4 },
      }),
      makeMatch("m3", {
        video_status: "not_converted",
        footage_job: { state: "converting", queue_position: null, percent: 75 },
      }),
      makeMatch("m4", {
        video_status: "none",
        footage_job: { state: "queued", queue_position: 2, percent: null },
      }),
      makeMatch("m5", {
        video_status: "none",
        footage_job: { state: "error", queue_position: null, percent: null },
      }),
    ]);

    renderList();

    for (const text of [
      "Video ready",
      "Downloading 42%",
      "Converting 75%",
      "Queued (2)",
      "Fetch failed",
    ]) {
      const pill = await screen.findByText(text);
      expect(pill.tagName).toBe("SPAN");
      expect(pill.closest("button")).toBeNull();
    }
  });

  it("shows Rally progress, or that there are no Rallies yet", async () => {
    vi.mocked(listMatches).mockResolvedValue([
      makeMatch("m1", { done_rallies: 3, total_rallies: 12 }),
      makeMatch("m2", { tournament: "APP Chicago 2026" }),
    ]);
    renderList();

    expect(await screen.findByText("Progress")).toBeTruthy();
    expect(screen.getByTitle("3 of 12 Rallies Done").textContent).toContain("3 / 12");
    expect(screen.getByText("no Rallies yet")).toBeTruthy();
  });
});

it("shows Mode, Active and Ratio in Match order with the Assisted budget", async () => {
  const operator_time = {
    active_seconds: 900,
    calibrate_seconds: 240,
    annotate_seconds: 600,
    review_seconds: 60,
  };
  vi.mocked(listMatches).mockResolvedValue([
    makeMatch("gold"),
    makeMatch("at-budget", {
      annotation_mode: "assisted",
      operator_time,
      broadcast_seconds: 3600,
      operator_time_ratio: 0.25,
      done_rallies: 3,
      total_rallies: 12,
    }),
    makeMatch("over-budget", {
      annotation_mode: "assisted",
      operator_time,
      broadcast_seconds: 3000,
      operator_time_ratio: 0.3,
    }),
  ]);
  renderList();

  expect((await screen.findByText("Mode")).parentElement?.textContent).toBe(
    "DateTournamentDisciplineMatchFranchise MatchVideoModeProgressActiveRatio",
  );
  expect(screen.getByText("Gold").classList.contains("pill-none")).toBe(true);
  expect(
    screen.getAllByText("Assisted").every((pill) => pill.classList.contains("pill-active")),
  ).toBe(true);
  expect(screen.getByText("0:00")).toBeTruthy();
  expect(screen.getAllByTitle("Calibrate 4:00 · Annotate 10:00 · Review 1:00")).toHaveLength(2);
  const atBudget = screen.getByText("0.25");
  expect(atBudget.classList.contains("within-budget")).toBe(true);
  expect(screen.getByTitle("3 of 12 Rallies Done").closest("a")).toBe(atBudget.closest("a"));
  expect(screen.getByText("0.30").classList.contains("over-budget")).toBe(true);
  const unknown = screen.getByText("Gold").closest("a")?.querySelector(".ratio");
  expect(unknown?.textContent).toBe("—");
  expect(unknown?.classList.contains("within-budget")).toBe(false);
  expect(screen.getByText(/Assisted Annotation has a 0.25 budget/)).toBeTruthy();
});

describe("MatchList editable date", () => {
  it("shows — for an empty date, saves immediately on change, and refreshes server order", async () => {
    const dated = makeMatch("m1", {
      date: "2026-04-10",
      tournament: "Older Open",
      team_a: ["Alex One", "Avery Two"],
    });
    const undated = makeMatch("m2", {
      date: null,
      tournament: "Undated Open",
      team_a: ["Anna Bright", "Ben Johns"],
    });
    const updatedUndated = { ...undated, date: "2026-05-01" };
    vi.mocked(listMatches)
      .mockResolvedValueOnce([dated, undated])
      .mockResolvedValueOnce([updatedUndated, dated]);
    vi.mocked(updateMatch).mockResolvedValue(makeMatchDetail(updatedUndated));

    renderList();

    const dateButton = await screen.findByRole("button", {
      name: "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    });
    expect(dateButton.textContent).toBe("—");
    expect(screen.getByText("2026-04-10")).toBeTruthy();

    fireEvent.click(dateButton);
    const input = screen.getByLabelText<HTMLInputElement>(
      "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    );
    expect(input.type).toBe("date");
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "2026-05-01" } });

    await waitFor(() =>
      expect(updateMatch).toHaveBeenCalledWith("m2", { date: "2026-05-01" }, { rallyLog: null }),
    );
    fireEvent.blur(input);

    await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["2026-05-01", "2026-04-10"]);
    });
  });

  it("refuses clearing a date and ignores partial years while editing", async () => {
    const match = makeMatch("m1", { date: "2026-04-12" });
    vi.mocked(listMatches).mockResolvedValue([match]);
    renderList();

    const button = await screen.findByRole("button", {
      name: "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    });
    fireEvent.click(button);
    const input = screen.getByLabelText<HTMLInputElement>(
      "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    );

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.change(input, { target: { value: "0002-04-12" } });
    expect(updateMatch).not.toHaveBeenCalled();

    fireEvent.blur(input);
    const restored = await screen.findByRole("button", {
      name: "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    });
    expect(restored.textContent).toBe("2026-04-12");
  });

  it("shows a save error, reverts the displayed date, and clears the error on retry", async () => {
    const match = makeMatch("m1", { date: null });
    const updated = { ...match, date: "2026-04-18" };
    vi.mocked(listMatches).mockResolvedValueOnce([match]).mockResolvedValueOnce([updated]);
    vi.mocked(updateMatch)
      .mockRejectedValueOnce(new ApiError(503, "Rally Log unavailable"))
      .mockResolvedValueOnce(makeMatchDetail(updated));

    renderList();

    const button = await screen.findByRole("button", {
      name: "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    });
    fireEvent.click(button);
    const input = screen.getByLabelText<HTMLInputElement>(
      "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    );
    fireEvent.change(input, { target: { value: "2026-04-18" } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Rally Log unavailable");
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.blur(input);
    const reverted = await screen.findByRole("button", {
      name: "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    });
    expect(reverted.textContent).toBe("—");

    fireEvent.click(reverted);
    const retryInput = screen.getByLabelText<HTMLInputElement>(
      "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    );
    fireEvent.change(retryInput, { target: { value: "2026-04-18" } });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.blur(retryInput);
    const saved = await screen.findByRole("button", {
      name: "Date for Anna Bright / Ben Johns vs Cara Lee / Dan Kim",
    });
    expect(saved.textContent).toBe("2026-04-18");
  });
});

it("displays derived Match Discipline or em dash for legacy unclassified Matches", async () => {
  vi.mocked(listMatches).mockResolvedValue([
    makeMatch("m1", { discipline: "mens_doubles" }),
    makeMatch("m2", { discipline: "womens_doubles" }),
    makeMatch("m3", { discipline: "mixed_doubles" }),
    makeMatch("m4", { discipline: null }),
  ]);
  renderList();

  expect(await screen.findByText("Men's Doubles")).toBeTruthy();
  expect(screen.getByText("Women's Doubles")).toBeTruthy();
  expect(screen.getByText("Mixed Doubles")).toBeTruthy();
  const disciplines = Array.from(document.querySelectorAll(".discipline")).map(
    (el) => el.textContent,
  );
  expect(disciplines).toEqual(["Men's Doubles", "Women's Doubles", "Mixed Doubles", "—"]);
});
