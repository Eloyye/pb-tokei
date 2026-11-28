// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, getComparison } from "../api/client";
import type { components } from "../api/schema";
import { router as appRouter } from "../router";

type Client = typeof import("../api/client");
type Schemas = components["schemas"];
type CompareStat = Schemas["CompareStat"];
type ReportRate = Schemas["ReportRate"];

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getComparison: vi.fn<Client["getComparison"]>(),
  listMatches: vi.fn<Client["listMatches"]>().mockResolvedValue([]),
  getRallyLog: vi.fn<Client["getRallyLog"]>().mockResolvedValue({
    path: "/tmp/demo.duckdb",
    recent: [],
  }),
}));

const ALEX = { id: "10000000-0000-4000-8000-000000000001", name: "Alex One" };
const AVERY = { id: "10000000-0000-4000-8000-000000000002", name: "Avery Two" };
const BLAKE = { id: "10000000-0000-4000-8000-000000000003", name: "Blake One" };
const BROOK = { id: "10000000-0000-4000-8000-000000000004", name: "Brook Two" };
const TEAM_A: Schemas["ReportTeam"] = {
  id: "20000000-0000-4000-8000-000000000001",
  discipline: "mixed_doubles",
  players: [ALEX, AVERY],
};
const TEAM_B: Schemas["ReportTeam"] = {
  id: "20000000-0000-4000-8000-000000000002",
  discipline: "mixed_doubles",
  players: [BLAKE, BROOK],
};
const TOURNAMENT = "30000000-0000-4000-8000-000000000001";
const DATE = "2026-06-04";

function rate(count: number, of: number, low: number, high: number): ReportRate {
  return { count, of, estimate: count / of, low, high, left_out: 0 };
}

const NO_MARKS = { clearly_different: false, breakdowns: {} };

function stats(a: string, b: string): CompareStat[] {
  const base = {
    group: "Shares & Initiative" as const,
    kind: "rate" as const,
    applies_to: "both" as const,
    splits_by: ["shot_number" as const],
    sub_rows: null,
    rows: [],
    row_marks: {},
  };
  return [
    {
      ...base,
      id: "initiative_share",
      label: "Initiative Share",
      values: { [a]: rate(9, 10, 0.7, 0.97), [b]: rate(1, 10, 0.03, 0.3) },
      breakdowns: {
        shot_number: {
          "3": { [a]: rate(5, 5, 0.6, 1), [b]: rate(0, 5, 0, 0.4) },
          "4": { [a]: rate(2, 4, 0.2, 0.8), [b]: rate(1, 4, 0.1, 0.7) },
        },
      },
      marks: { clearly_different: true, breakdowns: { shot_number: ["3"] } },
    },
    {
      ...base,
      id: "hit_share",
      label: "Hit Share",
      values: { [a]: rate(5, 10, 0.3, 0.7), [b]: rate(4, 10, 0.2, 0.6) },
      breakdowns: { shot_number: {} },
      marks: NO_MARKS,
    },
    {
      ...base,
      id: "shot_disadvantage",
      label: "Shot Disadvantage",
      group: "Other",
      sub_rows: "shot_type",
      values: {},
      breakdowns: {},
      rows: [
        {
          id: "dink",
          label: "Dink",
          values: { [a]: rate(1, 20, 0.01, 0.2), [b]: rate(12, 20, 0.4, 0.75) },
          breakdowns: {},
        },
        {
          id: "drive",
          label: "Drive",
          values: { [a]: rate(3, 10, 0.1, 0.6), [b]: rate(4, 10, 0.2, 0.7) },
          breakdowns: {},
        },
      ],
      marks: NO_MARKS,
      row_marks: { dink: { clearly_different: true, breakdowns: {} }, drive: NO_MARKS },
    },
  ];
}

