// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApiError,
  getPlayerReport,
  getTeamReport,
  listPlayers,
  listTeams,
  mergePlayer,
  updatePlayer,
} from "../api/client";
import type { components } from "../api/schema";
import { router as appRouter } from "../router";

type Client = typeof import("../api/client");
type PlayerReport = components["schemas"]["PlayerReport"];
type TeamReport = components["schemas"]["TeamReport"];
type ReportStat = components["schemas"]["ReportStat"];

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getPlayerReport: vi.fn<Client["getPlayerReport"]>(),
  getTeamReport: vi.fn<Client["getTeamReport"]>(),
  listPlayers: vi.fn<Client["listPlayers"]>(),
  listTeams: vi.fn<Client["listTeams"]>(),
  updatePlayer: vi.fn<Client["updatePlayer"]>(),
  mergePlayer: vi.fn<Client["mergePlayer"]>(),
  listMatches: vi.fn<Client["listMatches"]>().mockResolvedValue([]),
  getRallyLog: vi.fn<Client["getRallyLog"]>().mockResolvedValue({
    path: "/tmp/demo.duckdb",
    recent: [],
  }),
}));

const ALEX = { id: "alex", name: "Alex One" };
const AVERY = { id: "10000000-0000-4000-8000-000000000001", name: "Avery Two" };
const BLAKE = { id: "10000000-0000-4000-8000-000000000002", name: "Blake One" };
const TEAM: components["schemas"]["ReportTeam"] = {
  id: "team",
  discipline: "mixed_doubles",
  players: [ALEX, AVERY],
};
const OPPONENTS = {
  id: "opponents",
  discipline: "mixed_doubles",
  players: [BLAKE, { id: "brook", name: "Brook Two" }],
} satisfies components["schemas"]["ReportTeam"];
const MLP_OPEN = "10000000-0000-4000-8000-000000000003";
const DOUBLES_OPEN = "10000000-0000-4000-8000-000000000004";

const RALLIES = { counted: 6, done: 4, in_progress: 1, empty: 1 };
const NO_RALLIES = { counted: 0, done: 0, in_progress: 0, empty: 0 };
const KITCHEN_FAULTS: ReportStat = {
  id: "kitchen_faults_per_match",
  label: "Kitchen Faults",
  group: "Other",
  applies_to: "both",
  kind: "per_match",
  splits_by: ["shot_number"],
  sub_rows: null,
  rows: [],
  values: { alex: { count: 3, matches: 2, average: 1.5, left_out: 0 } },
  breakdowns: {
    shot_number: { "3": { alex: { count: 1, matches: 2, average: 0.5, left_out: 0 } } },
  },
};
const PLAYER_REPORT: PlayerReport = {
  profile: { ...ALEX, handedness: "left", gender: "male" },
  header: { match_count: 2, rallies: RALLIES, uncredited: 2 },
  filter_options: {
    tournaments: [
      { id: DOUBLES_OPEN, name: "Synthetic Doubles Open", tour: "ppa" },
      { id: MLP_OPEN, name: "Synthetic MLP Open", tour: "mlp" },
    ],
    partners: [AVERY],
    opponents: OPPONENTS.players,
  },
  undated_matches_excluded: 0,
  unclassified_matches_excluded: 0,
  stats: [KITCHEN_FAULTS],
  partners: [{ team: TEAM, player: AVERY, match_count: 2 }],
  played_for: [
    {
      id: "franchise",
      name: "Synthetic Volleys",
      tournaments: [{ id: "mlp", name: "Synthetic MLP Open", match_count: 1 }],
    },
  ],
  matches: [
    {
      id: "mlp-match",
      date: "2026-06-04",
      tournament: "Synthetic MLP Open",
      discipline: "mixed_doubles",
      partner: AVERY,
      opponents: OPPONENTS,
      games: [{ number: 1, score: [11, 8] }],
      rallies: RALLIES,
    },
    {
      id: "legacy-match",
      date: null,
      tournament: "Synthetic Doubles Open",
      discipline: null,
      partner: AVERY,
      opponents: OPPONENTS,
      games: [],
      rallies: NO_RALLIES,
    },
  ],
};
const TEAM_REPORT: TeamReport = {
  profile: TEAM,
  header: PLAYER_REPORT.header,
  filter_options: { ...PLAYER_REPORT.filter_options, partners: [] },
  undated_matches_excluded: 0,
  unclassified_matches_excluded: 0,
  stats: [KITCHEN_FAULTS],
  matches: PLAYER_REPORT.matches.map((match) => ({ ...match, partner: null })),
};

