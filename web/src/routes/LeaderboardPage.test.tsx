// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, getLeaderboard } from "../api/client";
import type { components } from "../api/schema";
import { router as appRouter } from "../router";

type Client = typeof import("../api/client");
type Stat = components["schemas"]["LeaderboardStat"];

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getLeaderboard: vi.fn<Client["getLeaderboard"]>(),
  listMatches: vi.fn<Client["listMatches"]>().mockResolvedValue([]),
  getRallyLog: vi.fn<Client["getRallyLog"]>().mockResolvedValue({
    path: "/tmp/demo.duckdb",
    recent: [],
  }),
}));

const SERVE_IN: Stat = {
  id: "serve_in",
  label: "Serves in",
  group: "Serve & Return",
  kind: "rate",
  applies_to: "both",
  splits_by: ["shot_number", "court_half"],
};
const STATS: Stat[] = [
  SERVE_IN,
  { ...SERVE_IN, id: "return_in", label: "Returns in" },
  { ...SERVE_IN, id: "opening_win", label: "Opening win rate", applies_to: "team", splits_by: [] },
  { ...SERVE_IN, id: "hit_share", label: "Hit Share", applies_to: "player" },
  { ...SERVE_IN, id: "challenge_success", label: "Challenge success", splits_by: [] },
];
const ALEX = { id: "alex", name: "Alex One" };
const TEAM: components["schemas"]["ReportTeam"] = {
  id: "team",
  discipline: "mixed_doubles",
  players: [ALEX, { id: "avery", name: "Avery Two" }],
};
const TOURNAMENT = "10000000-0000-4000-8000-000000000003";
const DATE = "2026-06-04";

function renderLeaderboard(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: appRouter.routeTree, history });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return history;
}

