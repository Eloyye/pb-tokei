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
  mergePlayer,
  type Roster,
  updatePlayer,
} from "../api/client";
import { NewMatchPage } from "./NewMatchPage";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  createMatch: vi.fn<Client["createMatch"]>(),
  getRallyLog: vi.fn<Client["getRallyLog"]>(),
  getRoster: vi.fn<Client["getRoster"]>(),
  getTabRallyLog: vi.fn<Client["getTabRallyLog"]>(),
  updatePlayer: vi.fn<Client["updatePlayer"]>(),
  mergePlayer: vi.fn<Client["mergePlayer"]>(),
}));

const PATH = "/data/log.duckdb";
const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";
const roster: Roster = {
  players: [
    { id: "p1", name: "Anna Bright", handedness: "right", gender: "female" },
    { id: "p2", name: "Anna-Leigh Waters", handedness: "right", gender: "female" },
    { id: "p3", name: "Cara Lee", handedness: "left", gender: "female" },
    { id: "p4", name: "Dan Kim", handedness: "right", gender: "male" },
    { id: "p5", name: "J.W. Johnson", handedness: "right", gender: "male" },
    { id: "p6", name: "Ben Johns", handedness: "right", gender: "male" },
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
      matches: [
        {
          team_a: ["Anna Bright", "Anna-Leigh Waters"],
          team_b: ["Cara Lee", "Eve Park"],
          discipline: "womens_doubles",
        },
      ],
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

function teamGroup(side: "A" | "B") {
  return within(screen.getByRole("group", { name: `Team ${side}` }));
}

function pickExisting(side: "A" | "B", slotLabel: "Player 1" | "Player 2", name: string) {
  const group = teamGroup(side);
  const input = group.getByRole<HTMLInputElement>("combobox", { name: slotLabel });
  fireEvent.focus(input);
  change(input, name);
  const listbox = group.getByRole("listbox", { name: slotLabel });
  const option = within(listbox)
    .getAllByRole("option")
    .find((item) => item.textContent?.startsWith(name));
  if (!option) throw new Error(`No option found for ${name}`);
  fireEvent.click(option);
}

function createNew(
  side: "A" | "B",
  slotLabel: "Player 1" | "Player 2",
  name: string,
  hand?: "Left" | "Right",
  gender?: "Male" | "Female",
) {
  const group = teamGroup(side);
  const input = group.getByRole<HTMLInputElement>("combobox", { name: slotLabel });
  fireEvent.focus(input);
  change(input, name);
  const listbox = group.getByRole("listbox", { name: slotLabel });
  fireEvent.click(within(listbox).getByRole("option", { name: `+ Create new Player "${name}"` }));
  if (hand) {
    const handGroup = group.getByRole("group", { name: `${slotLabel} handedness` });
    fireEvent.click(within(handGroup).getByRole("button", { name: hand }));
  }
  if (gender) {
    const genderGroup = group.getByRole("group", { name: `${slotLabel} gender` });
    fireEvent.click(within(genderGroup).getByRole("button", { name: gender }));
  }
}

function fillPlayers() {
  pickExisting("A", "Player 1", "Ben Johns");
  createNew("A", "Player 2", "Eve Park", "Left", "Female");
  pickExisting("B", "Player 1", "Cara Lee");
  pickExisting("B", "Player 2", "Dan Kim");
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

it("shows compact read-only L/R · M/W tag, Edit, and Clear returning focus on existing selection", async () => {
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  const teamA = teamGroup("A");
  expect(teamA.queryByLabelText("Player 1 handedness")).toBeNull();

  pickExisting("A", "Player 1", "Cara Lee");
  expect(teamA.getByText("Cara Lee")).toBeTruthy();
  expect(teamA.getByText("L · W")).toBeTruthy();
  expect(teamA.getByRole("button", { name: "Edit Player Cara Lee" })).toBeTruthy();
  expect(teamA.queryByLabelText("Player 1 handedness")).toBeNull();

  fireEvent.click(teamA.getByRole("button", { name: "Clear Player 1" }));
  const search = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });
  expect(search.value).toBe("");
  expect(document.activeElement).toBe(search);
  expect(getRoster).toHaveBeenCalledExactlyOnceWith(PATH);
});

it("preserves unconfirmed search text on blur and blocks submission until confirmed", async () => {
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  changeTournament("Atlanta Open");
  changeDate("2026-04-12");
  pickExisting("A", "Player 2", "Anna Bright");
  pickExisting("B", "Player 1", "Cara Lee");
  pickExisting("B", "Player 2", "Dan Kim");

  const teamA = teamGroup("A");
  const player1 = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });
  fireEvent.focus(player1);
  change(player1, "Eve Park");
  fireEvent.blur(player1);
  expect(player1.value).toBe("Eve Park");

  submit();
  expect(screen.getByRole("alert").textContent).toContain("Pick an existing Player");
  expect(teamA.getByText("Pick an existing Player or choose + Create.")).toBeTruthy();
  expect(createMatch).not.toHaveBeenCalled();
});