function renderDashboard(path: string) {
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
  vi.mocked(getPlayerReport).mockResolvedValue(PLAYER_REPORT);
  vi.mocked(getTeamReport).mockResolvedValue(TEAM_REPORT);
  vi.mocked(listPlayers).mockResolvedValue([{ ...PLAYER_REPORT.profile, match_count: 2 }]);
  vi.mocked(listTeams).mockResolvedValue([{ ...TEAM_REPORT.profile, match_count: 2 }]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("opens both indexes from the Dashboard and links to their reports", async () => {
  renderDashboard("/");
  await screen.findByRole("heading", { name: "Matches" });
  const dashboard = within(screen.getByRole("navigation", { name: "Dashboard" }));
  expect(dashboard.getByRole("link", { name: "Matches" }).getAttribute("aria-current")).toBe(
    "page",
  );
  fireEvent.click(dashboard.getByRole("link", { name: "Players" }));
  const players = within(await screen.findByRole("table", { name: "Players" }));
  const player = players.getByRole("row", { name: /^Alex One Left Male 2\b/ });
  const playerLink = within(player).getByRole("link");
  expect(playerLink.getAttribute("href")).toBe("/players/alex");
  fireEvent.click(playerLink);
  await screen.findByRole("heading", { name: "Alex One" });

  fireEvent.click(dashboard.getByRole("link", { name: "Teams" }));
  const teams = within(await screen.findByRole("table", { name: "Teams" }));
  const team = teams.getByRole("row", { name: "Alex One / Avery Two Mixed Doubles 2" });
  const teamLink = within(team).getByRole("link");
  expect(teamLink.getAttribute("href")).toBe("/teams/team");
  fireEvent.click(teamLink);
  await screen.findByRole("heading", { name: "Alex One / Avery Two" });
  expect(screen.getByText("Mixed Doubles")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Discipline" })).toBeNull();
});

it("shows the Player profile, Played for, Partners, Match history and per-Match values", async () => {
  const history = renderDashboard("/players/alex");
  await screen.findByRole("heading", { name: "Alex One" });
  expect(screen.getByText("Left-handed")).toBeTruthy();
  expect(screen.getByText("Male")).toBeTruthy();
  expect(
    within(screen.getByRole("main")).getByRole("link", { name: "Compare" }).getAttribute("href"),
  ).toBe("/compare?kind=player&a=alex");
  expect(
    screen.getByText("2 Matches · 6 Rallies counted · 4 Done, 1 In progress, 1 Empty"),
  ).toBeTruthy();
  expect(
    screen.getByText("2 observations across these Matches couldn't be credited to a Team"),
  ).toBeTruthy();

  const partners = within(screen.getByRole("region", { name: "Partners" }));
  expect(partners.getByRole("link", { name: "Avery Two" }).getAttribute("href")).toBe(
    "/teams/team",
  );
  expect(partners.getByText("(2 Matches)")).toBeTruthy();
  const franchises = within(screen.getByRole("region", { name: "Played for" }));
  expect(franchises.getByText("Synthetic Volleys")).toBeTruthy();
  expect(franchises.getByText("Synthetic MLP Open (1 Match)")).toBeTruthy();

  const table = within(screen.getByRole("table", { name: "Matches" }));
  const dated = table.getByRole("row", { name: /2026-06-04/ });
  const legacy = table.getByRole("row", { name: /Synthetic Doubles Open/ });
  expect(table.getAllByRole("row").slice(1)).toEqual([dated, legacy]);
  const latestMatch = within(dated);
  expect(latestMatch.getByText("2026-06-04")).toBeTruthy();
  expect(latestMatch.getByText("Synthetic MLP Open")).toBeTruthy();
  expect(latestMatch.getByText("Avery Two")).toBeTruthy();
  expect(latestMatch.getByText("Blake One / Brook Two")).toBeTruthy();
  expect(latestMatch.getByText("11–8")).toBeTruthy();
  expect(latestMatch.getByText("4 Done / 1 In progress / 1 Empty")).toBeTruthy();
  expect(latestMatch.getByRole("link").getAttribute("href")).toBe("/matches/mlp-match/report");
  expect(within(legacy).getByText("No Rallies yet")).toBeTruthy();

  const stats = within(screen.getByRole("table", { name: "Other" }));
  expect(stats.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "Stat",
    "Alex One",
  ]);
  expect(stats.getByText("1.5 per Match (3 in 2)")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Break down by" }), {
    target: { value: "shot_number" },
  });
  await waitFor(() => expect(history.location.search).toBe("?by=shot_number"));
  expect(stats.getByText("0.5 per Match (1 in 2)")).toBeTruthy();
  expect(getPlayerReport).toHaveBeenCalledTimes(1);
});

it("shows the Team and two Player columns, with only opponents in the history", async () => {
  renderDashboard("/teams/team?by=shot_number");
  await screen.findByRole("heading", { name: "Alex One / Avery Two" });
  expect(
    within(screen.getByRole("main")).getByRole("link", { name: "Compare" }).getAttribute("href"),
  ).toBe("/compare?kind=team&a=team");
  const stats = within(screen.getByRole("table", { name: "Other" }));
  const headings = within(stats.getByRole("row", { name: /^Stat / }));
  expect(headings.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "Stat",
    "Team",
    "Alex One",
    "Avery Two",
  ]);
  expect(stats.getByRole("link", { name: "Alex One" }).getAttribute("href")).toBe("/players/alex");
  expect(screen.queryByRole("columnheader", { name: "Partner" })).toBeNull();
  expect(within(screen.getByRole("table", { name: "Matches" })).getAllByRole("link")).toHaveLength(
    2,
  );
  expect(screen.queryByRole("heading", { name: "Played for" })).toBeNull();
});