function side<S>(subject: S): {
  subject: S;
  header: Schemas["MultiMatchHeader"];
  undated_matches_excluded: number;
  unclassified_matches_excluded: number;
} {
  return {
    subject,
    header: {
      match_count: 2,
      rallies: { counted: 6, done: 5, in_progress: 1, empty: 0 },
      uncredited: 0,
    },
    undated_matches_excluded: 1,
    unclassified_matches_excluded: 0,
  };
}

function renderCompare(path: string) {
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

function selectValue(name: string) {
  return (screen.getByRole("combobox", { name }) as HTMLSelectElement).value;
}

beforeEach(() => {
  vi.mocked(getComparison).mockImplementation(async ({ kind = "player", a, b }) => {
    const filter_options = {
      tournaments: [{ id: TOURNAMENT, name: "Synthetic MLP Open", tour: "mlp" as const }],
    };
    if (kind === "team") {
      const find = (id?: string | null) => [TEAM_A, TEAM_B].find((team) => team.id === id);
      const [teamA, teamB] = [find(a), find(b)];
      return {
        kind,
        choices: [TEAM_A, TEAM_B],
        a: teamA ? side(teamA) : null,
        b: teamB ? side(teamB) : null,
        stats: teamA && teamB ? stats(teamA.id, teamB.id) : [],
        filter_options,
      };
    }
    const find = (id?: string | null) => [ALEX, AVERY, BLAKE].find((player) => player.id === id);
    const [playerA, playerB] = [find(a), find(b)];
    return {
      kind,
      choices: [ALEX, AVERY, BLAKE],
      a: playerA ? side(playerA) : null,
      b: playerB ? side(playerB) : null,
      stats: playerA && playerB ? stats(playerA.id, playerB.id) : [],
      filter_options,
    };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("opens from the top bar and compares two chosen Players", async () => {
  const history = renderCompare("/");
  fireEvent.click(await screen.findByRole("link", { name: "Compare" }));
  expect(await screen.findByText("Choose two Players to compare.")).toBeTruthy();
  expect((screen.getByRole("radio", { name: "Players" }) as HTMLInputElement).checked).toBe(true);

  fireEvent.change(screen.getByRole("combobox", { name: "Player A" }), {
    target: { value: ALEX.id },
  });
  await waitFor(() => expect(selectValue("Player A")).toBe(ALEX.id));
  const b = within(screen.getByRole("combobox", { name: "Player B" }));
  expect((b.getByRole("option", { name: "Alex One" }) as HTMLOptionElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Player B" }), {
    target: { value: AVERY.id },
  });

  const table = within(await screen.findByRole("table", { name: "Shares & Initiative" }));
  expect(history.location.pathname).toBe("/compare");
  const search = new URLSearchParams(history.location.search);
  expect([search.get("a"), search.get("b")]).toEqual([ALEX.id, AVERY.id]);
  expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "Stat",
    "Alex One",
    "Avery Two",
  ]);
  expect(table.getByRole("link", { name: "Avery Two" }).getAttribute("href")).toBe(
    `/players/${AVERY.id}`,
  );
  const coverage = within(screen.getByRole("region", { name: "Coverage" }));
  expect(coverage.getByRole("heading", { name: "A: Alex One" })).toBeTruthy();
  expect(coverage.getByRole("heading", { name: "B: Avery Two" })).toBeTruthy();
  expect(coverage.getAllByText("1 Match left out because of missing dates.")).toHaveLength(2);
});

it("marks only clearly different rows, overall and per breakdown bucket", async () => {
  const history = renderCompare(`/compare?a=${ALEX.id}&b=${AVERY.id}`);
  const table = within(await screen.findByRole("table", { name: "Shares & Initiative" }));
  const initiative = table.getByRole("row", { name: /^Initiative Share/ });
  expect(within(initiative).getByText("Clearly different")).toBeTruthy();
  expect(initiative.className).toBe("report-row-different");
  expect(within(initiative).getByText("9 of 10 · 90% (70–97%)")).toBeTruthy();
  const hitShare = table.getByRole("row", { name: /^Hit Share/ });
  expect(within(hitShare).queryByText("Clearly different")).toBeNull();
  expect(hitShare.className).toBe("");
  expect(screen.getByText(/the 90% intervals don.t overlap/)).toBeTruthy();

  fireEvent.change(screen.getByRole("combobox", { name: "Break down by" }), {
    target: { value: "shot_number" },
  });
  await waitFor(() => expect(history.location.search).toContain("by=shot_number"));
  const shot3 = table.getByRole("row", { name: /^3/ });
  const shot4 = table.getByRole("row", { name: /^4/ });
  expect(within(shot3).getByText("Clearly different")).toBeTruthy();
  expect(within(shot4).queryByText("Clearly different")).toBeNull();
  expect(getComparison).toHaveBeenCalledTimes(1);
});

it("marks a clearly different sub-row without marking its stat or sibling rows", async () => {
  renderCompare(`/compare?a=${ALEX.id}&b=${AVERY.id}`);
  const table = within(await screen.findByRole("table", { name: "Other" }));
  const heading = table.getByRole("rowheader", { name: "Shot Disadvantage" }).closest("tr");
  expect(heading && within(heading).queryByText("Clearly different")).toBeNull();
  const dink = table.getByRole("row", { name: /^Dink/ });
  expect(within(dink).getByText("Clearly different")).toBeTruthy();
  expect(dink.className).toBe("report-row-different");
  const drive = table.getByRole("row", { name: /^Drive/ });
  expect(within(drive).queryByText("Clearly different")).toBeNull();
});

it("round-trips kind, subjects, breakdown and shared Match filters through the URL", async () => {
  const history = renderCompare(`/compare?kind=team&a=${TEAM_A.id}&b=${TEAM_B.id}&by=opening`);
  const filters = within(await screen.findByRole("group", { name: "Filter Matches" }));
  expect(filters.queryByRole("combobox", { name: "Partner" })).toBeNull();
  expect(filters.queryByRole("combobox", { name: "Opponent" })).toBeNull();
  fireEvent.click(filters.getByRole("checkbox", { name: "Synthetic MLP Open (MLP)" }));
  fireEvent.change(filters.getByRole("combobox", { name: "Tour" }), { target: { value: "mlp" } });
  fireEvent.change(filters.getByLabelText("Date from"), { target: { value: DATE } });
  fireEvent.change(filters.getByLabelText("Date to"), { target: { value: DATE } });
  fireEvent.click(filters.getByRole("button", { name: "Apply filters" }));

  const expected = {
    kind: "team",
    a: TEAM_A.id,
    b: TEAM_B.id,
    tour: "mlp",
    tournament: [TOURNAMENT],
    date_from: DATE,
    date_to: DATE,
  };
  await waitFor(() =>
    expect(getComparison).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal)),
  );
  const url = history.location.href;
  expect(new URLSearchParams(history.location.search).get("by")).toBe("opening");
  cleanup();
  renderCompare(url);
  const restored = within(await screen.findByRole("group", { name: "Filter Matches" }));
  expect(getComparison).toHaveBeenLastCalledWith(expected, expect.any(AbortSignal));
  expect((screen.getByRole("radio", { name: "Teams" }) as HTMLInputElement).checked).toBe(true);
  expect(selectValue("Team A")).toBe(TEAM_A.id);
  expect(selectValue("Team B")).toBe(TEAM_B.id);
  expect(selectValue("Break down by")).toBe("opening");
  expect(
    restored.getByRole("checkbox", { name: "Synthetic MLP Open (MLP)", checked: true }),
  ).toBeTruthy();
  expect((restored.getByRole("combobox", { name: "Tour" }) as HTMLSelectElement).value).toBe("mlp");
  expect((restored.getByLabelText("Date from") as HTMLInputElement).value).toBe(DATE);
  expect((restored.getByLabelText("Date to") as HTMLInputElement).value).toBe(DATE);

  const table = within(screen.getByRole("table", { name: "Shares & Initiative" }));
  expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "Stat",
    "Alex One / Avery Two",
    "Blake One / Brook Two",
  ]);
  const breakdown = within(screen.getByRole("combobox", { name: "Break down by" }));
  expect(breakdown.queryByRole("option", { name: "Court Half" })).toBeNull();
});

