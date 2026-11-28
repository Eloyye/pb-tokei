import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  createMatch,
  type CreateMatchIn,
  type Discipline,
  type Gender,
  getRallyLog,
  getRoster,
  getTabRallyLog,
  isRetryable,
  type Roster,
  subscribeTabRallyLog,
} from "../api/client";
import { useOpenRallyLogPicker } from "../shell/rallyLog";
import {
  deriveMatchDiscipline,
  DISCIPLINE_LIST,
  DISCIPLINES,
  franchiseMatchLabel,
  genderLabel,
  genderShort,
  isGenderEligible,
  playerMetaBadge,
  requiredGenderForSlot,
} from "./discipline";
import { isValidMatchDate } from "./matchDate";
import { NameField } from "./NameField";

type Tour = CreateMatchIn["tour"];
type RosterTeam = CreateMatchIn["team_a"];
type Handedness = RosterTeam[number]["handedness"];
type PlayerDraft = { name: string; handedness: Handedness | ""; gender: Gender | "" };
type TeamDraft = [PlayerDraft, PlayerDraft];

const TOURS: Tour[] = ["ppa", "app", "mlp"];
const EMPTY_TEAM: TeamDraft = [
  { name: "", handedness: "", gender: "" },
  { name: "", handedness: "", gender: "" },
];