it("applies and restores combined Player filters alongside the stats breakdown", async () => {
  const filtered: PlayerReport = {
    ...PLAYER_REPORT,
    header: { match_count: 1, rallies: RALLIES, uncredited: 0 },
    matches: PLAYER_REPORT.matches.slice(0, 1),
    stats: [
      {
        ...KITCHEN_FAULTS,
        values: { alex: { count: 1, matches: 1, average: 1, left_out: 0 } },
        breakdowns: {
          shot_number: { "3": { alex: { count: 1, matches: 1, average: 1, left_out: 0 } } },
        },
      },
    ],
  };
  vi.mocked(getPlayerReport).mockImplementation(async (_, filters) =>
    filters.tour === "mlp" ? filtered : PLAYER_REPORT,
  );
  const history = renderDashboard("/players/alex?by=shot_number");
  const form = within(await screen.findByRole("group", { name: "Filter Matches" }));
  fireEvent.click(form.getByRole("checkbox", { name: "Synthetic Doubles Open (PPA)" }));
  fireEvent.click(form.getByRole("checkbox", { name: "Synthetic MLP Open (MLP)" }));
  fireEvent.change(form.getByRole("combobox", { name: "Tour" }), { target: { value: "mlp" } });
  fireEvent.change(form.getByRole("combobox", { name: "Discipline" }), {
    target: { value: "mixed_doubles" },
  });
  fireEvent.change(form.getByLabelText("Date from"), { target: { value: "2026-06-01" } });
  fireEvent.change(form.getByLabelText("Date to"), { target: { value: "2026-06-04" } });
  fireEvent.change(form.getByRole("combobox", { name: "Partner" }), {
    target: { value: AVERY.id },
  });
  fireEvent.change(form.getByRole("combobox", { name: "Opponent" }), {
    target: { value: BLAKE.id },
  });
  fireEvent.click(form.getByRole("button", { name: "Apply filters" }));

  await screen.findByText("1 Match · 6 Rallies counted · 4 Done, 1 In progress, 1 Empty");
  const matches = within(screen.getByRole("table", { name: "Matches" }));
  expect(matches.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
    "/matches/mlp-match/report",
  ]);
  expect(
    within(screen.getByRole("table", { name: "Other" })).getByText("1 per Match (1 in 1)"),
  ).toBeTruthy();
  const filters = {
    tournament: [MLP_OPEN, DOUBLES_OPEN],
    tour: "mlp",
    discipline: "mixed_doubles",
    date_from: "2026-06-01",
    date_to: "2026-06-04",
    partner: AVERY.id,
    opponent: BLAKE.id,
  };
  expect(getPlayerReport).toHaveBeenLastCalledWith(ALEX.id, filters, expect.any(AbortSignal));
  const search = new URLSearchParams(history.location.search);
  expect(Object.fromEntries(search)).toEqual({
    ...filters,
    by: "shot_number",
    tournament: JSON.stringify(filters.tournament),
  });

  fireEvent.change(screen.getByRole("combobox", { name: "Break down by" }), {
    target: { value: "" },
  });
  await waitFor(() => expect(new URLSearchParams(history.location.search).has("by")).toBe(false));
  expect(getPlayerReport).toHaveBeenCalledTimes(2);

  const shareableUrl = history.location.href;
  cleanup();
  renderDashboard(shareableUrl);
  const restored = within(await screen.findByRole("group", { name: "Filter Matches" }));
  expect(restored.getAllByRole("checkbox", { checked: true })).toHaveLength(2);
  expect((restored.getByRole("combobox", { name: "Tour" }) as HTMLSelectElement).value).toBe("mlp");
  expect((restored.getByRole("combobox", { name: "Discipline" }) as HTMLSelectElement).value).toBe(
    "mixed_doubles",
  );
  expect((restored.getByLabelText("Date to") as HTMLInputElement).value).toBe("2026-06-04");
  expect(getPlayerReport).toHaveBeenLastCalledWith(ALEX.id, filters, expect.any(AbortSignal));
});