it("enters New draft mode on zero-match Enter, focuses Handedness, and ignores IME composing", async () => {
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  const teamA = teamGroup("A");
  const player1 = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });
  fireEvent.focus(player1);
  change(player1, "Zoe Novak");

  // IME composition must not trigger creation.
  fireEvent.keyDown(player1, { key: "Enter", isComposing: true });
  expect(teamA.queryByRole("group", { name: "Player 1 handedness" })).toBeNull();

  // Zero existing/fuzzy matches -> bare Enter switches to New mode and focuses Handedness.
  fireEvent.keyDown(player1, { key: "Enter" });
  const handGroup = teamA.getByRole("group", { name: "Player 1 handedness" });
  const left = within(handGroup).getByRole("button", { name: "Left" });
  const right = within(handGroup).getByRole("button", { name: "Right" });
  expect(left.getAttribute("aria-pressed")).toBe("false");
  expect(right.getAttribute("aria-pressed")).toBe("false");
  expect(document.activeElement).toBe(left);
  expect(createMatch).not.toHaveBeenCalled();
});

it("guards fuzzy near-matches, blocks bare Enter, re-arms Create anyway on edits, and offers Use existing", async () => {
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  changeTournament("Atlanta Open");
  changeDate("2026-04-12");
  pickExisting("A", "Player 2", "Anna Bright");
  pickExisting("B", "Player 1", "Cara Lee");
  pickExisting("B", "Player 2", "Dan Kim");

  const teamA = teamGroup("A");
  const player1 = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });
  fireEvent.focus(player1);
  change(player1, "Anna Leigh Waters");

  const listbox = teamA.getByRole("listbox", { name: "Player 1" });
  const optionTexts = within(listbox)
    .getAllByRole("option")
    .map((item) => item.textContent);
  expect(optionTexts[0]).toContain("Anna-Leigh Waters");
  expect(optionTexts.at(-1)).toBe('+ Create new Player "Anna Leigh Waters"');

  // Bare Enter never auto-creates when a fuzzy near-match is shown.
  fireEvent.keyDown(player1, { key: "Enter" });
  expect(teamA.queryByRole("group", { name: "Player 1 handedness" })).toBeNull();

  // Explicitly choose + Create -> shows amber warning requiring Create anyway or Use existing.
  fireEvent.click(
    within(listbox).getByRole("option", { name: '+ Create new Player "Anna Leigh Waters"' }),
  );
  const handGroup = teamA.getByRole("group", { name: "Player 1 handedness" });
  fireEvent.click(within(handGroup).getByRole("button", { name: "Right" }));
  const genderGroup = teamA.getByRole("group", { name: "Player 1 gender" });
  fireEvent.click(within(genderGroup).getByRole("button", { name: "Male" }));

  const checkbox = teamA.getByRole<HTMLInputElement>("checkbox", { name: "Create anyway" });
  expect(checkbox.checked).toBe(false);
  submit();
  expect(screen.getByRole("alert").textContent).toContain("Confirm Create anyway");
  expect(createMatch).not.toHaveBeenCalled();

  // Confirming Create anyway then editing the draft name re-arms confirmation.
  fireEvent.click(checkbox);
  expect(checkbox.checked).toBe(true);
  change(teamA.getByLabelText("Player 1"), "JW Johnson");
  expect(teamA.getByRole<HTMLInputElement>("checkbox", { name: "Create anyway" }).checked).toBe(
    false,
  );
  expect(teamA.getByRole("button", { name: "Use J.W. Johnson (R · M)" })).toBeTruthy();

  // Sibling pair ("Collin Johns" vs "Ben Johns") triggers no near-match warning.
  change(teamA.getByLabelText("Player 1"), "Collin Johns");
  expect(teamA.queryByRole("checkbox", { name: "Create anyway" })).toBeNull();

  // Switch back to punctuation variant and click 1-click Use existing.
  change(teamA.getByLabelText("Player 1"), "JW Johnson");
  fireEvent.click(teamA.getByRole("button", { name: "Use J.W. Johnson (R · M)" }));
  expect(teamA.getByText("J.W. Johnson")).toBeTruthy();

  submit();
  await screen.findByRole("heading", { name: "Match Workspace" });
  expect(createMatch).toHaveBeenCalledWith(
    expect.objectContaining({
      team_a: ["p5", "p1"],
      team_b: ["p3", "p4"],
    }),
    PATH,
  );
});