function clearDraftGenders(team: TeamDraft): TeamDraft {
  return [
    { ...team[0], gender: "" },
    { ...team[1], gender: "" },
  ];
}

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
  const [disciplineHelper, setDisciplineHelper] = useState<Discipline | "">("");
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

  function changeDisciplineHelper(next: Discipline | "") {
    setDisciplineHelper(next);
    setValidationError(null);
    setTeamA(clearDraftGenders);
    setTeamB(clearDraftGenders);
  }

  const resolvedTeamA = resolveTeam(teamA, roster.players, disciplineHelper);
  const resolvedTeamB = resolveTeam(teamB, roster.players, disciplineHelper);
  const derived = deriveMatchDiscipline(
    [resolvedTeamA[0].gender, resolvedTeamA[1].gender],
    [resolvedTeamB[0].gender, resolvedTeamB[1].gender],
  );
  const helperMismatch = helperConflict(
    disciplineHelper,
    resolvedTeamA,
    resolvedTeamB,
    derived.discipline,
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    create.reset();
    const names = [...teamA, ...teamB].map((player) => player.name.trim());
    const allResolved = [...resolvedTeamA, ...resolvedTeamB];
    const team_a = toRosterTeam(resolvedTeamA);
    const team_b = toRosterTeam(resolvedTeamB);
    let error: string | null = null;
    if (!tournamentText) error = "Enter a Tournament name.";
    else if (!tour) error = "Choose a Tour.";
    else if (!date) error = "Enter a Match date.";
    else if (!isValidMatchDate(date)) error = "Enter a valid Match date (YYYY-MM-DD).";
    else if (names.some((name) => !name)) error = "Enter all four Player names.";
    else if (new Set(names).size !== names.length)
      error = "A Player can't appear twice in a Match.";
    else if (allResolved.some((slot) => !slot.handedness))
      error = "Choose handedness for each new Player.";
    else if (allResolved.some((slot) => !slot.gender)) error = "Choose gender for each Player.";
    else if (derived.error) error = derived.error;
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
              <label className="new-match-field">
                <span>
                  Discipline <span className="new-match-optional">(optional)</span>
                </span>
                <select
                  aria-label="Discipline"
                  value={disciplineHelper}
                  onChange={(event) =>
                    changeDisciplineHelper(event.target.value as Discipline | "")
                  }
                >
                  <option value="">Any</option>
                  {DISCIPLINE_LIST.map((item) => (
                    <option key={item} value={item}>
                      {DISCIPLINES[item]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="new-match-teams">
              <TeamFields
                side="A"
                team={teamA}
                resolved={resolvedTeamA}
                players={roster.players}
                disciplineHelper={disciplineHelper}
                onChange={(next) => {
                  setTeamA(next);
                  setValidationError(null);
                }}
              />
              <TeamFields
                side="B"
                team={teamB}
                resolved={resolvedTeamB}
                players={roster.players}
                disciplineHelper={disciplineHelper}
                onChange={(next) => {
                  setTeamB(next);
                  setValidationError(null);
                }}
              />
            </div>

            {derived.discipline && (
              <p className="new-match-discipline">
                Discipline:{" "}
                <span className="pill discipline-pill">{DISCIPLINES[derived.discipline]}</span>
              </p>
            )}
            {derived.error && !error && (
              <p className="new-match-error new-match-inline-error" role="alert">
                {derived.error}
              </p>
            )}
            {!derived.error && helperMismatch && (
              <output className="new-match-warning">{helperMismatch}</output>
            )}

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
                          {item.matches.map(franchiseMatchLabel).join(" · ") || "No Matches"}
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

type ResolvedSlot = {
  name: string;
  known: Roster["players"][number] | undefined;
  handedness: Handedness | "";
  gender: Gender | "";
  forcedGender: Gender | null;
};

function resolveTeam(
  team: TeamDraft,
  players: Roster["players"],
  disciplineHelper: Discipline | "",
): [ResolvedSlot, ResolvedSlot] {
  const knowns = team.map((draft) => players.find((player) => player.name === draft.name.trim()));
  const intrinsicGenders: [Gender | "", Gender | ""] = [
    knowns[0]?.gender ?? team[0].gender,
    knowns[1]?.gender ?? team[1].gender,
  ];
  const slots = team.map((draft, index): ResolvedSlot => {
    const known = knowns[index];
    const partnerIntrinsic = intrinsicGenders[1 - index] ?? "";
    const forcedGender = requiredGenderForSlot(disciplineHelper, partnerIntrinsic);
    const gender: Gender | "" = known?.gender ?? forcedGender ?? draft.gender;
    return {
      name: draft.name.trim(),
      known,
      handedness: known?.handedness ?? draft.handedness,
      gender,
      forcedGender,
    };
  });
  return [slots[0]!, slots[1]!];
}

function toRosterTeam(team: [ResolvedSlot, ResolvedSlot]): RosterTeam | null {
  const [first, second] = team.map((slot) =>
    slot.handedness && slot.gender
      ? { name: slot.name, handedness: slot.handedness, gender: slot.gender }
      : null,
  );
  return first && second ? [first, second] : null;
}

function helperConflict(
  helper: Discipline | "",
  teamA: [ResolvedSlot, ResolvedSlot],
  teamB: [ResolvedSlot, ResolvedSlot],
  derivedDiscipline: Discipline | null,
): string | null {
  if (!helper) return null;
  if (derivedDiscipline && derivedDiscipline !== helper) {
    return `Selected Players form ${DISCIPLINES[derivedDiscipline]}, not ${DISCIPLINES[helper]}.`;
  }
  for (const team of [teamA, teamB]) {
    for (const slot of team) {
      if (slot.known?.gender && slot.forcedGender && slot.known.gender !== slot.forcedGender) {
        return `${slot.known.name} (${genderShort(slot.known.gender)}) does not fit ${DISCIPLINES[helper]}.`;
      }
    }
  }
  return null;
}

function TeamFields({
  side,
  team,
  resolved,
  players,
  disciplineHelper,
  onChange,
}: {
  side: "A" | "B";
  team: TeamDraft;
  resolved: [ResolvedSlot, ResolvedSlot];
  players: Roster["players"];
  disciplineHelper: Discipline | "";
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
        const slot = resolved[index]!;
        const known = slot.known;
        const label = `Player ${index + 1}`;
        const isLegacyMissingGender = known !== undefined && known.gender === null;
        const isNewDraft = slot.name !== "" && known === undefined;
        const genderLocked =
          (known !== undefined && known.gender !== null) || slot.forcedGender !== null;
        const rename = (name: string) =>
          update(index, {
            name,
            handedness: known ? "" : player.handedness,
            gender: known ? "" : player.gender,
          });
        return (
          <div className="new-match-player-slot" key={index}>
            <div className="new-match-player-meta">
              {known && <span className="pill player-meta-badge">{playerMetaBadge(known)}</span>}
              {isNewDraft && <span className="pill pill-active player-new-pill">NEW</span>}
            </div>
            <div className="new-match-player">
              <NameField
                label={label}
                name={player.name}
                choices={players}
                choiceLabel={(item) => `${item.name} · ${playerMetaBadge(item)}`}
                isChoiceDisabled={
                  slot.forcedGender
                    ? (item) => !isGenderEligible(item.gender, slot.forcedGender)
                    : undefined
                }
                disabledChoiceLabel={(item) =>
                  `${item.name} · ${playerMetaBadge(item)} (ineligible)`
                }
                onChange={rename}
                onPick={({ name }) => rename(name)}
              />
              <label className="new-match-field">
                Handedness
                <select
                  aria-label={`${label} handedness`}
                  value={slot.handedness}
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
              <label className="new-match-field">
                Gender
                <select
                  aria-label={`${label} gender`}
                  value={slot.gender}
                  disabled={genderLocked}
                  onChange={(event) =>
                    update(index, { ...player, gender: event.target.value as Gender | "" })
                  }
                  required
                >
                  <option value="">Choose</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </label>
            </div>
            {isLegacyMissingGender && (
              <p className="backfill-hint">
                {slot.forcedGender
                  ? `Existing Player missing gender — will save as ${genderLabel(slot.forcedGender)} (${genderShort(slot.forcedGender)}) for ${disciplineHelper ? DISCIPLINES[disciplineHelper] : "this Match"}.`
                  : "Existing Player missing gender — choose Male or Female to backfill."}
              </p>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
