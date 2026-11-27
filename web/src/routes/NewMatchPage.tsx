import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  createMatch,
  type CreateMatchIn,
  getRallyLog,
  getRoster,
  getTabRallyLog,
  isRetryable,
  type Roster,
  subscribeTabRallyLog,
} from "../api/client";
import { useOpenRallyLogPicker } from "../shell/rallyLog";
import { NameField } from "./NameField";
import { isValidMatchDate, teamsLabel } from "./teams";

type Tour = CreateMatchIn["tour"];
type RosterTeam = CreateMatchIn["team_a"];
type Handedness = RosterTeam[number]["handedness"];
type PlayerDraft = { name: string; handedness: Handedness | "" };
type TeamDraft = [PlayerDraft, PlayerDraft];

const TOURS: Tour[] = ["ppa", "app", "mlp"];
const EMPTY_TEAM: TeamDraft = [
  { name: "", handedness: "" },
  { name: "", handedness: "" },
];

export function NewMatchPage() {
  const openPicker = useOpenRallyLogPicker();
  const rallyLog = useQuery({ queryKey: ["rally-log"], queryFn: getRallyLog });
  // Bind the tab before loading the options so the roster and submission use the same Rally Log.
  const path = useSyncExternalStore(subscribeTabRallyLog, getTabRallyLog);
  const roster = useQuery({
    queryKey: ["roster", path],
    queryFn: path === null ? skipToken : () => getRoster(path),
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (failures, error) => failures < 3 && isRetryable(error),
  });

  if (path === null && rallyLog.isError) {
    return <p className="notice error">{rallyLog.error.message}</p>;
  }
  if (path === null && !rallyLog.isPending) {
    return (
      <p className="notice">
        <button type="button" className="button" onClick={openPicker}>
          Choose a Rally Log
        </button>
      </p>
    );
  }
  if (path === null || roster.isPending) return <p className="notice">Loading roster…</p>;
  if (roster.isError && roster.data === undefined) {
    const stale = roster.error instanceof ApiError && roster.error.status === 409;
    return (
      <p className="notice error" role="alert">
        {roster.error.message}{" "}
        <button
          type="button"
          className="button"
          onClick={() => (stale ? openPicker() : void roster.refetch())}
        >
          {stale ? "Choose a Rally Log" : "Retry"}
        </button>
      </p>
    );
  }

  return <NewMatchForm key={path} roster={roster.data} path={path} />;
}