it("prefills A from a link and switching kind clears both subjects", async () => {
  const history = renderCompare(`/compare?kind=player&a=${ALEX.id}&by=court_half`);
  await screen.findByText("Choose two Players to compare.");
  expect(selectValue("Player A")).toBe(ALEX.id);
  expect(selectValue("Player B")).toBe("");

  fireEvent.click(screen.getByRole("radio", { name: "Teams" }));
  await screen.findByText("Choose two Teams to compare.");
  const search = new URLSearchParams(history.location.search);
  expect(search.get("kind")).toBe("team");
  expect([search.get("a"), search.get("b"), search.get("by")]).toEqual([null, null, null]);
  expect(selectValue("Team A")).toBe("");
});

it("drops a Team Court Half breakdown and a duplicate subject from a shared URL", async () => {
  renderCompare(`/compare?kind=team&a=${TEAM_A.id}&b=${TEAM_A.id}&by=court_half`);
  await screen.findByText("Choose two Teams to compare.");
  expect(getComparison).toHaveBeenLastCalledWith(
    { kind: "team", a: TEAM_A.id }, // b and by are dropped
    expect.any(AbortSignal),
  );
});

it("offers to choose again when a subject no longer exists", async () => {
  vi.mocked(getComparison).mockRejectedValueOnce(new ApiError(404, "Player not found: x"));
  const history = renderCompare(`/compare?a=${ALEX.id}&b=${BLAKE.id}`);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Player not found");
  fireEvent.click(within(alert).getByRole("button", { name: "Choose again" }));
  await screen.findByText("Choose two Players to compare.");
  expect(history.location.search).toBe("?kind=player");
});