it("disables Players already assigned or staged in another slot and blocks inline collisions", async () => {
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  pickExisting("A", "Player 1", "Anna Bright");
  createNew("A", "Player 2", "Eve Park", "Left", "Female");

  const teamB = teamGroup("B");
  const player1 = teamB.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });
  fireEvent.focus(player1);
  change(player1, "Anna Bright");
  let listbox = teamB.getByRole("listbox", { name: "Player 1" });
  const annaOption = within(listbox).getByRole<HTMLButtonElement>("option", {
    name: /Anna Bright/,
  });
  expect(annaOption.disabled).toBe(true);
  expect(annaOption.textContent).toContain("Already in Team A");
  expect(within(listbox).queryByRole("option", { name: /\+ Create/ })).toBeNull();

  // Staged-new Player in Team A is also shown disabled and suppresses + Create.
  change(player1, "Eve Park");
  listbox = teamB.getByRole("listbox", { name: "Player 1" });
  const eveOption = within(listbox).getByRole<HTMLButtonElement>("option", { name: /Eve Park/ });
  expect(eveOption.disabled).toBe(true);
  expect(eveOption.textContent).toContain("Already in Team A");
  expect(within(listbox).queryByRole("option", { name: /\+ Create/ })).toBeNull();

  // Inline collision guard in New draft mode offers 1-click Use for unused existing Player,
  // and omits Use for a Player already used in Team A.
  createNew("B", "Player 1", "Zoe Fresh", "Right", "Female");
  const draftInput = teamB.getByLabelText("Player 1");
  change(draftInput, "  anna bright ");
  expect(teamB.getByText(/already in Team A/)).toBeTruthy();
  expect(teamB.queryByRole("button", { name: /Use Anna Bright/ })).toBeNull();

  change(draftInput, "cara  lee");
  fireEvent.click(teamB.getByRole("button", { name: "Use Cara Lee (L · W)" }));
  expect(teamB.getByText("Cara Lee")).toBeTruthy();
});