function NewMatchForm({ roster, path }: { roster: Roster; path: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tournamentName, setTournamentName] = useState("");
  const [tourChoice, setTourChoice] = useState<Tour | "">("");
  const [date, setDate] = useState("");
  const [teamA, setTeamA] = useState(EMPTY_TEAM);
  const [teamB, setTeamB] = useState(EMPTY_TEAM);
  const [franchiseA, setFranchiseA] = useState("");
  const [franchiseB, setFranchiseB] = useState("");
  const [meetingChoice, setMeetingChoice] = useState<string | null>(null);
  const [footage, setFootage] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateMatchIn) => createMatch(body, path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["matches"], exact: true });
    },
    onError: (error) => {
      // A meeting or a Player may have been added since this form opened.
      if (error instanceof ApiError && error.status === 422) {
        void queryClient.invalidateQueries({ queryKey: ["roster", path], exact: true });
      }
    },
  });

  const tournamentText = tournamentName.trim();
  const franchiseAText = franchiseA.trim();
  const franchiseBText = franchiseB.trim();
  const namedTournaments = roster.tournaments.filter(({ name }) => name === tournamentText);
  const firstTournament = namedTournaments[0];
  const tournament =
    namedTournaments.find(({ tour }) => tour === tourChoice) ??
    (namedTournaments.every(({ tour }) => tour === firstTournament?.tour)
      ? firstTournament
      : undefined);
  const tour = tournament?.tour ?? tourChoice;
  const aId = roster.franchises.find(({ name }) => name === franchiseAText)?.id;
  const bId = roster.franchises.find(({ name }) => name === franchiseBText)?.id;
  const meetings = roster.franchise_matches.filter(
    (item) =>
      item.tournament_id === tournament?.id &&
      ((item.franchise_a_id === aId && item.franchise_b_id === bId) ||
        (item.franchise_a_id === bId && item.franchise_b_id === aId)),
  );
  const meetingId = meetingChoice ?? (meetings.length === 1 ? meetings[0]?.id : undefined);

  function changeTournament(name: string, selectedTour?: Tour) {
    setTournamentName(name);
    setTourChoice(selectedTour ?? (tournament ? "" : tourChoice));
    setMeetingChoice(null);
  }

  function changeFranchiseA(name: string) {
    setFranchiseA(name);
    setMeetingChoice(null);
  }

  function changeFranchiseB(name: string) {
    setFranchiseB(name);
    setMeetingChoice(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    create.reset();
    const names = [...teamA, ...teamB].map((player) => player.name.trim());
    const team_a = completeTeam(teamA, roster.players);
    const team_b = completeTeam(teamB, roster.players);
    let error: string | null = null;
    if (!tournamentText) error = "Enter a Tournament name.";
    else if (!tour) error = "Choose a Tour.";
    else if (!date) error = "Enter a Match date.";
    else if (!isValidMatchDate(date)) error = "Enter a valid Match date (YYYY-MM-DD).";
    else if (names.some((name) => !name)) error = "Enter all four Player names.";
    else if (new Set(names).size !== names.length)
      error = "A Player can't appear twice in a Match.";
    else if (!team_a || !team_b) error = "Choose handedness for each new Player.";
    else if (tour === "mlp") {
      if (!franchiseAText || !franchiseBText) error = "Enter both Franchise names.";
      else if (franchiseAText === franchiseBText) error = "A Franchise can't play itself.";
      else if (meetings.length > 1 && !meetingId) error = "Choose a Franchise Match.";
    }
    setValidationError(error);
    if (error || !tour || !team_a || !team_b) return;

    create.mutate(
      {
        date,
        tournament: tournamentText,
        tour,
        team_a,
        team_b,
        franchise_match:
          tour === "mlp"
            ? {
                franchise_a: franchiseAText,
                franchise_b: franchiseBText,
                ...(meetingId === undefined ? {} : { id: meetingId === "new" ? null : meetingId }),
              }
            : undefined,
        footage_url: footage.trim() || undefined,
      },
      {
        onSuccess: ({ id }) => {
          if (getTabRallyLog() !== path) return;
          void navigate({
            to: "/matches/$matchId/$workspace",
            params: { matchId: id, workspace: "annotate" },
            replace: true,
          });
        },
      },
    );
  }

  const error = validationError ?? create.error?.message;
  return (
    <main className="new-match">
      <div className="new-match-content">
        <h1>New Match</h1>
        {error && (
          <p className="new-match-error" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={submit} noValidate>
          <fieldset className="new-match-fields" disabled={create.isPending}>
            <div className="new-match-tournament">
              <NameField
                label="Tournament"
                name={tournamentName}
                choices={roster.tournaments}
                choiceLabel={(item) => `${item.name} · ${item.tour.toUpperCase()}`}
                onChange={changeTournament}
                onPick={(item) => changeTournament(item.name, item.tour)}
              />
              <label className="new-match-field">
                Tour
                <select
                  value={tour}
                  disabled={tournament !== undefined}
                  required
                  onChange={(event) => {
                    setTourChoice(event.target.value as Tour | "");
                    setMeetingChoice(null);
                  }}
                >
                  <option value="">Choose a Tour</option>
                  {TOURS.map((item) => (
                    <option key={item} value={item}>
                      {item.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="new-match-field">
                Date
                <input
                  type="date"
                  value={date}
                  required
                  onChange={(event) => setDate(event.target.value)}
                />
              </label>
            </div>

            <div className="new-match-teams">
              <TeamFields side="A" team={teamA} players={roster.players} onChange={setTeamA} />
              <TeamFields side="B" team={teamB} players={roster.players} onChange={setTeamB} />
            </div>

            {tour === "mlp" && (
              <section className="new-match-franchises" aria-labelledby="franchise-match-heading">
                <h2 id="franchise-match-heading">Franchise Match</h2>
                <div className="new-match-teams">
                  <NameField
                    label="Franchise A (Team A)"
                    name={franchiseA}
                    choices={roster.franchises}
                    onChange={changeFranchiseA}
                    onPick={({ name }) => changeFranchiseA(name)}
                  />
                  <NameField
                    label="Franchise B (Team B)"
                    name={franchiseB}
                    choices={roster.franchises}
                    onChange={changeFranchiseB}
                    onPick={({ name }) => changeFranchiseB(name)}
                  />
                </div>
                {meetings.length > 0 && (
                  <label className="new-match-field">
                    Franchise Match
                    <select
                      value={meetingId ?? ""}
                      required
                      onChange={(event) => setMeetingChoice(event.target.value)}
                    >
                      <option value="" disabled>
                        Choose a Franchise Match
                      </option>
                      {meetings.map((item, index) => (
                        <option key={item.id} value={item.id}>
                          Meeting {index + 1} ·{" "}
                          {item.matches.map(teamsLabel).join(" · ") || "No Matches"}
                        </option>
                      ))}
                      <option value="new">New Franchise Match</option>
                    </select>
                  </label>
                )}
              </section>
            )}

            <label className="new-match-field">
              <span>
                Footage URL <span className="new-match-optional">(optional)</span>
              </span>
              <input
                type="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={footage}
                autoComplete="off"
                onChange={(event) => setFootage(event.target.value)}
              />
            </label>
          </fieldset>

          <div className="new-match-actions">
            <button type="submit" className="button primary" disabled={create.isPending}>
              {create.isPending ? "Creating Match…" : "Create Match"}
            </button>
            <Link to="/" className="button">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}

function completeTeam(team: TeamDraft, players: Roster["players"]): RosterTeam | null {
  const [first, second] = team.map((draft) => {
    const name = draft.name.trim();
    const hand = players.find((player) => player.name === name)?.handedness ?? draft.handedness;
    return hand ? { name, handedness: hand } : null;
  });
  return first && second ? [first, second] : null;
}

function TeamFields({
  side,
  team,
  players,
  onChange,
}: {
  side: "A" | "B";
  team: TeamDraft;
  players: Roster["players"];
  onChange: (team: TeamDraft) => void;
}) {
  function update(index: number, player: PlayerDraft) {
    const draft: TeamDraft = [...team];
    draft[index] = player;
    onChange(draft);
  }

  return (
    <fieldset className="new-match-team">
      <legend>
        <span className={`swatch team-${side.toLowerCase()}`} aria-hidden="true" /> Team {side}
      </legend>
      {team.map((player, index) => {
        const known = players.find(({ name }) => name === player.name.trim());
        const label = `Player ${index + 1}`;
        const rename = (name: string) =>
          update(index, { name, handedness: known ? "" : player.handedness });
        return (
          <div className="new-match-player" key={index}>
            <NameField
              label={label}
              name={player.name}
              choices={players}
              onChange={rename}
              onPick={({ name }) => rename(name)}
            />
            <label className="new-match-field">
              Handedness
              <select
                aria-label={`${label} handedness`}
                value={known?.handedness ?? player.handedness}
                disabled={known !== undefined}
                onChange={(event) =>
                  update(index, { ...player, handedness: event.target.value as Handedness | "" })
                }
                required
              >
                <option value="">Choose</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}
