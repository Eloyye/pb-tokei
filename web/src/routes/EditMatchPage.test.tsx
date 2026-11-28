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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  deleteMatch,
  getMatch,
  getRallyLog,
  getRoster,
  getTabRallyLog,
  type MatchDetail,
  mergeFranchise,
  mergePlayer,
  mergeTournament,
  replaceMatchPlayer,
  type Roster,
  updateFranchise,
  updateMatch,
  updatePlayer,
  updateTournament,
} from "../api/client";
import { EditMatchPage } from "./EditMatchPage";

type Client = typeof import("../api/client");

vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<Client>()),
  getRallyLog: vi.fn<Client["getRallyLog"]>(),
  getTabRallyLog: vi.fn<Client["getTabRallyLog"]>(),
  getMatch: vi.fn<Client["getMatch"]>(),
  getRoster: vi.fn<Client["getRoster"]>(),
  updateMatch: vi.fn<Client["updateMatch"]>(),
  deleteMatch: vi.fn<Client["deleteMatch"]>(),
  replaceMatchPlayer: vi.fn<Client["replaceMatchPlayer"]>(),
  updatePlayer: vi.fn<Client["updatePlayer"]>(),
  mergePlayer: vi.fn<Client["mergePlayer"]>(),
  updateTournament: vi.fn<Client["updateTournament"]>(),
  mergeTournament: vi.fn<Client["mergeTournament"]>(),
  updateFranchise: vi.fn<Client["updateFranchise"]>(),
  mergeFranchise: vi.fn<Client["mergeFranchise"]>(),
}));

const PATH = "/data/log.duckdb";
const MATCH_ID = "match-1";

const ROSTER: Roster = {
  players: [
    { id: "p-a1", name: "Anna Brigth", handedness: "right", gender: "female" },
    { id: "p-a2", name: "Ben Johns", handedness: "right", gender: "male" },
    { id: "p-b1", name: "Cara Lee", handedness: "left", gender: "female" },
    { id: "p-b2", name: "Dan Kim", handedness: "right", gender: "male" },
    { id: "p-real", name: "Anna Bright", handedness: "right", gender: "female" },
    { id: "p-eve", name: "Eve Park", handedness: "left", gender: "female" },
  ],
  tournaments: [
    { id: "t-ppa", name: "PPA Daytona Beach Open 2026", tour: "ppa" },
    { id: "t-ppa-2", name: "PPA Atlanta Open 2026", tour: "ppa" },
    { id: "t-mlp", name: "MLP Dallas 2026", tour: "mlp" },
  ],
  franchises: [
    { id: "f-dallas", name: "Dallas Flash" },
    { id: "f-miami", name: "Miami Pickleball Club" },
    { id: "f-texas", name: "Texas Ranchers" },
  ],
  franchise_matches: [
    {
      id: "fm-1",
      tournament_id: "t-mlp",
      franchise_a_id: "f-dallas",
      franchise_b_id: "f-miami",
      matches: [
        {
          team_a: ["Anna Brigth", "Ben Johns"],
          team_b: ["Cara Lee", "Dan Kim"],
          discipline: "mixed_doubles",
        },
      ],
    },
  ],
};

function makeDetail(overrides: Partial<MatchDetail> = {}): MatchDetail {
  return {
    id: MATCH_ID,
    date: "2026-04-12",
    tournament: "PPA Daytona Beach Open 2026",
    tournament_id: "t-ppa",
    tour: "ppa",
    team_a: ["Anna Brigth", "Ben Johns"],
    team_b: ["Cara Lee", "Dan Kim"],
    discipline: "mixed_doubles",
    team_a_id: "team-a",
    team_b_id: "team-b",
    franchise_match_id: null,
    franchise_a: null,
    franchise_b: null,
    franchise_a_id: null,
    franchise_b_id: null,
    video_status: "ready",
    annotation_mode: "gold",
    assisted_ratio_budget: 0.25,
    broadcast_seconds: 3600,
    operator_time: {
      active_seconds: 15000, // 4 h 10 m
      calibrate_seconds: 3000,
      annotate_seconds: 12000,
      review_seconds: 0,
    },
    operator_time_ratio: 0.2,
    footage_job: null,
    done_rallies: 100,
    total_rallies: 213,
    fix_command: null,
    source_url: "https://example.com/watch?v=abc",
    original_present: true,
    footage_dir: "/data/footage",
    source_video_path: "/data/footage/abc.webm",
    players: [
      {
        id: "p-a1",
        name: "Anna Brigth",
        handedness: "right",
        gender: "female",
        team_id: "team-a",
        team: "a",
      },
      {
        id: "p-a2",
        name: "Ben Johns",
        handedness: "right",
        gender: "male",
        team_id: "team-a",
        team: "a",
      },
      {
        id: "p-b1",
        name: "Cara Lee",
        handedness: "left",
        gender: "female",
        team_id: "team-b",
        team: "b",
      },
      {
        id: "p-b2",
        name: "Dan Kim",
        handedness: "right",
        gender: "male",
        team_id: "team-b",
        team: "b",
      },
    ],
    ...overrides,
  };
}