it("shows why a filtered Team report is empty and can clear the filters", async () => {
  vi.mocked(getTeamReport).mockImplementation(async (_, filters) =>
    filters.date_to
      ? {
          ...TEAM_REPORT,
          header: { match_count: 0, rallies: NO_RALLIES, uncredited: 0 },
          matches: [],
          stats: [],
          undated_matches_excluded: 1,
        }
      : TEAM_REPORT,
  );
  const unavailableTournament = "10000000-0000-4000-8000-000000000005";
  const history = renderDashboard(
    `/teams/team?by=shot_number&date_to=2026-06-01&opponent=${BLAKE.id}&tour=app&tournament=${unavailableTournament}`,
  );
  await screen.findByText("No Matches match these filters");
  expect(screen.getByText("1 Match left out because of missing dates.")).toBeTruthy();
  expect(
    screen.getByText("0 Matches · 0 Rallies counted · 0 Done, 0 In progress, 0 Empty"),
  ).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Partner" })).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.getByRole("option", { name: "APP (unavailable)", selected: true })).toBeTruthy();
  expect(
    screen.getByRole("checkbox", { name: "Unavailable Tournament", checked: true }),
  ).toBeTruthy();
  expect(screen.queryByText(unavailableTournament, { exact: false })).toBeNull();
  expect(getTeamReport).toHaveBeenLastCalledWith(
    TEAM.id,
    expect.objectContaining({
      date_to: "2026-06-01",
      opponent: BLAKE.id,
      tour: "app",
      tournament: [unavailableTournament],
    }),
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("table", { name: "Matches" });
  expect(history.location.search).toBe("?by=shot_number");
  expect((screen.getByLabelText("Date to") as HTMLInputElement).value).toBe("");
  const tour = within(screen.getByRole("combobox", { name: "Tour" }));
  expect(tour.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "All Tours",
    "PPA",
    "MLP",
  ]);
  expect(screen.queryByText(/left out because of missing dates/)).toBeNull();
});