beforeEach(() => {
  vi.mocked(getLeaderboard).mockImplementation(async ({ kind, stat, minimum = 30, by, bucket }) => {
    const buckets = { shot_number: ["1", "2", "3"], court_half: ["Left", "Right"] };
    const ranked =
      kind === "team" ? { kind, subject: TEAM } : { kind: "player" as const, subject: ALEX };
    return {
      stat: STATS.find((option) => option.id === stat)?.id ?? SERVE_IN.id,
      stats: STATS,
      bucket:
        bucket ?? (by === "shot_number" || by === "court_half" ? (buckets[by][0] ?? null) : null),
      buckets,
      filter_options: {
        tournaments: [{ id: TOURNAMENT, name: "Synthetic MLP Open", tour: "mlp" }],
      },
      match_count: 1,
      undated_matches_excluded: 0,
      unclassified_matches_excluded: 0,
      hidden_count: minimum === 30 ? 4 : 1,
      rows:
        minimum === 30
          ? []
          : [
              {
                rank: 1,
                ...ranked,
                value: { count: 34, of: 51, estimate: 34 / 51, low: 0.55, high: 0.77, left_out: 0 },
              },
            ],
    };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("opens from the dashboard and sets the minimum before showing ranked links and intervals", async () => {
  const history = renderLeaderboard("/");
  fireEvent.click(await screen.findByRole("link", { name: "Leaderboard" }));
  expect(await screen.findByText("4 Players hidden below 30 attempts")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
  expect((screen.getByRole("radio", { name: "Players" }) as HTMLInputElement).checked).toBe(true);
  const minimum = screen.getByRole("spinbutton", { name: "Minimum attempts" }) as HTMLInputElement;
  expect(minimum.value).toBe("30");
  fireEvent.change(minimum, { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Set minimum" }));

  const table = within(await screen.findByRole("table", { name: "Leaderboard results" }));
  expect(history.location.pathname).toBe("/leaderboard");
  expect(new URLSearchParams(history.location.search).get("minimum")).toBe("3");
  expect(screen.getByText("1 Player hidden below 3 attempts")).toBeTruthy();
  expect(table.getByRole("link", { name: "Alex One" }).getAttribute("href")).toBe("/players/alex");
  expect(table.getByText("34 of 51 · 67% (55–77%)")).toBeTruthy();
  expect(screen.getByText("Rate bars show 90% Wilson intervals")).toBeTruthy();
});

it("greys out unsupported stats, clears incompatible breakdowns, and links to Team pages", async () => {
  renderLeaderboard("/leaderboard?minimum=1&stat=challenge_success");
  const stats = within(await screen.findByRole("combobox", { name: "Stat" }));
  expect(stats.getByRole("option", { name: "Challenge success", selected: true })).toBeTruthy();
  expect(stats.queryByRole("option", { name: "Opening win rate" })).toBeNull();
  const breakdown = screen.getByRole("combobox", { name: "Break down by" }) as HTMLSelectElement;
  fireEvent.change(breakdown, { target: { value: "shot_number" } });
  await waitFor(() => {
    expect(
      (stats.getByRole("option", { name: "Challenge success" }) as HTMLOptionElement).disabled,
    ).toBe(true);
    expect(stats.getByRole("option", { name: "Serves in", selected: true })).toBeTruthy();
  });
  expect(screen.getByRole("combobox", { name: "Bucket" })).toBeTruthy();

  fireEvent.change(breakdown, { target: { value: "court_half" } });
  await screen.findByRole("option", { name: "Left", selected: true });
  fireEvent.click(screen.getByRole("radio", { name: "Teams" }));
  const team = await screen.findByRole("link", { name: "Alex One / Avery Two" });
  expect(team.getAttribute("href")).toBe("/teams/team");
  expect(stats.queryByRole("option", { name: "Hit Share" })).toBeNull();
  expect(stats.getByRole("option", { name: "Opening win rate" })).toBeTruthy();
  expect(breakdown.value).toBe("");
  expect(
    (within(breakdown).getByRole("option", { name: "Court Half" }) as HTMLOptionElement).disabled,
  ).toBe(true);
  expect(screen.queryByRole("combobox", { name: "Bucket" })).toBeNull();
});

it("round-trips the selected stat, kind, minimum, bucket and Match filters through the URL", async () => {
  const history = renderLeaderboard(
    "/leaderboard?kind=team&stat=return_in&minimum=3&by=shot_number&bucket=3",
  );
  const filters = within(await screen.findByRole("group", { name: "Filter Matches" }));
  expect(filters.queryByRole("combobox", { name: "Partner" })).toBeNull();
  expect(filters.queryByRole("combobox", { name: "Opponent" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Bucket" }), { target: { value: "2" } });
  fireEvent.click(filters.getByRole("checkbox", { name: "Synthetic MLP Open (MLP)" }));
  fireEvent.change(filters.getByRole("combobox", { name: "Tour" }), { target: { value: "mlp" } });
  fireEvent.change(filters.getByRole("combobox", { name: "Discipline" }), {
    target: { value: "mixed_doubles" },
  });
  fireEvent.change(filters.getByLabelText("Date from"), { target: { value: DATE } });
  fireEvent.change(filters.getByLabelText("Date to"), { target: { value: DATE } });
  fireEvent.click(filters.getByRole("button", { name: "Apply filters" }));

  const expected = {
    kind: "team",
    stat: "return_in",
    minimum: 3,
    by: "shot_number",
    bucket: "2",
    tour: "mlp",
    discipline: "mixed_doubles",
    tournament: [TOURNAMENT],
    date_from: DATE,
    date_to: DATE,
  };
  await waitFor(() =>
    expect(getLeaderboard).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal)),
  );
  const url = history.location.href;
  cleanup();
  renderLeaderboard(url);
  const restored = within(await screen.findByRole("group", { name: "Filter Matches" }));
  expect(getLeaderboard).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal));
  expect((screen.getByRole("radio", { name: "Teams" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("option", { name: "Returns in", selected: true })).toBeTruthy();
  expect(
    (screen.getByRole("spinbutton", { name: "Minimum attempts" }) as HTMLInputElement).value,
  ).toBe("3");
  expect((screen.getByRole("combobox", { name: "Break down by" }) as HTMLSelectElement).value).toBe(
    "shot_number",
  );
  expect((screen.getByRole("combobox", { name: "Bucket" }) as HTMLSelectElement).value).toBe("2");
  expect(
    restored.getByRole("checkbox", { name: "Synthetic MLP Open (MLP)", checked: true }),
  ).toBeTruthy();
  expect((restored.getByRole("combobox", { name: "Tour" }) as HTMLSelectElement).value).toBe("mlp");
  expect((restored.getByRole("combobox", { name: "Discipline" }) as HTMLSelectElement).value).toBe(
    "mixed_doubles",
  );
  expect((restored.getByLabelText("Date from") as HTMLInputElement).value).toBe(DATE);
  expect((restored.getByLabelText("Date to") as HTMLInputElement).value).toBe(DATE);
});

it("clears invalid dates from a shared URL while keeping the ranking settings", async () => {
  const history = renderLeaderboard(
    "/leaderboard?kind=team&minimum=1&date_from=2026-06-04&date_to=2026-06-03",
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Date from must be on or before Date to.");
  expect(getLeaderboard).not.toHaveBeenCalled();
  fireEvent.click(within(alert).getByRole("button", { name: "Clear filters" }));

  await screen.findByRole("table", { name: "Leaderboard results" });
  expect(Object.fromEntries(new URLSearchParams(history.location.search))).toEqual({
    kind: "team",
    minimum: "1",
  });
});

it("resets the URL when a shared link requests a stat that is unavailable", async () => {
  vi.mocked(getLeaderboard).mockRejectedValueOnce(new ApiError(422, "Unavailable stat"));
  const history = renderLeaderboard("/leaderboard?kind=team&minimum=1&stat=old_stat");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("These Leaderboard settings are unavailable.");
  fireEvent.click(within(alert).getByRole("button", { name: "Reset Leaderboard" }));

  await screen.findByText("4 Players hidden below 30 attempts");
  expect(history.location.search).toBe("");
});

it("retries a failed Leaderboard load without changing the ranking settings", async () => {
  vi.mocked(getLeaderboard).mockRejectedValueOnce(new ApiError(404, "Leaderboard unavailable"));
  const history = renderLeaderboard("/leaderboard?kind=team&minimum=1");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Leaderboard unavailable");
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));

  await screen.findByRole("link", { name: "Alex One / Avery Two" });
  expect(getLeaderboard).toHaveBeenCalledTimes(2);
  expect(Object.fromEntries(new URLSearchParams(history.location.search))).toEqual({
    kind: "team",
    minimum: "1",
  });
});

it("displays the excluded unclassified Match count when Discipline filter is active", async () => {
  vi.mocked(getLeaderboard).mockResolvedValueOnce({
    stat: SERVE_IN.id,
    stats: STATS,
    bucket: null,
    buckets: { shot_number: ["1"], court_half: ["Left"] },
    filter_options: { tournaments: [] },
    match_count: 2,
    undated_matches_excluded: 0,
    unclassified_matches_excluded: 3,
    hidden_count: 0,
    rows: [
      {
        rank: 1,
        kind: "player",
        subject: ALEX,
        value: { count: 10, of: 12, estimate: 10 / 12, low: 0.6, high: 0.95, left_out: 0 },
      },
    ],
  });
  renderLeaderboard("/leaderboard?minimum=1&discipline=mens_doubles");
  expect(await screen.findByText("3 Matches left out because of unknown Discipline")).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Discipline" }) as HTMLSelectElement).value).toBe(
    "mens_doubles",
  );
});
