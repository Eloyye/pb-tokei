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
import { type EditableRecord, EditRecordDialog } from "./EditRecordDialog";
import { isValidMatchDate } from "./matchDate";
import { NameField } from "./NameField";
import { EMPTY_PLAYER_SLOT, PlayerField, type PlayerSlotState } from "./PlayerField";
import {
  checkNewPlayerDraft,
  normalizeName,
  type OtherSlotUsage,
  type RosterPlayerOption,
  type StagedNewPlayer,
} from "./playerMatching";
import { teamsLabel } from "./teams";

type Tour = CreateMatchIn["tour"];
type PlayerChoice = CreateMatchIn["team_a"][number];
type FourSlots = [PlayerSlotState, PlayerSlotState, PlayerSlotState, PlayerSlotState];
type FourNotices = [string | null, string | null, string | null, string | null];
type PlayerRecord = Extract<EditableRecord, { kind: "player" }>;

const TOURS: Tour[] = ["ppa", "app", "mlp"];
const EMPTY_SLOTS: FourSlots = [
  EMPTY_PLAYER_SLOT,
  EMPTY_PLAYER_SLOT,
  EMPTY_PLAYER_SLOT,
  EMPTY_PLAYER_SLOT,
];
const EMPTY_NOTICES: FourNotices = [null, null, null, null];

function slotTeamLabel(index: number): "Team A" | "Team B" {
  return index < 2 ? "Team A" : "Team B";
}

function otherSlotsFor(slots: FourSlots, selfIndex: number): OtherSlotUsage {
  const existingIds = new Map<string, string>();
  const stagedNew: StagedNewPlayer[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (i === selfIndex) continue;
    const slot = slots[i]!;
    const label = slotTeamLabel(i);
    if (slot.kind === "existing") {
      existingIds.set(slot.id, label);
    } else if (slot.kind === "new") {
      const trimmed = slot.name.trim();
      if (trimmed) {
        stagedNew.push({
          name: trimmed,
          normalizedName: normalizeName(trimmed),
          handedness: slot.handedness,
          slotLabel: label,
        });
      }
    }
  }
  return { existingIds, stagedNew };
}

function resetNearMatchConfirmations(slots: FourSlots): FourSlots {
  return slots.map((slot) =>
    slot.kind === "new" ? { ...slot, confirmedNearMatch: false } : slot,
  ) as FourSlots;
}

function slotToPayload(slot: PlayerSlotState): PlayerChoice | null {
  if (slot.kind === "existing") return slot.id;
  if (slot.kind === "new" && slot.name.trim() && slot.handedness) {
    return { name: slot.name.trim(), handedness: slot.handedness };
  }
  return null;
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

  return (
    <NewMatchForm key={path} roster={roster.data} rosterFetching={roster.isFetching} path={path} />
  );
}