it("lets the Player clear filters from a report request error", async () => {
  vi.mocked(getPlayerReport).mockImplementation(async (_, filters) => {
    if (filters.tour) throw new ApiError(422, "The report request failed");
    return PLAYER_REPORT;
  });
  const history = renderDashboard("/players/alex?by=shot_number");
  const form = within(await screen.findByRole("group", { name: "Filter Matches" }));
  fireEvent.change(form.getByRole("combobox", { name: "Tour" }), { target: { value: "ppa" } });
  fireEvent.click(form.getByRole("button", { name: "Apply filters" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The report request failed");
  fireEvent.click(within(alert).getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("table", { name: "Matches" });
  expect(history.location.search).toBe("?by=shot_number");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the applied report visible until the draft date range is valid", async () => {
  const history = renderDashboard("/players/alex");
  const form = within(await screen.findByRole("group", { name: "Filter Matches" }));
  fireEvent.change(form.getByLabelText("Date from"), { target: { value: "2026-06-04" } });
  fireEvent.change(form.getByLabelText("Date to"), { target: { value: "2026-06-01" } });
  fireEvent.click(form.getByRole("button", { name: "Apply filters" }));
  expect(form.getByRole("alert").textContent).toBe("Date from must be on or before Date to.");
  expect(history.location.search).toBe("");
  expect(getPlayerReport).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("table", { name: "Matches" })).toBeTruthy();

  fireEvent.change(form.getByLabelText("Date to"), { target: { value: "2026-06-04" } });
  fireEvent.click(form.getByRole("button", { name: "Apply filters" }));
  await waitFor(() =>
    expect(getPlayerReport).toHaveBeenLastCalledWith(
      ALEX.id,
      expect.objectContaining({ date_from: "2026-06-04", date_to: "2026-06-04" }),
      expect.any(AbortSignal),
    ),
  );
  expect(form.queryByRole("alert")).toBeNull();
});

it("explains an inverted date range from a shared Team URL and lets it be cleared", async () => {
  const history = renderDashboard(
    "/teams/team?by=shot_number&date_from=2026-06-04&date_to=2026-06-01",
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Date from must be on or before Date to.");
  expect(getTeamReport).toHaveBeenCalledTimes(0);
  fireEvent.click(within(alert).getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("table", { name: "Matches" });
  expect(history.location.search).toBe("?by=shot_number");
  expect(getTeamReport).toHaveBeenCalledTimes(1);
});

it("keeps the Player's Match visible when it has no Rallies", async () => {
  vi.mocked(getPlayerReport).mockResolvedValue({
    ...PLAYER_REPORT,
    header: { match_count: 1, rallies: NO_RALLIES, uncredited: 0 },
    matches: PLAYER_REPORT.matches.slice(1),
    played_for: [],
    stats: [],
  });
  renderDashboard("/players/alex");
  expect(
    await screen.findByText("No Rallies yet. Add Rallies in Annotate to see stats."),
  ).toBeTruthy();
  expect(screen.getByText("No Rallies yet")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Played for" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Break down by" })).toBeNull();
});

it("distinguishes an Empty Rally from a Match with no Rallies", async () => {
  vi.mocked(getPlayerReport).mockResolvedValue({
    ...PLAYER_REPORT,
    matches: PLAYER_REPORT.matches.map((match) =>
      match.id === "mlp-match"
        ? { ...match, rallies: { counted: 1, done: 0, in_progress: 0, empty: 1 } }
        : match,
    ),
  });
  renderDashboard("/players/alex");
  const matches = within(await screen.findByRole("table", { name: "Matches" }));
  expect(matches.getByText("0 Done / 0 In progress / 1 Empty")).toBeTruthy();
  expect(matches.getByText("No Rallies yet")).toBeTruthy();
});

it.each([
  { index: "/players", list: "Players", load: getPlayerReport },
  { index: "/teams", list: "Teams", load: getTeamReport },
])("links a missing subject back to $list", async ({ index, list, load }) => {
  vi.mocked(load).mockRejectedValueOnce(new ApiError(404, "Subject not found"));
  renderDashboard(`${index}/missing`);
  const back = await screen.findByRole("link", { name: `Back to ${list}` });
  expect(back.getAttribute("href")).toBe(index);
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(back);
  expect(await screen.findByRole("table", { name: list })).toBeTruthy();
});

it("keeps the Matches tab highlighted on New Match", async () => {
  renderDashboard("/matches/new");
  const dashboard = within(await screen.findByRole("navigation", { name: "Dashboard" }));
  expect(dashboard.getByRole("link", { name: "Matches" }).getAttribute("aria-current")).toBe(
    "page",
  );
});

it("shows unclassified Match exclusions on Player report and em dash for legacy Players", async () => {
  vi.mocked(getPlayerReport).mockResolvedValueOnce({
    ...PLAYER_REPORT,
    profile: { ...PLAYER_REPORT.profile, gender: null },
    unclassified_matches_excluded: 1,
  });
  renderDashboard("/players/alex?discipline=mens_doubles");
  await screen.findByRole("heading", { name: "Alex One" });
  expect(screen.getByText("1 Match left out because of unknown Discipline.")).toBeTruthy();
  expect(screen.getByText("Left-handed").parentElement?.textContent).toBe("Left-handed · —");
});

it("edits and merges Players from /players using global affected-Match wording and refetches", async () => {
  vi.mocked(listPlayers)
    .mockResolvedValueOnce([
      { id: "alex", name: "Alex One", handedness: "left", gender: "male", match_count: 2 },
      { id: "avery", name: "Avery Two", handedness: "right", gender: "female", match_count: 1 },
    ])
    .mockResolvedValueOnce([
      { id: "alex", name: "Alex Renamed", handedness: "right", gender: "male", match_count: 2 },
      { id: "avery", name: "Avery Two", handedness: "right", gender: "female", match_count: 1 },
    ])
    .mockResolvedValueOnce([
      { id: "avery", name: "Avery Two", handedness: "right", gender: "female", match_count: 3 },
    ]);

  vi.mocked(updatePlayer)
    .mockResolvedValueOnce({
      player: { id: "alex", name: "Alex Renamed", handedness: "right", gender: "male" },
      affected_matches: 2,
      dry_run: true,
    })
    .mockResolvedValueOnce({
      player: { id: "alex", name: "Alex Renamed", handedness: "right", gender: "male" },
      affected_matches: 2,
      dry_run: false,
    });

  renderDashboard("/players");
  const table = within(await screen.findByRole("table", { name: "Players" }));
  fireEvent.click(table.getByRole("button", { name: "Edit Player Alex One" }));

  let dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Alex Renamed" } });
  fireEvent.change(dialog.getByLabelText("Handedness"), { target: { value: "right" } });
  fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
  expect(await dialog.findByText("Affects 2 Matches.")).toBeTruthy();

  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await screen.findByRole("link", { name: "Alex Renamed" })).toBeTruthy();
  expect(listPlayers).toHaveBeenCalledTimes(2);

  // Merge Alex Renamed into Avery Two.
  vi.mocked(updatePlayer).mockRejectedValueOnce(
    new ApiError(409, "Player 'Avery Two' already exists", { id: "avery", name: "Avery Two" }),
  );
  vi.mocked(mergePlayer)
    .mockResolvedValueOnce({
      player: { id: "avery", name: "Avery Two", handedness: "right", gender: "female" },
      affected_matches: 2,
      dry_run: true,
    })
    .mockResolvedValueOnce({
      player: { id: "avery", name: "Avery Two", handedness: "right", gender: "female" },
      affected_matches: 2,
      dry_run: false,
    });

  fireEvent.click(screen.getByRole("button", { name: "Edit Player Alex Renamed" }));
  dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Avery Two" } });
  fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
  fireEvent.click(await dialog.findByRole("button", { name: 'Merge into "Avery Two"' }));
  expect(await dialog.findByText("Affects 2 Matches.")).toBeTruthy();

  fireEvent.click(dialog.getByRole("button", { name: 'Confirm Merge into "Avery Two"' }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(screen.queryByRole("link", { name: "Alex Renamed" })).toBeNull());
  expect(listPlayers).toHaveBeenCalledTimes(3);
});
