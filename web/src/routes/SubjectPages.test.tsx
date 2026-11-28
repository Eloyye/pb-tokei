// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPlayerReport, getTeamReport, listPlayers, listTeams } from "../api/client";
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
  listMatches: vi.fn<Client["listMatches"]>().mockResolvedValue([]),
  getRallyLog: vi.fn<Client["getRallyLog"]>().mockResolvedValue({
    path: "/tmp/demo.duckdb",
    recent: [],
  }),
}));

const ALEX = { id: "alex", name: "Alex One" };
const AVERY = { id: "avery", name: "Avery Two" };
const TEAM: components["schemas"]["ReportTeam"] = { id: "team", players: [ALEX, AVERY] };
const OPPONENTS = {
  id: "opponents",
  players: [
    { id: "blake", name: "Blake One" },
    { id: "brook", name: "Brook Two" },
  ],
} satisfies components["schemas"]["ReportTeam"];

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
  profile: { ...ALEX, handedness: "left" },
  header: { match_count: 2, rallies: RALLIES, uncredited: 2 },
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
      partner: AVERY,
      opponents: OPPONENTS,
      games: [{ number: 1, score: [11, 8] }],
      rallies: RALLIES,
    },
    {
      id: "legacy-match",
      date: null,
      tournament: "Synthetic Doubles Open",
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
  const player = players.getByRole("row", { name: "Alex One Left 2" });
  const playerLink = within(player).getByRole("link");
  expect(playerLink.getAttribute("href")).toBe("/players/alex");
  fireEvent.click(playerLink);
  await screen.findByRole("heading", { name: "Alex One" });

  fireEvent.click(dashboard.getByRole("link", { name: "Teams" }));
  const teams = within(await screen.findByRole("table", { name: "Teams" }));
  const team = teams.getByRole("row", { name: "Alex One / Avery Two 2" });
  const teamLink = within(team).getByRole("link");
  expect(teamLink.getAttribute("href")).toBe("/teams/team");
  fireEvent.click(teamLink);
  await screen.findByRole("heading", { name: "Alex One / Avery Two" });
});

it("shows the Player profile, Played for, Partners, Match history and per-Match values", async () => {
  const history = renderDashboard("/players/alex");
  await screen.findByRole("heading", { name: "Alex One" });
  expect(screen.getByText("Left-handed")).toBeTruthy();
  expect(
    screen.getByText("2 Matches · 6 Rallies counted · 4 Done, 1 In progress, 1 Empty"),
  ).toBeTruthy();
  expect(screen.getByText("2 observations couldn't be credited to a Team")).toBeTruthy();

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
  expect(latestMatch.getByText("4 Done / 1 In progress")).toBeTruthy();
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
