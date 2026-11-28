import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  type Gender,
  getMatch,
  getRallyLog,
  getRoster,
  getTabRallyLog,
  type Handedness,
  isRetryable,
  type MatchDetail,
  type MatchPlayer,
  replaceMatchPlayer,
  type ReplacePlayerIn,
  type Roster,
  subscribeTabRallyLog,
  type Tour,
  updateMatch,
  type UpdateMatchIn,
} from "../api/client";
import { useOpenRallyLogPicker } from "../shell/rallyLog";
import { DeleteMatchDialog } from "./DeleteMatchDialog";
import {
  deriveMatchDiscipline,
  disciplineLabel,
  franchiseMatchLabel,
  playerMetaBadge,
} from "./discipline";
import { type EditableRecord, EditRecordDialog } from "./EditRecordDialog";
import { isValidMatchDate } from "./matchDate";
import { NameField } from "./NameField";

const route = getRouteApi("/matches/$matchId/edit");
const TOURS: Tour[] = ["ppa", "app", "mlp"];

export function EditMatchPage() {
  const { matchId } = route.useParams();
  const openPicker = useOpenRallyLogPicker();
  const rallyLog = useQuery({ queryKey: ["rally-log"], queryFn: getRallyLog });
  const path = useSyncExternalStore(subscribeTabRallyLog, getTabRallyLog);

  const matchQuery = useQuery({
    queryKey: ["matches", matchId, path],
    queryFn: path === null ? skipToken : () => getMatch(matchId, { rallyLog: path }),
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (failures, error) => failures < 3 && isRetryable(error),
  });
  const rosterQuery = useQuery({
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
  if (path === null || matchQuery.isPending || rosterQuery.isPending) {
    return <p className="notice">Loading Match…</p>;
  }
  const loadError =
    (matchQuery.isError && matchQuery.data === undefined ? matchQuery.error : null) ??
    (rosterQuery.isError && rosterQuery.data === undefined ? rosterQuery.error : null);
  if (loadError || !matchQuery.data || !rosterQuery.data) {
    const stale = loadError instanceof ApiError && loadError.status === 409;
    const missing = loadError instanceof ApiError && loadError.status === 404;
    return (
      <p className="notice error" role="alert">
        {loadError?.message ?? "Could not load Match."}{" "}
        {stale ? (
          <button type="button" className="button" onClick={openPicker}>
            Choose a Rally Log
          </button>
        ) : missing ? (
          <Link to="/" className="button">
            Back to Home
          </Link>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() => {
              void matchQuery.refetch();
              void rosterQuery.refetch();
            }}
          >
            Retry
          </button>
        )}
      </p>
    );
  }

  return (
    <EditMatchContent
      key={`${path}:${matchId}`}
      match={matchQuery.data}
      roster={rosterQuery.data}
      path={path}
    />
  );
}

function EditMatchContent({
  match,
  roster,
  path,
}: {
  match: MatchDetail;
  roster: Roster;
  path: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [editingRecord, setEditingRecord] = useState<EditableRecord | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  function invalidateAll(updated?: MatchDetail) {
    if (updated) {
      queryClient.setQueryData(["matches", match.id, path], updated);
      queryClient.setQueryData(["matches", match.id], updated);
    } else {
      void queryClient.invalidateQueries({ queryKey: ["matches", match.id] });
    }
    void queryClient.invalidateQueries({ queryKey: ["matches"], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["roster", path], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["players"] });
    void queryClient.invalidateQueries({ queryKey: ["teams"] });
  }

  const detailsKey = [
    match.date ?? "",
    match.tournament_id,
    match.tournament,
    match.tour,
    match.franchise_match_id ?? "",
    match.franchise_a ?? "",
    match.franchise_b ?? "",
  ].join("\0");

  const teamAPlayers = match.players.filter((player) => player.team === "a");
  const teamBPlayers = match.players.filter((player) => player.team === "b");

  return (
    <main className="new-match edit-match">
      <div className="new-match-content">
        <div className="edit-match-head">
          <div className="edit-match-title">
            <h1>Edit Match</h1>
            <span className="pill discipline-pill">{disciplineLabel(match.discipline)}</span>
          </div>
          <div className="edit-match-nav">
            <Link
              to="/matches/$matchId/$workspace"
              params={{ matchId: match.id, workspace: "annotate" }}
              className="button"
            >
              Open Workspace
            </Link>
            <Link to="/" className="button">
              Back to Home
            </Link>
          </div>
        </div>

        <p className="edit-match-banner" role="note">
          Close this Match's workspace in other tabs before editing.
        </p>

        {statusMessage && <output className="edit-match-status">{statusMessage}</output>}

        <MatchDetailsForm
          key={detailsKey}
          match={match}
          roster={roster}
          path={path}
          onEditRecord={setEditingRecord}
          onSaved={(updated) => {
            invalidateAll(updated);
            setStatusMessage("Saved Match details.");
          }}
          onRosterStale={() =>
            void queryClient.invalidateQueries({ queryKey: ["roster", path], exact: true })
          }
        />

        <section className="edit-match-section" aria-labelledby="edit-players-heading">
          <div className="edit-section-head">
            <h2 id="edit-players-heading">Players</h2>
            <p className="edit-section-hint">
              Replacing a Player rewrites their Rallies, Shots, and anchors in this Match only. Use
              Rename to change a Player across every Match.
            </p>
          </div>
          <div className="new-match-teams">
            <PlayerTeamSection
              side="A"
              match={match}
              players={teamAPlayers}
              catalog={roster.players}
              path={path}
              onEditRecord={setEditingRecord}
              onReplaced={(updated, oldName, newName) => {
                invalidateAll(updated);
                setStatusMessage(`Replaced ${oldName} with ${newName} in this Match.`);
              }}
            />
            <PlayerTeamSection
              side="B"
              match={match}
              players={teamBPlayers}
              catalog={roster.players}
              path={path}
              onEditRecord={setEditingRecord}
              onReplaced={(updated, oldName, newName) => {
                invalidateAll(updated);
                setStatusMessage(`Replaced ${oldName} with ${newName} in this Match.`);
              }}
            />
          </div>
        </section>

        <section className="edit-match-danger" aria-labelledby="danger-zone-heading">
          <div>
            <h2 id="danger-zone-heading">Delete Match</h2>
            <p>
              Permanently removes this Match, its Rallies, Shots, Play Segments, Calibrations,
              Player anchors, Team ends, and operator sessions. Footage files in{" "}
              <span className="mono">{match.footage_dir}</span> and the Player Tracking cache are
              kept.
            </p>
          </div>
          <button type="button" className="button danger" onClick={() => setDeleteOpen(true)}>
            Delete Match
          </button>
        </section>

        {editingRecord && (
          <EditRecordDialog
            key={`${editingRecord.kind}:${editingRecord.id}`}
            record={editingRecord}
            rallyLog={path}
            onClose={() => setEditingRecord(null)}
            onSaved={(message) => {
              setEditingRecord(null);
              setStatusMessage(message);
              invalidateAll();
            }}
          />
        )}

        {deleteOpen && (
          <DeleteMatchDialog
            match={match}
            rallyLog={path}
            onClose={() => setDeleteOpen(false)}
            onDeleted={() => {
              setDeleteOpen(false);
              queryClient.removeQueries({ queryKey: ["matches", match.id] });
              void queryClient.invalidateQueries({ queryKey: ["matches"], exact: true });
              void queryClient.invalidateQueries({ queryKey: ["roster", path], exact: true });
              void queryClient.invalidateQueries({ queryKey: ["players"] });
              void queryClient.invalidateQueries({ queryKey: ["teams"] });
              if (getTabRallyLog() === path) {
                void navigate({ to: "/", replace: true });
              }
            }}
          />
        )}
      </div>
    </main>
  );
}

function MatchDetailsForm({
  match,
  roster,
  path,
  onEditRecord,
  onSaved,
  onRosterStale,
}: {
  match: MatchDetail;
  roster: Roster;
  path: string;
  onEditRecord: (record: EditableRecord) => void;
  onSaved: (updated: MatchDetail) => void;
  onRosterStale: () => void;
}) {
  const [tournamentName, setTournamentName] = useState(match.tournament);
  const [tourChoice, setTourChoice] = useState<Tour | "">(match.tour);
  const [date, setDate] = useState(match.date ?? "");
  const [franchiseA, setFranchiseA] = useState(match.franchise_a ?? "");
  const [franchiseB, setFranchiseB] = useState(match.franchise_b ?? "");
  const [meetingChoice, setMeetingChoice] = useState<string | null>(match.franchise_match_id);
  const [validationError, setValidationError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: UpdateMatchIn) => updateMatch(match.id, body, { rallyLog: path }),
    onSuccess: (updated) => {
      setValidationError(null);
      onSaved(updated);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 422) onRosterStale();
    },
  });

  const tournamentText = tournamentName.trim();
  const franchiseAText = franchiseA.trim();
  const franchiseBText = franchiseB.trim();
  const namedTournaments = roster.tournaments.filter(({ name }) => name === tournamentText);
  const firstTournament = namedTournaments[0];
  const matchedTournament =
    namedTournaments.find(({ tour }) => tour === tourChoice) ??
    (namedTournaments.every(({ tour }) => tour === firstTournament?.tour)
      ? firstTournament
      : undefined);
  const tour = matchedTournament?.tour ?? tourChoice;
  const aId = roster.franchises.find(({ name }) => name === franchiseAText)?.id;
  const bId = roster.franchises.find(({ name }) => name === franchiseBText)?.id;
  const meetings = roster.franchise_matches.filter(
    (item) =>
      item.tournament_id === matchedTournament?.id &&
      ((item.franchise_a_id === aId && item.franchise_b_id === bId) ||
        (item.franchise_a_id === bId && item.franchise_b_id === aId)),
  );
  const validMeetingChoice =
    meetingChoice === "new" || meetings.some((item) => item.id === meetingChoice)
      ? meetingChoice
      : null;
  const meetingId = validMeetingChoice ?? (meetings.length === 1 ? meetings[0]?.id : undefined);

  const dateChanged = date !== (match.date ?? "");
  const tournamentChanged =
    matchedTournament !== undefined
      ? matchedTournament.id !== match.tournament_id
      : tournamentText !== match.tournament || tour !== match.tour;
  const franchiseFieldsEmpty = !franchiseAText && !franchiseBText;
  const franchiseChanged =
    tour === "mlp"
      ? franchiseAText !== (match.franchise_a ?? "") ||
        franchiseBText !== (match.franchise_b ?? "") ||
        (!franchiseFieldsEmpty &&
          ((meetingId === "new" && match.franchise_match_id !== null) ||
            (meetingId !== undefined &&
              meetingId !== "new" &&
              meetingId !== match.franchise_match_id)))
      : match.franchise_match_id !== null;
  const hasChanges = dateChanged || tournamentChanged || franchiseChanged;

  function changeTournament(name: string, selectedTour?: Tour) {
    setTournamentName(name);
    setTourChoice(selectedTour ?? (matchedTournament ? "" : tourChoice));
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

  function swapFranchises() {
    setFranchiseA(franchiseB);
    setFranchiseB(franchiseA);
  }

  function clearFranchises() {
    setFranchiseA("");
    setFranchiseB("");
    setMeetingChoice(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending || !hasChanges) return;
    save.reset();

    let error: string | null = null;
    if (!tournamentText) error = "Enter a Tournament name.";
    else if (!tour) error = "Choose a Tour.";
    else if (dateChanged && !date) error = "Match date cannot be cleared.";
    else if (dateChanged && !isValidMatchDate(date)) {
      error = "Enter a valid Match date (YYYY-MM-DD).";
    } else if (tour === "mlp" && !franchiseFieldsEmpty) {
      if (!franchiseAText || !franchiseBText) {
        error = "Enter both Franchise names, or leave both blank to clear.";
      } else if (franchiseAText === franchiseBText) {
        error = "A Franchise can't play itself.";
      } else if (meetings.length > 1 && !meetingId) {
        error = "Choose a Franchise Match.";
      }
    }

    setValidationError(error);
    if (error || !tour) return;

    const body: UpdateMatchIn = {};
    if (dateChanged) body.date = date;
    if (tournamentChanged) {
      body.tournament =
        matchedTournament !== undefined ? matchedTournament.id : { name: tournamentText, tour };
    }
    if (franchiseChanged) {
      if (tour !== "mlp" || franchiseFieldsEmpty) {
        body.franchise_match = null;
      } else {
        body.franchise_match = {
          franchise_a: franchiseAText,
          franchise_b: franchiseBText,
          ...(meetingId === undefined ? {} : { id: meetingId === "new" ? null : meetingId }),
        };
      }
    }
    save.mutate(body);
  }

  const error = validationError ?? save.error?.message;
  return (
    <form className="edit-match-section" onSubmit={submit} noValidate>
      <div className="edit-section-head">
        <h2>Match details</h2>
        <p className="edit-section-hint">
          Changes here apply to this Match only. Use Rename to change a Tournament or Franchise
          across every Match.
        </p>
      </div>
      {error && (
        <p className="new-match-error" role="alert">
          {error}
        </p>
      )}
      <fieldset className="new-match-fields" disabled={save.isPending}>
        <div className="new-match-tournament">
          <div className="edit-field-with-action">
            <NameField
              label="Tournament"
              name={tournamentName}
              choices={roster.tournaments}
              choiceLabel={(item) => `${item.name} · ${item.tour.toUpperCase()}`}
              onChange={changeTournament}
              onPick={(item) => changeTournament(item.name, item.tour)}
            />
            <button
              type="button"
              className="edit-rename-button"
              aria-label={`Rename Tournament ${match.tournament}`}
              title={`Rename or change Tour of "${match.tournament}" across all Matches`}
              onClick={() =>
                onEditRecord({
                  kind: "tournament",
                  id: match.tournament_id,
                  name: match.tournament,
                  tour: match.tour,
                })
              }
            >
              Rename
            </button>
          </div>
          <label className="new-match-field">
            Tour
            <select
              value={tour}
              disabled={matchedTournament !== undefined}
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
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
        </div>

        {tour === "mlp" && (
          <section className="new-match-franchises" aria-labelledby="edit-franchise-match-heading">
            <div className="edit-franchise-head">
              <h3 id="edit-franchise-match-heading">Franchise Match</h3>
              <div className="edit-franchise-tools">
                <button
                  type="button"
                  className="button"
                  disabled={!franchiseAText && !franchiseBText}
                  onClick={swapFranchises}
                >
                  Swap A &amp; B
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={!franchiseAText && !franchiseBText && match.franchise_match_id === null}
                  onClick={clearFranchises}
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="new-match-teams">
              <div className="edit-field-with-action">
                <NameField
                  label="Franchise A (Team A)"
                  name={franchiseA}
                  choices={roster.franchises}
                  onChange={changeFranchiseA}
                  onPick={({ name }) => changeFranchiseA(name)}
                />
                {match.franchise_a_id && match.franchise_a && (
                  <button
                    type="button"
                    className="edit-rename-button"
                    aria-label={`Rename Franchise ${match.franchise_a}`}
                    title={`Rename "${match.franchise_a}" across all Matches`}
                    onClick={() =>
                      onEditRecord({
                        kind: "franchise",
                        id: match.franchise_a_id!,
                        name: match.franchise_a!,
                      })
                    }
                  >
                    Rename
                  </button>
                )}
              </div>
              <div className="edit-field-with-action">
                <NameField
                  label="Franchise B (Team B)"
                  name={franchiseB}
                  choices={roster.franchises}
                  onChange={changeFranchiseB}
                  onPick={({ name }) => changeFranchiseB(name)}
                />
                {match.franchise_b_id && match.franchise_b && (
                  <button
                    type="button"
                    className="edit-rename-button"
                    aria-label={`Rename Franchise ${match.franchise_b}`}
                    title={`Rename "${match.franchise_b}" across all Matches`}
                    onClick={() =>
                      onEditRecord({
                        kind: "franchise",
                        id: match.franchise_b_id!,
                        name: match.franchise_b!,
                      })
                    }
                  >
                    Rename
                  </button>
                )}
              </div>
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
      </fieldset>

      <div className="new-match-actions">
        <button type="submit" className="button primary" disabled={save.isPending || !hasChanges}>
          {save.isPending ? "Saving…" : "Save Match details"}
        </button>
      </div>
    </form>
  );
}

function PlayerTeamSection({
  side,
  match,
  players,
  catalog,
  path,
  onEditRecord,
  onReplaced,
}: {
  side: "A" | "B";
  match: MatchDetail;
  players: MatchPlayer[];
  catalog: Roster["players"];
  path: string;
  onEditRecord: (record: EditableRecord) => void;
  onReplaced: (updated: MatchDetail, oldName: string, newName: string) => void;
}) {
  return (
    <fieldset className="new-match-team">
      <legend>
        <span className={`swatch team-${side.toLowerCase()}`} aria-hidden="true" /> Team {side}
      </legend>
      {players.map((player, index) => (
        <PlayerSlot
          key={`${player.id}:${player.name}:${player.handedness}:${player.gender ?? ""}`}
          label={`Player ${index + 1}`}
          player={player}
          match={match}
          catalog={catalog}
          path={path}
          onEditRecord={onEditRecord}
          onReplaced={onReplaced}
        />
      ))}
    </fieldset>
  );
}

function PlayerSlot({
  label,
  player,
  match,
  catalog,
  path,
  onEditRecord,
  onReplaced,
}: {
  label: string;
  player: MatchPlayer;
  match: MatchDetail;
  catalog: Roster["players"];
  path: string;
  onEditRecord: (record: EditableRecord) => void;
  onReplaced: (updated: MatchDetail, oldName: string, newName: string) => void;
}) {
  const [name, setName] = useState(player.name);
  const [handedness, setHandedness] = useState<Handedness | "">(player.handedness);
  const [gender, setGender] = useState<Gender | "">(player.gender ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);

  const replace = useMutation({
    mutationFn: (body: ReplacePlayerIn) => replaceMatchPlayer(match.id, body, { rallyLog: path }),
    onSuccess: (updated) => {
      setValidationError(null);
      onReplaced(updated, player.name, name.trim());
    },
  });

  const trimmed = name.trim();
  const known = catalog.find((item) => item.name === trimmed);
  const changed = trimmed !== player.name;
  const effectiveHandedness = known?.handedness ?? handedness;
  const effectiveGender: Gender | "" = known ? (known.gender ?? "") : gender;

  function changeName(nextName: string) {
    setName(nextName);
    setValidationError(null);
    replace.reset();
    const matched = catalog.find((item) => item.name === nextName.trim());
    if (matched) {
      setHandedness(matched.handedness);
      setGender(matched.gender ?? "");
    } else if (known) {
      setHandedness("");
      setGender("");
    }
  }

  function handleReplace() {
    if (replace.isPending || !changed) return;
    replace.reset();
    const candidateGender: Gender | null = known ? known.gender : effectiveGender || null;
    const teamAGenders = match.players
      .filter((item) => item.team === "a")
      .map((item) => (item.id === player.id ? candidateGender : item.gender));
    const teamBGenders = match.players
      .filter((item) => item.team === "b")
      .map((item) => (item.id === player.id ? candidateGender : item.gender));
    const lineup =
      teamAGenders.length === 2 && teamBGenders.length === 2
        ? deriveMatchDiscipline(
            [teamAGenders[0]!, teamAGenders[1]!],
            [teamBGenders[0]!, teamBGenders[1]!],
          )
        : { discipline: null, error: null };

    let error: string | null = null;
    if (!trimmed) error = "Enter a Player name.";
    else if (
      match.players.some(
        (other) => other.id !== player.id && (other.name === trimmed || other.id === known?.id),
      )
    ) {
      error = "A Player can't appear twice in a Match.";
    } else if (!known && !effectiveHandedness) {
      error = "Choose handedness for the new Player.";
    } else if (!known && !effectiveGender) {
      error = "Choose gender for the new Player.";
    } else if (lineup.error) {
      error = lineup.error;
    }
    setValidationError(error);
    if (error) return;
    if (!known && (!effectiveHandedness || !effectiveGender)) return;

    replace.mutate({
      from: player.id,
      to: known
        ? known.id
        : {
            name: trimmed,
            handedness: effectiveHandedness as Handedness,
            gender: effectiveGender as Gender,
          },
    });
  }

  const error = validationError ?? replace.error?.message;
  const badgePlayer = changed ? (known ?? null) : player;

  return (
    <div className="edit-player-slot">
      <div className="new-match-player-meta">
        {badgePlayer && (
          <span className="pill player-meta-badge">{playerMetaBadge(badgePlayer)}</span>
        )}
        {changed && trimmed !== "" && !known && (
          <span className="pill pill-active player-new-pill">NEW</span>
        )}
      </div>
      <div className="new-match-player">
        <div className="edit-field-with-action">
          <NameField
            label={label}
            name={name}
            choices={catalog}
            choiceLabel={(item) => `${item.name} · ${playerMetaBadge(item)}`}
            onChange={changeName}
            onPick={({ name: picked }) => changeName(picked)}
          />
          <button
            type="button"
            className="edit-rename-button"
            aria-label={`Rename Player ${player.name}`}
            title={`Rename or edit handedness and gender of "${player.name}" across all Matches`}
            onClick={() =>
              onEditRecord({
                kind: "player",
                id: player.id,
                name: player.name,
                handedness: player.handedness,
                gender: player.gender,
              })
            }
          >
            Rename
          </button>
        </div>
        <label className="new-match-field">
          Handedness
          <select
            aria-label={`${label} handedness`}
            value={effectiveHandedness}
            disabled={known !== undefined || replace.isPending}
            onChange={(event) => {
              setHandedness(event.target.value as Handedness | "");
              setValidationError(null);
            }}
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
            value={effectiveGender}
            disabled={known !== undefined || replace.isPending}
            onChange={(event) => {
              setGender(event.target.value as Gender | "");
              setValidationError(null);
            }}
            required
          >
            <option value="">Choose</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </label>
      </div>
      {changed && (
        <div className="edit-player-actions">
          <button
            type="button"
            className="button primary"
            disabled={replace.isPending}
            onClick={handleReplace}
          >
            {replace.isPending ? "Replacing…" : `Replace ${player.name}`}
          </button>
          <button
            type="button"
            className="button"
            disabled={replace.isPending}
            onClick={() => {
              setName(player.name);
              setHandedness(player.handedness);
              setGender(player.gender ?? "");
              setValidationError(null);
              replace.reset();
            }}
          >
            Reset
          </button>
        </div>
      )}
      {error && (
        <p className="new-match-error edit-slot-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