it("keeps legacy duplicate-name Players distinct by id", async () => {
  vi.mocked(getRoster).mockResolvedValue({
    ...roster,
    players: [
      { id: "dup-1", name: "Alex Taylor", handedness: "right", gender: "female" },
      { id: "dup-2", name: "Alex Taylor", handedness: "left", gender: "female" },
      { id: "p3", name: "Cara Lee", handedness: "left", gender: "female" },
      { id: "p4", name: "Dan Kim", handedness: "right", gender: "male" },
    ],
  });
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });

  const teamA = teamGroup("A");
  const player1 = teamA.getByRole("combobox", { name: "Player 1" });
  fireEvent.focus(player1);
  change(player1, "Alex Taylor");
  const options = within(teamA.getByRole("listbox", { name: "Player 1" })).getAllByRole("option");
  expect(options).toHaveLength(2);
  fireEvent.click(options[1]!);
  expect(teamA.getByText("L · W")).toBeTruthy();
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

  change(screen.getByLabelText("Franchise A (Team A)"), "Miami Pickleball Club");
  change(screen.getByLabelText("Franchise B (Team B)"), "Dallas Flash");
  const meeting = screen.getByRole<HTMLSelectElement>("combobox", { name: "Franchise Match" });
  expect(meeting.value).toBe("meeting-uuid");
  expect(meeting.selectedOptions[0]?.textContent).toContain(
    "Anna Bright / Anna-Leigh Waters vs Cara Lee / Eve Park (Women's Doubles)",
  );
  expect(meeting.textContent).not.toContain("meeting-uuid");
  if (choice === "new") change(meeting, "new");

  fillPlayers();
  expect(screen.getByText("Mixed Doubles", { selector: ".discipline-pill" })).toBeTruthy();
  changeDate("2026-04-12");
  fireEvent.click(screen.getByRole("button", { name: "Create Match" }));
  await screen.findByRole("heading", { name: "Match Workspace" });
  expect(createMatch).toHaveBeenCalledWith(
    {
      date: "2026-04-12",
      tournament: "MLP Dallas",
      tour: "mlp",
      team_a: ["p6", { name: "Eve Park", handedness: "left", gender: "female" }],
      team_b: ["p3", "p4"],
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

it("recovers from 422 race conditions by refetching roster while preserving form fields", async () => {
  vi.mocked(getRoster)
    .mockResolvedValueOnce(roster)
    .mockResolvedValueOnce({
      ...roster,
      // p4 disappeared (merged/deleted elsewhere) and Eve Park was created in another tab.
      players: [
        ...roster.players.filter((player) => player.id !== "p4"),
        { id: "p-eve", name: "Eve Park", handedness: "left", gender: "female" },
      ],
    });
  vi.mocked(createMatch).mockRejectedValueOnce(
    new ApiError(422, "Player 'Eve Park' already exists"),
  );

  const router = renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  const tournament = screen.getByLabelText<HTMLInputElement>("Tournament");
  change(tournament, "Atlanta Open");
  const dateField = screen.getByLabelText<HTMLInputElement>("Date");
  change(dateField, "2026-04-12");
  const video = screen.getByLabelText<HTMLInputElement>(/Footage URL/);
  change(video, VIDEO_URL);
  fillPlayers();

  submit();
  expect((await screen.findByRole("alert")).textContent).toBe("Player 'Eve Park' already exists");
  expect(tournament.value).toBe("Atlanta Open");
  expect(dateField.value).toBe("2026-04-12");
  expect(video.value).toBe(VIDEO_URL);

  // Refreshed roster exposes 1-click Use Eve Park (L · W) on the colliding New slot
  // and flags disappeared Dan Kim (p4) with a Clear control.
  const teamA = teamGroup("A");
  const useEve = await teamA.findByRole("button", { name: "Use Eve Park (L · W)" });
  fireEvent.click(useEve);

  const teamB = teamGroup("B");
  expect(teamB.getByText("Player no longer exists in this Rally Log")).toBeTruthy();
  fireEvent.click(teamB.getByRole("button", { name: "Clear Player 2" }));
  pickExisting("B", "Player 2", "J.W. Johnson");

  submit();
  await screen.findByRole("heading", { name: "Match Workspace" });
  expect(router.state.location.pathname).toBe("/matches/created-match/annotate");
  expect(createMatch).toHaveBeenLastCalledWith(
    expect.objectContaining({
      date: "2026-04-12",
      team_a: ["p6", "p-eve"],
      team_b: ["p3", "p5"],
      footage_url: VIDEO_URL,
    }),
    PATH,
  );
});

it("edits and merges existing Players from New Match via EditRecordDialog with global wording", async () => {
  const afterRename: Roster = {
    ...roster,
    players: roster.players.map((p) =>
      p.id === "p1" ? { ...p, name: "Anna B.", handedness: "left" as const } : p,
    ),
  };
  vi.mocked(getRoster)
    .mockResolvedValueOnce(roster)
    .mockResolvedValueOnce(afterRename)
    .mockResolvedValueOnce({
      ...afterRename,
      players: afterRename.players.filter((p) => p.id !== "p3"),
    })
    .mockResolvedValueOnce({
      ...afterRename,
      players: afterRename.players.filter((p) => p.id !== "p3" && p.id !== "p4"),
    });

  // 1) In-place edit (0 affected matches -> global zero wording).
  vi.mocked(updatePlayer)
    .mockResolvedValueOnce({
      player: { id: "p1", name: "Anna B.", handedness: "left", gender: "female" },
      affected_matches: 0,
      dry_run: true,
    })
    .mockResolvedValueOnce({
      player: { id: "p1", name: "Anna B.", handedness: "left", gender: "female" },
      affected_matches: 0,
      dry_run: false,
    });

  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  changeTournament("Atlanta Open");
  changeDate("2026-04-12");
  pickExisting("A", "Player 1", "Anna Bright");
  pickExisting("B", "Player 1", "Cara Lee");
  pickExisting("B", "Player 2", "Dan Kim");

  fireEvent.click(teamGroup("A").getByRole("button", { name: "Edit Player Anna Bright" }));
  let dialog = within(await screen.findByRole("dialog"));
  change(dialog.getByLabelText("Name"), "Anna B.");
  change(dialog.getByLabelText("Handedness"), "left");
  fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
  expect(await dialog.findByText("Doesn't affect any existing Matches yet.")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await teamGroup("A").findByText("Anna B.")).toBeTruthy();
  expect(screen.getByLabelText<HTMLInputElement>("Date").value).toBe("2026-04-12");

  // 2) Merge into an unselected Player Y -> slot switches to Y.
  vi.mocked(updatePlayer).mockRejectedValueOnce(
    new ApiError(409, "Player 'Ben Johns' already exists", { id: "p6", name: "Ben Johns" }),
  );
  vi.mocked(mergePlayer)
    .mockResolvedValueOnce({
      player: { id: "p6", name: "Ben Johns", handedness: "right", gender: "male" },
      affected_matches: 3,
      dry_run: true,
    })
    .mockResolvedValueOnce({
      player: { id: "p6", name: "Ben Johns", handedness: "right", gender: "male" },
      affected_matches: 3,
      dry_run: false,
    });

  fireEvent.click(teamGroup("B").getByRole("button", { name: "Edit Player Cara Lee" }));
  dialog = within(await screen.findByRole("dialog"));
  change(dialog.getByLabelText("Name"), "Ben Johns");
  fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
  fireEvent.click(await dialog.findByRole("button", { name: 'Merge into "Ben Johns"' }));
  expect(await dialog.findByText("Affects 3 Matches.")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: 'Confirm Merge into "Ben Johns"' }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await teamGroup("B").findByText("Ben Johns")).toBeTruthy();

  // 3) Merge into a Player Y already selected in another slot -> clears slot with inline message.
  vi.mocked(updatePlayer).mockRejectedValueOnce(
    new ApiError(409, "Player 'Anna B.' already exists", { id: "p1", name: "Anna B." }),
  );
  vi.mocked(mergePlayer)
    .mockResolvedValueOnce({
      player: { id: "p1", name: "Anna B.", handedness: "left", gender: "female" },
      affected_matches: 1,
      dry_run: true,
    })
    .mockResolvedValueOnce({
      player: { id: "p1", name: "Anna B.", handedness: "left", gender: "female" },
      affected_matches: 1,
      dry_run: false,
    });

  fireEvent.click(teamGroup("B").getByRole("button", { name: "Edit Player Dan Kim" }));
  dialog = within(await screen.findByRole("dialog"));
  change(dialog.getByLabelText("Name"), "Anna B.");
  fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
  fireEvent.click(await dialog.findByRole("button", { name: 'Merge into "Anna B."' }));
  expect(await dialog.findByText("Affects 1 Match.")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: 'Confirm Merge into "Anna B."' }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await teamGroup("B").findByText(/Merged into Anna B\., who is already in Team A/),
  ).toBeTruthy();
  expect(teamGroup("B").getByRole<HTMLInputElement>("combobox", { name: "Player 2" }).value).toBe(
    "",
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
  expect(teamGroup("A").getByLabelText<HTMLInputElement>("Player 2").value).toBe("Eve Park");

  change(meeting, "meeting-uuid");
  submit();
  await screen.findByRole("heading", { name: "Match Workspace" });
});

it.each([
  { error: "Enter a Tournament name.", adjust: () => changeTournament(" ") },
  { error: "Choose a Tour.", adjust: () => changeTournament("New Tournament") },
  { error: "Enter a Match date.", adjust: () => changeDate("") },
  { error: "Enter a valid Match date (YYYY-MM-DD).", adjust: () => changeDate("0002-04-12") },
  {
    error: "Enter a name for each new Player.",
    adjust: () => change(teamGroup("A").getByLabelText("Player 2"), " "),
  },
  {
    error: "Choose handedness for each new Player.",
    adjust: () => {
      fireEvent.click(teamGroup("A").getByRole("button", { name: "Clear Player 2" }));
      createNew("A", "Player 2", "Eve Park", undefined, "Female");
    },
  },
  {
    error: "Choose gender for each Player.",
    adjust: () => {
      fireEvent.click(teamGroup("A").getByRole("button", { name: "Clear Player 2" }));
      createNew("A", "Player 2", "Eve Park", "Left");
    },
  },
  {
    error:
      "Invalid Match lineup: Men's Doubles vs Mixed Doubles (must be Men's Doubles, Women's Doubles, or Mixed Doubles).",
    adjust: () => {
      const genderGroup = teamGroup("A").getByRole("group", { name: "Player 2 gender" });
      fireEvent.click(within(genderGroup).getByRole("button", { name: "Male" }));
    },
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

it("uses the optional Discipline helper to disable ineligible Players without allowing re-creation and locks new genders", async () => {
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  const helper = screen.getByLabelText<HTMLSelectElement>("Discipline");
  expect(helper.value).toBe("");

  // Women's Doubles disables male Players (and suppresses + Create when typing their name)
  // and pre-fills & locks new Players to Female.
  change(helper, "womens_doubles");
  const teamA = teamGroup("A");
  const player1 = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });
  fireEvent.focus(player1);
  change(player1, "Dan Kim");
  let listbox = teamA.getByRole("listbox", { name: "Player 1" });
  const danOption = within(listbox).getByRole<HTMLButtonElement>("option", { name: /Dan Kim/ });
  expect(danOption.disabled).toBe(true);
  expect(danOption.textContent).toContain("Ineligible");
  expect(within(listbox).queryByRole("option", { name: /\+ Create/ })).toBeNull();

  // Mixed Doubles: picking Anna Bright (W) locks Player 2 to Male and disables female Players.
  change(helper, "mixed_doubles");
  pickExisting("A", "Player 1", "Anna Bright");
  const player2 = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 2" });
  fireEvent.focus(player2);
  change(player2, "Anna-Leigh Waters");
  listbox = teamA.getByRole("listbox", { name: "Player 2" });
  const alwOption = within(listbox).getByRole<HTMLButtonElement>("option", {
    name: /Anna-Leigh Waters/,
  });
  expect(alwOption.disabled).toBe(true);
  expect(alwOption.textContent).toContain("Ineligible");

  // Creating a brand-new Player 2 pre-fills & locks Male.
  createNew("A", "Player 2", "Brand New Man", "Right");
  const genderGroup = teamA.getByRole("group", { name: "Player 2 gender" });
  const maleBtn = within(genderGroup).getByRole<HTMLButtonElement>("button", { name: "Male" });
  const femaleBtn = within(genderGroup).getByRole<HTMLButtonElement>("button", { name: "Female" });
  expect(maleBtn.getAttribute("aria-pressed")).toBe("true");
  expect(maleBtn.disabled).toBe(true);
  expect(femaleBtn.disabled).toBe(true);
});

it("prompts inline to backfill gender for a legacy Player and submits ExistingPlayerBackfillIn", async () => {
  vi.mocked(getRoster).mockResolvedValue({
    ...roster,
    players: [
      ...roster.players,
      { id: "p-legacy", name: "Pat Legacy", handedness: "left", gender: null },
    ],
  });
  renderForm();
  await screen.findByRole("heading", { name: "New Match" });
  changeTournament("Atlanta Open");
  changeDate("2026-04-12");

  pickExisting("A", "Player 1", "Anna Bright");
  pickExisting("A", "Player 2", "Pat Legacy");
  const teamA = teamGroup("A");
  expect(teamA.getByText("L · ?")).toBeTruthy();
  expect(
    teamA.getByText("Existing Player missing gender — choose Male or Female to backfill."),
  ).toBeTruthy();

  pickExisting("B", "Player 1", "Cara Lee");
  pickExisting("B", "Player 2", "Dan Kim");

  // Missing gender blocks submit.
  submit();
  expect(screen.getByRole("alert").textContent).toBe("Choose gender for each Player.");
  expect(createMatch).not.toHaveBeenCalled();

  // Choosing Male completes Mixed Doubles and submits { id, gender } for Pat Legacy.
  const genderGroup = teamA.getByRole("group", { name: "Player 2 gender" });
  fireEvent.click(within(genderGroup).getByRole("button", { name: "Male" }));
  expect(screen.getByText("Mixed Doubles", { selector: ".discipline-pill" })).toBeTruthy();
  submit();
  await screen.findByRole("heading", { name: "Match Workspace" });
  expect(createMatch).toHaveBeenCalledWith(
    expect.objectContaining({
      team_a: ["p1", { id: "p-legacy", gender: "male" }],
      team_b: ["p3", "p4"],
    }),
    PATH,
  );
});