function renderEditPage() {
  const root = createRootRoute();
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <h1>Matches Home</h1>,
  });
  const edit = createRoute({
    getParentRoute: () => root,
    path: "/matches/$matchId/edit",
    component: EditMatchPage,
  });
  const workspace = createRoute({
    getParentRoute: () => root,
    path: "/matches/$matchId/$workspace",
    component: () => <h1>Match Workspace</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, edit, workspace]),
    history: createMemoryHistory({ initialEntries: [`/matches/${MATCH_ID}/edit`] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  vi.mocked(getRallyLog).mockResolvedValue({ path: PATH, recent: [] });
  vi.mocked(getTabRallyLog).mockReturnValue(PATH);
  vi.mocked(getMatch).mockResolvedValue(makeDetail());
  vi.mocked(getRoster).mockResolvedValue(ROSTER);
  vi.mocked(updateMatch).mockResolvedValue(makeDetail());
  vi.mocked(deleteMatch).mockResolvedValue({ id: MATCH_ID });
  vi.mocked(replaceMatchPlayer).mockResolvedValue(makeDetail());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EditMatchPage", () => {
  it("warns to close open tabs, re-points Tournament, and swaps/clears MLP Franchise Match", async () => {
    const mlpMatch = makeDetail({
      tournament: "MLP Dallas 2026",
      tournament_id: "t-mlp",
      tour: "mlp",
      franchise_match_id: "fm-1",
      franchise_a: "Dallas Flash",
      franchise_b: "Miami Pickleball Club",
      franchise_a_id: "f-dallas",
      franchise_b_id: "f-miami",
    });
    vi.mocked(getMatch).mockResolvedValue(mlpMatch);
    vi.mocked(updateMatch).mockResolvedValue({
      ...mlpMatch,
      franchise_a: "Miami Pickleball Club",
      franchise_b: "Dallas Flash",
    });

    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });
    expect(
      screen.getByText("Close this Match's workspace in other tabs before editing."),
    ).toBeTruthy();

    // Swap Franchise A and B and save.
    fireEvent.click(screen.getByRole("button", { name: "Swap A & B" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Match details" }));

    await waitFor(() =>
      expect(updateMatch).toHaveBeenCalledWith(
        MATCH_ID,
        {
          franchise_match: {
            franchise_a: "Miami Pickleball Club",
            franchise_b: "Dallas Flash",
            id: "fm-1",
          },
        },
        { rallyLog: PATH },
      ),
    );

    // Clear Franchise Match and save.
    vi.mocked(updateMatch).mockResolvedValueOnce({
      ...mlpMatch,
      franchise_match_id: null,
      franchise_a: null,
      franchise_b: null,
      franchise_a_id: null,
      franchise_b_id: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Match details" }));
    await waitFor(() =>
      expect(updateMatch).toHaveBeenLastCalledWith(
        MATCH_ID,
        { franchise_match: null },
        { rallyLog: PATH },
      ),
    );
  });

  it("replaces a Player in this Match with an existing or new Player and blocks duplicates", async () => {
    const replacedDetail = makeDetail({
      team_a: ["Ben Johns", "Eve Park"],
      players: [
        {
          id: "p-eve",
          name: "Eve Park",
          handedness: "left",
          gender: "female",
          team_id: "team-a2",
          team: "a",
        },
        {
          id: "p-a2",
          name: "Ben Johns",
          handedness: "right",
          gender: "male",
          team_id: "team-a2",
          team: "a",
        },
        {
          id: "p-b1",
          name: "Cara Lee",
          handedness: "left",
          gender: "female",
          team_id: "team-b",
          team: "b",
        },
        {
          id: "p-b2",
          name: "Dan Kim",
          handedness: "right",
          gender: "male",
          team_id: "team-b",
          team: "b",
        },
      ],
    });
    vi.mocked(replaceMatchPlayer).mockResolvedValueOnce(replacedDetail);

    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });
    const teamA = within(screen.getByRole("group", { name: "Team A" }));
    const player1 = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });

    // Refuses a Player already in the Match.
    fireEvent.change(player1, { target: { value: "Cara Lee" } });
    fireEvent.click(teamA.getByRole("button", { name: "Replace Anna Brigth" }));
    expect(teamA.getByRole("alert").textContent).toBe("A Player can't appear twice in a Match.");
    expect(replaceMatchPlayer).not.toHaveBeenCalled();

    // Picks existing Player Eve Park -> sends Player id.
    fireEvent.change(player1, { target: { value: "Eve Park" } });
    fireEvent.click(teamA.getByRole("button", { name: "Replace Anna Brigth" }));
    await waitFor(() =>
      expect(replaceMatchPlayer).toHaveBeenCalledWith(
        MATCH_ID,
        { from: "p-a1", to: "p-eve" },
        { rallyLog: PATH },
      ),
    );
  });

  it("warns with dry-run affected Match count before renaming a Player", async () => {
    vi.mocked(updatePlayer)
      .mockResolvedValueOnce({
        player: { id: "p-a1", name: "Anna B.", handedness: "left", gender: "female" },
        affected_matches: 5,
        dry_run: true,
      })
      .mockResolvedValueOnce({
        player: { id: "p-a1", name: "Anna B.", handedness: "left", gender: "female" },
        affected_matches: 5,
        dry_run: false,
      });

    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });

    fireEvent.click(screen.getByRole("button", { name: "Rename Player Anna Brigth" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Anna B." } });
    fireEvent.change(dialog.getByLabelText("Handedness"), { target: { value: "left" } });
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));

    expect(await dialog.findByText("Also changes 4 other Matches.")).toBeTruthy();
    expect(updatePlayer).toHaveBeenCalledWith(
      "p-a1",
      { name: "Anna B.", handedness: "left", gender: "female" },
      { dryRun: true, rallyLog: PATH },
    );

    fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(updatePlayer).toHaveBeenLastCalledWith(
        "p-a1",
        { name: "Anna B.", handedness: "left", gender: "female" },
        { dryRun: false, rallyLog: PATH },
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers Merge with affected-Match warning when renaming to an exact existing name", async () => {
    vi.mocked(updatePlayer).mockRejectedValueOnce(
      new ApiError(409, "Player 'Anna Bright' already exists; merge into 'Anna Bright' instead", {
        id: "p-real",
        name: "Anna Bright",
      }),
    );
    vi.mocked(mergePlayer)
      .mockResolvedValueOnce({
        player: { id: "p-real", name: "Anna Bright", handedness: "right", gender: "female" },
        affected_matches: 3,
        dry_run: true,
      })
      .mockResolvedValueOnce({
        player: { id: "p-real", name: "Anna Bright", handedness: "right", gender: "female" },
        affected_matches: 3,
        dry_run: false,
      });

    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });

    fireEvent.click(screen.getByRole("button", { name: "Rename Player Anna Brigth" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Anna Bright" } });
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));

    const mergeOffer = await dialog.findByRole("button", { name: 'Merge into "Anna Bright"' });
    fireEvent.click(mergeOffer);

    expect(await dialog.findByText(/Also changes 2 other Matches\./)).toBeTruthy();
    expect(mergePlayer).toHaveBeenCalledWith(
      "p-a1",
      { into: "p-real" },
      { dryRun: true, rallyLog: PATH },
    );

    fireEvent.click(dialog.getByRole("button", { name: 'Confirm Merge into "Anna Bright"' }));
    await waitFor(() =>
      expect(mergePlayer).toHaveBeenLastCalledWith(
        "p-a1",
        { into: "p-real" },
        { dryRun: false, rallyLog: PATH },
      ),
    );
  });

  it("supports Tournament and Franchise rename/merge flows with warnings", async () => {
    const mlpMatch = makeDetail({
      tournament: "MLP Dallas 2026",
      tournament_id: "t-mlp",
      tour: "mlp",
      franchise_match_id: "fm-1",
      franchise_a: "Dallas Flash",
      franchise_b: "Miami Pickleball Club",
      franchise_a_id: "f-dallas",
      franchise_b_id: "f-miami",
    });
    vi.mocked(getMatch).mockResolvedValue(mlpMatch);
    vi.mocked(updateTournament)
      .mockResolvedValueOnce({
        tournament: { id: "t-mlp", name: "MLP Dallas Finals 2026", tour: "mlp" },
        affected_matches: 2,
        dry_run: true,
      })
      .mockResolvedValueOnce({
        tournament: { id: "t-mlp", name: "MLP Dallas Finals 2026", tour: "mlp" },
        affected_matches: 2,
        dry_run: false,
      });
    vi.mocked(updateFranchise).mockRejectedValueOnce(
      new ApiError(409, "Franchise 'Texas Ranchers' already exists", {
        id: "f-texas",
        name: "Texas Ranchers",
      }),
    );
    vi.mocked(mergeFranchise)
      .mockResolvedValueOnce({
        franchise: { id: "f-texas", name: "Texas Ranchers" },
        affected_matches: 4,
        dry_run: true,
      })
      .mockResolvedValueOnce({
        franchise: { id: "f-texas", name: "Texas Ranchers" },
        affected_matches: 4,
        dry_run: false,
      });

    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });

    fireEvent.click(screen.getByRole("button", { name: "Rename Tournament MLP Dallas 2026" }));
    let dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "MLP Dallas Finals 2026" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
    expect(await dialog.findByText("Also changes 1 other Match.")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Rename Franchise Dallas Flash" }));
    dialog = within(await screen.findByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Texas Ranchers" } });
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
    fireEvent.click(await dialog.findByRole("button", { name: 'Merge into "Texas Ranchers"' }));
    expect(await dialog.findByText(/Also changes 3 other Matches\./)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: 'Confirm Merge into "Texas Ranchers"' }));
    await waitFor(() =>
      expect(mergeFranchise).toHaveBeenLastCalledWith(
        "f-dallas",
        { into: "f-texas" },
        { dryRun: false, rallyLog: PATH },
      ),
    );
    expect(mergeTournament).not.toHaveBeenCalled();
  });

  it("requires typing the Tournament name before deleting a Match with Rallies", async () => {
    const router = renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Match" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(
      dialog.getByText(
        "Delete PPA Daytona Beach Open 2026 · Anna Brigth / Ben Johns vs Cara Lee / Dan Kim: 213 Rallies, 4 h 10 m of operator time. This can't be undone.",
      ),
    ).toBeTruthy();
    expect(dialog.getByText("/data/footage")).toBeTruthy();

    const confirmButton = dialog.getByRole<HTMLButtonElement>("button", { name: "Delete Match" });
    expect(confirmButton.disabled).toBe(true);

    const input = dialog.getByLabelText(/Type .* to confirm/);
    fireEvent.change(input, { target: { value: "Wrong Tournament" } });
    expect(confirmButton.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "PPA Daytona Beach Open 2026" } });
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);
    await screen.findByRole("heading", { name: "Matches Home" });
    expect(deleteMatch).toHaveBeenCalledWith(MATCH_ID, { rallyLog: PATH });
    expect(router.state.location.pathname).toBe("/");
  });

  it("deletes a Match without Rallies without requiring typed Tournament confirmation", async () => {
    vi.mocked(getMatch).mockResolvedValue(
      makeDetail({
        total_rallies: 0,
        done_rallies: 0,
        operator_time: {
          active_seconds: 0,
          calibrate_seconds: 0,
          annotate_seconds: 0,
          review_seconds: 0,
        },
      }),
    );
    const router = renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Match" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.queryByLabelText(/Type .* to confirm/)).toBeNull();
    const confirmButton = dialog.getByRole<HTMLButtonElement>("button", { name: "Delete Match" });
    expect(confirmButton.disabled).toBe(false);

    fireEvent.click(confirmButton);
    await screen.findByRole("heading", { name: "Matches Home" });
    expect(router.state.location.pathname).toBe("/");
  });

  it("mentions a source video in a sibling directory sharing the footage_dir prefix", async () => {
    vi.mocked(getMatch).mockResolvedValue(
      makeDetail({
        footage_dir: "/data/footage",
        source_video_path: "/data/footage-old/match.mp4",
      }),
    );
    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });

    fireEvent.click(screen.getByRole("button", { name: "Delete Match" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByText("/data/footage")).toBeTruthy();
    expect(dialog.getByText(/\/data\/footage-old\/match\.mp4/)).toBeTruthy();
  });

  it("requires gender and checks lineup when replacing a Player with a new Player", async () => {
    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });
    expect(screen.getByText("Mixed Doubles", { selector: ".discipline-pill" })).toBeTruthy();

    const teamA = within(screen.getByRole("group", { name: "Team A" }));
    expect(teamA.getByText("R · W")).toBeTruthy();
    expect(teamA.getByText("R · M")).toBeTruthy();

    const player1 = teamA.getByRole<HTMLInputElement>("combobox", { name: "Player 1" });
    const hand1 = teamA.getByLabelText<HTMLSelectElement>("Player 1 handedness");
    const gender1 = teamA.getByLabelText<HTMLSelectElement>("Player 1 gender");

    fireEvent.change(player1, { target: { value: "Brand New Player" } });
    expect(teamA.getByText("NEW")).toBeTruthy();
    fireEvent.change(hand1, { target: { value: "left" } });

    // Missing gender blocks submit.
    fireEvent.click(teamA.getByRole("button", { name: "Replace Anna Brigth" }));
    expect(teamA.getByRole("alert").textContent).toBe("Choose gender for the new Player.");
    expect(replaceMatchPlayer).not.toHaveBeenCalled();

    // Incompatible gender (Male replacing Female in Mixed Doubles) is blocked inline.
    fireEvent.change(gender1, { target: { value: "male" } });
    fireEvent.click(teamA.getByRole("button", { name: "Replace Anna Brigth" }));
    expect(teamA.getByRole("alert").textContent).toContain("Invalid Match lineup");
    expect(replaceMatchPlayer).not.toHaveBeenCalled();

    // Compatible Female gender submits full new Player payload.
    fireEvent.change(gender1, { target: { value: "female" } });
    fireEvent.click(teamA.getByRole("button", { name: "Replace Anna Brigth" }));
    await waitFor(() =>
      expect(replaceMatchPlayer).toHaveBeenCalledWith(
        MATCH_ID,
        {
          from: "p-a1",
          to: { name: "Brand New Player", handedness: "left", gender: "female" },
        },
        { rallyLog: PATH },
      ),
    );
  });

  it("lets EditRecordDialog set legacy Player gender, forbids clearing, and shows 422 conflicts", async () => {
    vi.mocked(getRoster).mockResolvedValue({
      ...ROSTER,
      players: ROSTER.players.map((p) => (p.id === "p-a1" ? { ...p, gender: null } : p)),
    });
    vi.mocked(getMatch).mockResolvedValue(
      makeDetail({
        discipline: null,
        players: [
          {
            id: "p-a1",
            name: "Anna Brigth",
            handedness: "right",
            gender: null,
            team_id: "team-a",
            team: "a",
          },
          {
            id: "p-a2",
            name: "Ben Johns",
            handedness: "right",
            gender: "male",
            team_id: "team-a",
            team: "a",
          },
          {
            id: "p-b1",
            name: "Cara Lee",
            handedness: "left",
            gender: "female",
            team_id: "team-b",
            team: "b",
          },
          {
            id: "p-b2",
            name: "Dan Kim",
            handedness: "right",
            gender: "male",
            team_id: "team-b",
            team: "b",
          },
        ],
      }),
    );
    vi.mocked(updatePlayer)
      .mockRejectedValueOnce(
        new ApiError(
          422,
          "Setting Anna Brigth to male would make PPA Daytona Beach Open 2026 invalid.",
        ),
      )
      .mockResolvedValueOnce({
        player: { id: "p-a1", name: "Anna Brigth", handedness: "right", gender: "female" },
        affected_matches: 1,
        dry_run: true,
      })
      .mockResolvedValueOnce({
        player: { id: "p-a1", name: "Anna Brigth", handedness: "right", gender: "female" },
        affected_matches: 1,
        dry_run: false,
      });

    renderEditPage();
    await screen.findByRole("heading", { name: "Edit Match" });
    expect(screen.getByText("R · ?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rename Player Anna Brigth" }));
    const dialog = within(await screen.findByRole("dialog"));
    const genderSelect = dialog.getByLabelText<HTMLSelectElement>("Gender");
    expect(genderSelect.value).toBe("");

    // Conflicting gender displays 422 error from dry-run without closing dialog.
    fireEvent.change(genderSelect, { target: { value: "male" } });
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
    expect((await dialog.findByRole("alert")).textContent).toContain("PPA Daytona Beach Open 2026");

    // Compatible gender proceeds through dry-run confirmation and saves.
    fireEvent.change(genderSelect, { target: { value: "female" } });
    fireEvent.click(dialog.getByRole("button", { name: "Continue" }));
    expect(await dialog.findByText("Only affects this Match.")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(updatePlayer).toHaveBeenLastCalledWith(
        "p-a1",
        { name: "Anna Brigth", handedness: "right", gender: "female" },
        { dryRun: false, rallyLog: PATH },
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Opening dialog for a Player who already has gender set has no empty option (cannot clear).
    fireEvent.click(screen.getByRole("button", { name: "Rename Player Ben Johns" }));
    const benDialog = within(await screen.findByRole("dialog"));
    const benGender = benDialog.getByLabelText<HTMLSelectElement>("Gender");
    expect(Array.from(benGender.options).map((opt) => opt.value)).toEqual(["male", "female"]);
  });
});
