// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, getMatchReport } from "../api/client";
import type { components } from "../api/schema";
import { reportSaveStatus } from "../lib/unsavedChanges";
import { router as appRouter } from "../router";

type Client = typeof import("../api/client");
type ReportStat = components["schemas"]["ReportStat"];
type MatchReport = components["schemas"]["MatchReport"];

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getMatchReport: vi.fn<Client["getMatchReport"]>(),
  getMatch: vi.fn<Client["getMatch"]>().mockRejectedValue(new Error("No Match detail fixture")),
  getRallyLog: vi.fn<Client["getRallyLog"]>().mockResolvedValue({
    path: "/tmp/demo.duckdb",
    recent: [],
  }),
}));

const RATE = { count: 34, of: 51, estimate: 0.6667, low: 0.55, high: 0.77, left_out: 3 };
const DINK = {
  id: "dink",
  label: "Dink",
  values: {
    a: {
      categories: [
        { id: "advantage", label: "Advantage", count: 4, estimate: 0.4, low: 0.19, high: 0.65 },
        { id: "neutral", label: "Neutral", count: 6, estimate: 0.6, low: 0.35, high: 0.81 },
      ],
      of: 10,
      left_out: 0,
    },
  },
  breakdowns: {},
};

function stat(props: Partial<ReportStat> & Pick<ReportStat, "id" | "label">): ReportStat {
  return {
    group: "Serve & Return",
    kind: "rate",
    applies_to: "both",
    splits_by: [],
    sub_rows: null,
    rows: [],
    values: {},
    breakdowns: {},
    ...props,
  };
}

const REPORT: MatchReport = {
  header: {
    tournament: "Synthetic Doubles Open",
    teams: [
      {
        id: "a",
        players: [
          { id: "a1", name: "Alex One" },
          { id: "a2", name: "Avery Two" },
        ],
      },
      {
        id: "b",
        players: [
          { id: "b1", name: "Blake One" },
          { id: "b2", name: "Brook Two" },
        ],
      },
    ],
    games: [{ number: 1, score: [11, 8] }],
    rallies: { counted: 10, done: 8, in_progress: 1, empty: 1 },
    uncredited: 2,
  },
  stats: [
    stat({
      id: "serves",
      label: "Serves",
      kind: "count",
      values: { a: { count: 34, left_out: 0 } },
    }),
    stat({
      id: "serve_in",
      label: "Serves in",
      values: {
        a: RATE,
        a2: { count: 0, of: 0, estimate: null, low: null, high: null, left_out: 2 },
      },
      splits_by: ["rally_phase", "court_half"],
      breakdowns: { rally_phase: { Serve: { a: RATE } }, court_half: { Left: { a1: RATE } } },
    }),
    stat({
      id: "opening_win",
      label: "Opening win rate",
      group: "Third Shot / Opening",
      applies_to: "team",
      sub_rows: "rally_role",
      rows: [{ id: "serving", label: "Serving", values: { a: RATE }, breakdowns: {} }],
    }),
    stat({
      id: "opening_end_shot",
      label: "Rallies ending in the Opening",
      group: "Third Shot / Opening",
      applies_to: "team",
      kind: "count",
      sub_rows: "end_shot_number",
      rows: [
        { id: "2", label: "Shot 2", values: { a: { count: 4, left_out: 0 } }, breakdowns: {} },
      ],
    }),
    stat({
      id: "shot_outcome",
      label: "Shot Outcome",
      group: "Other",
      kind: "mix",
      sub_rows: "shot_type",
      rows: [DINK],
    }),
    stat({
      id: "outcome_reason",
      label: "Why",
      group: "Other",
      kind: "mix",
      sub_rows: "shot_type",
      rows: [
        {
          ...DINK,
          values: {
            a: { categories: [{ id: "winner", label: "Winner", count: 4 }], of: 4, left_out: 0 },
          },
        },
      ],
    }),
  ],
};

function renderReport(search = "", report = REPORT) {
  vi.mocked(getMatchReport).mockResolvedValue(report);
  const history = createMemoryHistory({ initialEntries: [`/matches/demo/report${search}`] });
  const router = createRouter({ routeTree: appRouter.routeTree, history });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return history;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("renders counts, rates, empty denominators, and left-out observations", async () => {
  renderReport();
  await screen.findByRole("heading", { name: "Alex One / Avery Two vs Blake One / Brook Two" });
  expect(screen.getByText("10 Rallies counted · 8 Done, 1 In progress, 1 Empty")).toBeTruthy();
  expect(screen.getByText("2 observations couldn't be credited to a Team")).toBeTruthy();
  const table = within(screen.getByRole("table", { name: "Serve & Return" }));
  expect(table.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
    "Stat",
    "Team: Alex One / Avery Two",
    "Alex One",
    "Avery Two",
    "Team: Blake One / Brook Two",
    "Blake One",
    "Brook Two",
  ]);
  expect(table.getByRole("link", { name: "Team: Alex One / Avery Two" }).getAttribute("href")).toBe(
    "/teams/a",
  );
  expect(table.getByRole("link", { name: "Alex One" }).getAttribute("href")).toBe("/players/a1");
  expect(within(table.getByRole("row", { name: /^Serves 34/ })).getByText("34")).toBeTruthy();
  const rateCell = table.getByText("34 of 51 · 67% (55–77%)").closest("td");
  expect(rateCell?.querySelector(".report-rate-interval")).toBeTruthy();
  expect(rateCell?.querySelector(".report-rate-tick")).toBeTruthy();
  expect(rateCell?.textContent).toContain("· 3 left out");
  const emptyRate = table.getByText("· 2 left out").closest("td");
  expect(emptyRate?.textContent).toContain("0 of 0 · —");
  expect(emptyRate?.querySelector(".report-rate-track")).toBeNull();
  expect(screen.getByRole("link", { name: "Report" }).getAttribute("aria-current")).toBe("page");
});