it("clears an inverted date range without asking the server", async () => {
  const history = renderCompare(
    `/compare?a=${ALEX.id}&b=${AVERY.id}&date_from=2026-06-04&date_to=2026-06-03`,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Date from must be on or before Date to.");
  expect(getComparison).not.toHaveBeenCalled();
  fireEvent.click(within(alert).getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("table", { name: "Shares & Initiative" });
  const search = new URLSearchParams(history.location.search);
  expect([search.get("a"), search.get("date_from")]).toEqual([ALEX.id, null]);
});

it("filters Player Compare by Discipline and shows unclassified Match exclusion notices", async () => {
  vi.mocked(getComparison).mockImplementation(async ({ a, b, discipline }) => ({
    kind: "player",
    choices: [ALEX, AVERY, BLAKE],
    a: a
      ? {
          ...side(ALEX),
          undated_matches_excluded: 0,
          unclassified_matches_excluded: discipline ? 1 : 0,
        }
      : null,
    b: b
      ? {
          ...side(AVERY),
          undated_matches_excluded: 0,
          unclassified_matches_excluded: 0,
        }
      : null,
    stats: a && b ? stats(a, b) : [],
    filter_options: { tournaments: [] },
  }));

  const history = renderCompare(`/compare?a=${ALEX.id}&b=${AVERY.id}`);
  const filters = within(await screen.findByRole("group", { name: "Filter Matches" }));
  fireEvent.change(filters.getByRole("combobox", { name: "Discipline" }), {
    target: { value: "mens_doubles" },
  });
  fireEvent.click(filters.getByRole("button", { name: "Apply filters" }));

  await waitFor(() =>
    expect(getComparison).toHaveBeenLastCalledWith(
      { kind: "player", a: ALEX.id, b: AVERY.id, discipline: "mens_doubles" },
      expect.any(AbortSignal),
    ),
  );
  expect(new URLSearchParams(history.location.search).get("discipline")).toBe("mens_doubles");
  const coverage = within(screen.getByRole("region", { name: "Coverage" }));
  expect(coverage.getAllByText("1 Match left out because of unknown Discipline.")).toHaveLength(1);
});