function NewMatchForm({
  roster,
  rosterFetching,
  path,
}: {
  roster: Roster;
  rosterFetching: boolean;
  path: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tournamentName, setTournamentName] = useState("");
  const [tourChoice, setTourChoice] = useState<Tour | "">("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<FourSlots>(EMPTY_SLOTS);
  const [slotNotices, setSlotNotices] = useState<FourNotices>(EMPTY_NOTICES);
  const [franchiseA, setFranchiseA] = useState("");
  const [franchiseB, setFranchiseB] = useState("");
  const [meetingChoice, setMeetingChoice] = useState<string | null>(null);
  const [footage, setFootage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [editingTarget, setEditingTarget] = useState<{
    slotIndex: number;
    record: PlayerRecord;
  } | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateMatchIn) => createMatch(body, path),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["matches"], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["roster", path], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["players"] });
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (error) => {
      // A meeting or a Player may have changed since this form opened.
      if (error instanceof ApiError && error.status === 422) {
        setSlots((current) => resetNearMatchConfirmations(current));
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

  function updateSlot(index: number, next: PlayerSlotState) {
    setSlots((current) => {
      const copy: FourSlots = [...current];
      copy[index] = next;
      return copy;
    });
    setSlotNotices((current) => {
      if (current[index] === null) return current;
      const copy: FourNotices = [...current];
      copy[index] = null;
      return copy;
    });
  }

  function openEditPlayer(slotIndex: number, player: RosterPlayerOption) {
    setEditingTarget({
      slotIndex,
      record: {
        kind: "player",
        id: player.id,
        name: player.name,
        handedness: player.handedness,
      },
    });
  }

  function handlePlayerSaved(
    target: { slotIndex: number; record: PlayerRecord },
    message: string,
    savedId: string,
    savedName: string,
  ) {
    setEditingTarget(null);
    setStatusMessage(message);

    if (savedId !== target.record.id) {
      const conflictIndex = slots.findIndex(
        (slot, index) =>
          index !== target.slotIndex && slot.kind === "existing" && slot.id === savedId,
      );
      if (conflictIndex >= 0) {
        const mergedName =
          savedName ||
          roster.players.find((player) => player.id === savedId)?.name ||
          "that Player";
        setSlots((current) => {
          const copy: FourSlots = [...current];
          copy[target.slotIndex] = EMPTY_PLAYER_SLOT;
          return copy;
        });
        setSlotNotices((current) => {
          const copy: FourNotices = [...current];
          copy[target.slotIndex] =
            `Merged into ${mergedName}, who is already in ${slotTeamLabel(conflictIndex)}. Choose another Player.`;
          return copy;
        });
      } else {
        updateSlot(target.slotIndex, { kind: "existing", id: savedId });
      }
    }

    void queryClient.invalidateQueries({ queryKey: ["roster", path], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["matches"], exact: true });
    void queryClient.invalidateQueries({ queryKey: ["players"] });
    void queryClient.invalidateQueries({ queryKey: ["teams"] });
  }

  function validateSlots(): string | null {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const others = otherSlotsFor(slots, i);
      if (slot.kind === "searching") {
        return slot.query.trim()
          ? "Pick an existing Player or choose + Create for each Player."
          : "Choose or create all four Players.";
      }
      if (slot.kind === "existing") {
        if (!roster.players.some((player) => player.id === slot.id)) {
          return "Clear any Player that is no longer in this Rally Log.";
        }
        if (others.existingIds.has(slot.id)) {
          return "A Player can't appear twice in a Match.";
        }
      } else {
        const check = checkNewPlayerDraft(slot.name, roster.players, others);
        if (check.kind === "empty") return "Enter a name for each new Player.";
        if (check.kind === "existing-collision") {
          return "Use the existing Player or choose a different name.";
        }
        if (check.kind === "staged-collision") {
          return "A Player can't appear twice in a Match.";
        }
        if (check.kind === "near-matches" && !slot.confirmedNearMatch) {
          return "Confirm Create anyway or use the existing Player.";
        }
        if (!slot.handedness) return "Choose handedness for each new Player.";
      }
    }
    return null;
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) return;
    create.reset();
    setSubmitted(true);

    let error: string | null = null;
    if (!tournamentText) error = "Enter a Tournament name.";
    else if (!tour) error = "Choose a Tour.";
    else if (!date) error = "Enter a Match date.";
    else if (!isValidMatchDate(date)) error = "Enter a valid Match date (YYYY-MM-DD).";
    else error = validateSlots();

    if (!error && tour === "mlp") {
      if (!franchiseAText || !franchiseBText) error = "Enter both Franchise names.";
      else if (franchiseAText === franchiseBText) error = "A Franchise can't play itself.";
      else if (meetings.length > 1 && !meetingId) error = "Choose a Franchise Match.";
    }

    const payloads = slots.map(slotToPayload);
    setValidationError(error);
    if (error || !tour || payloads.some((item) => item === null)) return;

    const [a1, a2, b1, b2] = payloads as [PlayerChoice, PlayerChoice, PlayerChoice, PlayerChoice];
    create.mutate(
      {
        date,
        tournament: tournamentText,
        tour,
        team_a: [a1, a2],
        team_b: [b1, b2],
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
        {statusMessage && <output className="edit-match-status">{statusMessage}</output>}
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
              <TeamFields
                side="A"
                slotOffset={0}
                slots={slots}
                slotNotices={slotNotices}
                players={roster.players}
                showValidation={submitted}
                rosterFetching={rosterFetching}
                disabled={create.isPending}
                onChangeSlot={updateSlot}
                onEditPlayer={openEditPlayer}
              />
              <TeamFields
                side="B"
                slotOffset={2}
                slots={slots}
                slotNotices={slotNotices}
                players={roster.players}
                showValidation={submitted}
                rosterFetching={rosterFetching}
                disabled={create.isPending}
                onChangeSlot={updateSlot}
                onEditPlayer={openEditPlayer}
              />
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

        {editingTarget && (
          <EditRecordDialog
            key={`player:${editingTarget.record.id}`}
            record={editingTarget.record}
            rallyLog={path}
            scope="global"
            onClose={() => setEditingTarget(null)}
            onSaved={(message, savedId, savedName) =>
              handlePlayerSaved(editingTarget, message, savedId, savedName)
            }
          />
        )}
      </div>
    </main>
  );
}

function TeamFields({
  side,
  slotOffset,
  slots,
  slotNotices,
  players,
  showValidation,
  rosterFetching,
  disabled,
  onChangeSlot,
  onEditPlayer,
}: {
  side: "A" | "B";
  slotOffset: 0 | 2;
  slots: FourSlots;
  slotNotices: FourNotices;
  players: Roster["players"];
  showValidation: boolean;
  rosterFetching: boolean;
  disabled: boolean;
  onChangeSlot: (index: number, next: PlayerSlotState) => void;
  onEditPlayer: (index: number, player: RosterPlayerOption) => void;
}) {
  return (
    <fieldset className="new-match-team">
      <legend>
        <span className={`swatch team-${side.toLowerCase()}`} aria-hidden="true" /> Team {side}
      </legend>
      {[0, 1].map((offset) => {
        const index = slotOffset + offset;
        return (
          <div className="new-match-player-slot" key={index}>
            <PlayerField
              label={`Player ${offset + 1}`}
              value={slots[index]!}
              players={players}
              otherSlots={otherSlotsFor(slots, index)}
              showValidation={showValidation}
              externalNotice={slotNotices[index]!}
              rosterFetching={rosterFetching}
              disabled={disabled}
              onChange={(next) => onChangeSlot(index, next)}
              onEditPlayer={(player) => onEditPlayer(index, player)}
            />
          </div>
        );
      })}
    </fieldset>
  );
}
