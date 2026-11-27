// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ApiError,
  createMatch,
  getRallyLog,
  getRoster,
  getTabRallyLog,
  type Roster,
} from "../api/client";
import { NewMatchPage } from "./NewMatchPage";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  createMatch: vi.fn<Client["createMatch"]>(),
  getRallyLog: vi.fn<Client["getRallyLog"]>(),
  getRoster: vi.fn<Client["getRoster"]>(),
  getTabRallyLog: vi.fn<Client["getTabRallyLog"]>(),
}));

const PATH = "/data/log.duckdb";
const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";
const roster: Roster = {
  players: [
    { name: "Anna Bright", handedness: "right" },
    { name: "Anna-Leigh Waters", handedness: "right" },
    { name: "Cara Lee", handedness: "left" },
    { name: "Dan Kim", handedness: "right" },
  ],
  tournaments: [
    { id: "ppa-tournament", name: "Atlanta Open", tour: "ppa" },
    { id: "mlp-tournament", name: "MLP Dallas", tour: "mlp" },
  ],
  franchises: [
    { id: "dallas", name: "Dallas Flash" },
    { id: "miami", name: "Miami Pickleball Club" },
  ],
  franchise_matches: [
    {
      id: "meeting-uuid",
      tournament_id: "mlp-tournament",
      franchise_a_id: "dallas",
      franchise_b_id: "miami",
      matches: [{ team_a: ["Anna Bright", "Anna-Leigh Waters"], team_b: ["Cara Lee", "Dan Kim"] }],
    },
  ],
};

const rosterWithTwoMeetings: Roster = {
  ...roster,
  franchise_matches: [
    ...roster.franchise_matches,
    { ...roster.franchise_matches[0]!, id: "another-meeting", matches: [] },
  ],
};