it("shows the fixed rows and expands the counts-only Why mix within a Shot Type", async () => {
  renderReport();
  const shotTable = within(await screen.findByRole("table", { name: "Other" }));
  expect(shotTable.getByRole("rowheader", { name: "Dink" })).toBeTruthy();
  expect(within(shotTable.getByTitle("Neutral · 6 · 60% (35%–81%)")).getByText("6")).toBeTruthy();
  expect(shotTable.queryByTitle("Winner · 4")).toBeNull();
  const why = shotTable.getByRole("button", { name: "Why · Dink" });
  expect(why.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(why);
  expect(why.getAttribute("aria-expanded")).toBe("true");
  expect(within(shotTable.getByTitle("Winner · 4")).getByText("4")).toBeTruthy();
  const opening = within(screen.getByRole("table", { name: "Third Shot / Opening" }));
  const serving = opening.getByRole("rowheader", { name: "Serving" }).closest("tr");
  expect(serving?.querySelector(".report-player-column")?.textContent).toBe("");
  expect(opening.getByRole("rowheader", { name: "Shot 2" })).toBeTruthy();
});

it("restores the URL selector and shows which cells split by the selected breakdown", async () => {
  const history = renderReport("?by=rally_phase");
  const selector = await screen.findByRole<HTMLSelectElement>("combobox", {
    name: "Break down by",
  });
  expect(selector.value).toBe("rally_phase");
  expect(screen.getByRole("rowheader", { name: "Serve" })).toBeTruthy();
  fireEvent.change(selector, { target: { value: "court_half" } });
  await waitFor(() => expect(history.location.search).toBe("?by=court_half"));
  const left = screen.getByRole("rowheader", { name: "Left" }).closest("tr")!;
  expect(within(left).getAllByText("doesn't split by this")).toHaveLength(2);
  expect(within(left).getByText("34 of 51 · 67% (55–77%)")).toBeTruthy();
  expect(screen.getByRole("rowheader", { name: "Shot 2" })).toBeTruthy();
  expect(vi.mocked(getMatchReport)).toHaveBeenCalledTimes(1);
  fireEvent.change(selector, { target: { value: "" } });
  await waitFor(() => expect(history.location.search).toBe(""));
});

it("opens a Match with zero Rallies and keeps its header visible", async () => {
  renderReport("", {
    header: {
      ...REPORT.header,
      games: [],
      rallies: { counted: 0, done: 0, in_progress: 0, empty: 0 },
      uncredited: 0,
    },
    stats: [],
  });
  expect(
    await screen.findByText("No Rallies yet. Add Rallies in Annotate to see Match stats."),
  ).toBeTruthy();
  expect(screen.getByText("0 Rallies counted · 0 Done, 0 In progress, 0 Empty")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});

it("waits for queued annotation edits before fetching the report", async () => {
  const editor = {};
  reportSaveStatus(editor, { state: "saving" });
  try {
    renderReport();
    expect(await screen.findByText("Loading Match report…")).toBeTruthy();
    expect(getMatchReport).not.toHaveBeenCalled();
  } finally {
    reportSaveStatus(editor, null);
  }
  expect(await screen.findByRole("table", { name: "Serve & Return" })).toBeTruthy();
  expect(getMatchReport).toHaveBeenCalledTimes(1);
});

it("opens the Rally Log picker when the report request conflicts with the open file", async () => {
  vi.mocked(getMatchReport).mockRejectedValueOnce(new ApiError(409, "Rally Log switched"));
  renderReport();
  expect(await screen.findByText("Rally Log switched")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Choose a Rally Log" }));
  expect(await screen.findByRole("dialog", { name: "Rally Log" })).toBeTruthy();
});

it("shows a request error and loads the report when Retry succeeds", async () => {
  vi.mocked(getMatchReport).mockRejectedValueOnce(new ApiError(404, "Match not found"));
  renderReport();
  expect(await screen.findByText("Match not found")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("table", { name: "Serve & Return" })).toBeTruthy();
  expect(getMatchReport).toHaveBeenCalledTimes(2);
});