function renderForm() {
  const root = createRootRoute();
  const newMatch = createRoute({
    getParentRoute: () => root,
    path: "/matches/new",
    component: NewMatchPage,
  });
  const workspace = createRoute({
    getParentRoute: () => root,
    path: "/matches/$matchId/$workspace",
    component: () => <h1>Match Workspace</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([newMatch, workspace]),
    history: createMemoryHistory({ initialEntries: ["/matches/new"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function change(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

function teamFields(side: "A" | "B") {
  const group = within(screen.getByRole("group", { name: `Team ${side}` }));
  return {
    player1: group.getByRole<HTMLInputElement>("combobox", { name: "Player 1" }),
    player2: group.getByRole<HTMLInputElement>("combobox", { name: "Player 2" }),
    hand1: group.getByLabelText<HTMLSelectElement>("Player 1 handedness"),
    hand2: group.getByLabelText<HTMLSelectElement>("Player 2 handedness"),
  };
}

function fillPlayers() {
  const teamA = teamFields("A");
  change(teamA.player1, "Anna Bright");
  change(teamA.player2, "Eve Park");
  change(teamA.hand2, "left");
  const teamB = teamFields("B");
  change(teamB.player1, "Cara Lee");
  change(teamB.player2, "Dan Kim");
}

function changeTournament(value: string) {
  change(screen.getByRole("combobox", { name: "Tournament" }), value);
}

function changeDate(value: string) {
  change(screen.getByLabelText("Date"), value);
}

function changeFranchise(side: "A" | "B", value: string) {
  change(screen.getByRole("combobox", { name: `Franchise ${side} (Team ${side})` }), value);
}

function fillFranchises() {
  changeTournament("MLP Dallas");
  changeFranchise("A", "Dallas Flash");
  changeFranchise("B", "Miami Pickleball Club");
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "Create Match" }));
}

beforeEach(() => {
  vi.mocked(getRallyLog).mockResolvedValue({ path: PATH, recent: [] });
  vi.mocked(getTabRallyLog).mockReturnValue(PATH);
  vi.mocked(getRoster).mockResolvedValue(roster);
  vi.mocked(createMatch).mockResolvedValue({ id: "created-match" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("suggests Player names and locks known handedness after picking one", async () => {
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  const team = teamFields("A");
  expect(team.hand1.value).toBe("");
  expect(team.hand1.disabled).toBe(false);

  change(team.player1, "Anan Bright");
  fireEvent.click(screen.getByRole("button", { name: "Anna Bright" }));
  expect(team.player1.value).toBe("Anna Bright");
  expect(team.hand1.value).toBe("right");
  expect(team.hand1.disabled).toBe(true);
  change(team.player1, "Anna Bright ");
  expect(team.hand1.value).toBe("right");
  expect(team.hand1.disabled).toBe(true);

  change(team.player2, "Waters");
  fireEvent.click(screen.getByRole("button", { name: "Anna-Leigh Waters" }));
  expect(team.player2.value).toBe("Anna-Leigh Waters");
  expect(team.hand2.disabled).toBe(true);
  expect(getRoster).toHaveBeenCalledExactlyOnceWith(PATH);
});

it.each(["existing", "new"])("can choose a %s Franchise Match for MLP", async (choice) => {
  renderForm();
  const tournament = await screen.findByRole<HTMLInputElement>("combobox", { name: "Tournament" });
  expect(screen.queryByRole("region", { name: "Franchise Match" })).toBeNull();
  const tour = screen.getByLabelText<HTMLSelectElement>("Tour");
  expect(tour.value).toBe("");
  expect(tour.disabled).toBe(false);

  change(tournament, "Dallas");
  fireEvent.keyDown(tournament, { key: "ArrowDown" });
  expect(
    screen.getByRole("option", { name: "MLP Dallas · MLP" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(tournament, { key: "Enter" });
  expect(tour.value).toBe("mlp");
  expect(tour.disabled).toBe(true);

  // The stored Franchise Match is listed regardless of which Franchise the form names first.
  change(screen.getByLabelText("Franchise A (Team A)"), "Miami Pickleball Club");
  change(screen.getByLabelText("Franchise B (Team B)"), "Dallas Flash");
  const meeting = screen.getByRole<HTMLSelectElement>("combobox", { name: "Franchise Match" });
  expect(meeting.value).toBe("meeting-uuid");
  expect(meeting.selectedOptions[0]?.textContent).toContain("Anna Bright / Anna-Leigh Waters");
  expect(meeting.textContent).not.toContain("meeting-uuid");
  if (choice === "new") change(meeting, "new");

  fillPlayers();
  changeDate("2026-04-12");
  fireEvent.click(screen.getByRole("button", { name: "Create Match" }));
  await screen.findByRole("heading", { name: "Match Workspace" });
  expect(createMatch).toHaveBeenCalledWith(
    {
      date: "2026-04-12",
      tournament: "MLP Dallas",
      tour: "mlp",
      team_a: [
        { name: "Anna Bright", handedness: "right" },
        { name: "Eve Park", handedness: "left" },
      ],
      team_b: [
        { name: "Cara Lee", handedness: "left" },
        { name: "Dan Kim", handedness: "right" },
      ],
      franchise_match: {
        franchise_a: "Miami Pickleball Club",
        franchise_b: "Dallas Flash",
        id: choice === "new" ? null : "meeting-uuid",
      },
      footage_url: undefined,
    },
    PATH,
  );
});

it("keeps the draft on a RosterError and opens the Workspace on success", async () => {
  vi.mocked(createMatch).mockRejectedValueOnce(new ApiError(422, "Choose the stored Player name"));
  const router = renderForm();
  const button = await screen.findByRole("button", { name: "Create Match" });
  const tournament = screen.getByLabelText<HTMLInputElement>("Tournament");
  change(tournament, "Atlanta Open");
  const dateField = screen.getByLabelText<HTMLInputElement>("Date");
  change(dateField, "2026-04-12");
  const video = screen.getByLabelText<HTMLInputElement>(/Footage URL/);
  change(video, VIDEO_URL);
  fillPlayers();

  fireEvent.click(button);
  expect((await screen.findByRole("alert")).textContent).toBe("Choose the stored Player name");
  expect(tournament.value).toBe("Atlanta Open");
  expect(dateField.value).toBe("2026-04-12");
  expect(teamFields("A").player2.value).toBe("Eve Park");
  expect(video.value).toBe(VIDEO_URL);

  fireEvent.click(button);
  await screen.findByRole("heading", { name: "Match Workspace" });
  expect(router.state.location.pathname).toBe("/matches/created-match/annotate");
  expect(createMatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ date: "2026-04-12", footage_url: VIDEO_URL }),
    PATH,
  );
});

it("lets the server match a meeting that was absent when the form opened", async () => {
  vi.mocked(getRoster)
    .mockResolvedValueOnce({ ...roster, franchise_matches: [] })
    .mockResolvedValueOnce(rosterWithTwoMeetings);
  vi.mocked(createMatch).mockRejectedValueOnce(
    new ApiError(422, "The Franchises met more than once"),
  );
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  fillPlayers();
  fillFranchises();
  changeDate("2026-04-12");
  expect(screen.queryByRole("combobox", { name: "Franchise Match" })).toBeNull();

  submit();

  expect((await screen.findByRole("alert")).textContent).toBe("The Franchises met more than once");
  expect(vi.mocked(createMatch).mock.calls[0]?.[0].franchise_match).toStrictEqual({
    franchise_a: "Dallas Flash",
    franchise_b: "Miami Pickleball Club",
  });
  const meeting = await screen.findByRole<HTMLSelectElement>("combobox", {
    name: "Franchise Match",
  });
  expect(meeting.value).toBe("");
  expect(teamFields("A").player2.value).toBe("Eve Park");

  change(meeting, "meeting-uuid");
  submit();
  await screen.findByRole("heading", { name: "Match Workspace" });
});

it.each([
  { error: "Enter a Tournament name.", adjust: () => changeTournament(" ") },
  { error: "Choose a Tour.", adjust: () => changeTournament("New Tournament") },
  { error: "Enter a Match date.", adjust: () => changeDate("") },
  { error: "Enter all four Player names.", adjust: () => change(teamFields("A").player2, " ") },
  {
    error: "A Player can't appear twice in a Match.",
    adjust: () => change(teamFields("B").player2, "Anna Bright "),
  },
  {
    error: "Choose handedness for each new Player.",
    adjust: () => change(teamFields("A").hand2, ""),
  },
  {
    error: "Enter both Franchise names.",
    mlp: true,
    adjust: () => changeFranchise("B", " "),
  },
  {
    error: "A Franchise can't play itself.",
    mlp: true,
    adjust: () => changeFranchise("B", "Dallas Flash "),
  },
  { error: "Choose a Franchise Match.", mlp: true },
])("blocks an invalid form with $error", async ({ error, adjust, mlp }) => {
  vi.mocked(getRoster).mockResolvedValue(rosterWithTwoMeetings);
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  fillPlayers();
  changeDate("2026-04-12");
  if (mlp) fillFranchises();
  else changeTournament("Atlanta Open");
  adjust?.();

  submit();

  expect(screen.getByRole("alert").textContent).toBe(error);
  expect(createMatch).not.toHaveBeenCalled();
});

it("stays off the old Match Workspace if the Rally Log changes during creation", async () => {
  let complete: ((value: { id: string }) => void) | undefined;
  vi.mocked(createMatch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const router = renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  changeTournament("Atlanta Open");
  changeDate("2026-04-12");
  fillPlayers();
  submit();
  await screen.findByRole("button", { name: "Creating Match…" });
  await waitFor(() => expect(complete).toBeDefined());

  vi.mocked(getTabRallyLog).mockReturnValue("/data/other.duckdb");
  complete?.({ id: "created-match" });

  await screen.findByRole("button", { name: "Create Match" });
  expect(router.state.location.pathname).toBe("/matches/new");
});
