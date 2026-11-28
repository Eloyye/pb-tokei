import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Handedness } from "../api/client";
import {
  buildPlayerDropdown,
  checkNewPlayerDraft,
  type DropdownOption,
  type OtherSlotUsage,
  type RosterPlayerOption,
} from "./playerMatching";

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The editable combobox manages its own listbox. */

export type PlayerSlotState =
  | { kind: "searching"; query: string }
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string; handedness: Handedness | ""; confirmedNearMatch: boolean };

export const EMPTY_PLAYER_SLOT: PlayerSlotState = { kind: "searching", query: "" };

function handTag(handedness: Handedness): "L" | "R" {
  return handedness === "left" ? "L" : "R";
}

function handTitle(handedness: Handedness): string {
  return handedness === "left" ? "Left-handed" : "Right-handed";
}

function optionKey(option: DropdownOption): string {
  if (option.kind === "existing") return option.player.id;
  if (option.kind === "staged-new") {
    return `staged:${option.staged.slotLabel}:${option.staged.normalizedName}`;
  }
  return "__create__";
}

/**
 * Reusable explicit Player picker supporting three discriminated states:
 * - Searching: editable combobox filtering existing Players (with fuzzy matches & cross-slot status).
 * - Existing: compact read-only chip with L/R tag, Edit action, and Clear button.
 * - New: inline draft with editable name, live collision/near-match guards, required Left | Right
 *   handedness starting blank, and Clear button.
 */
export function PlayerField({
  label,
  value,
  players,
  otherSlots,
  showValidation = false,
  externalNotice = null,
  rosterFetching = false,
  disabled = false,
  onChange,
  onEditPlayer,
}: {
  label: string;
  value: PlayerSlotState;
  players: readonly RosterPlayerOption[];
  otherSlots: OtherSlotUsage;
  showValidation?: boolean;
  externalNotice?: string | null;
  rosterFetching?: boolean;
  disabled?: boolean;
  onChange: (next: PlayerSlotState) => void;
  onEditPlayer?: (player: RosterPlayerOption) => void;
}) {
  const id = useId();
  const statusId = `${id}-status`;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const leftHandRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<"search" | "handedness" | null>(null);

  useEffect(() => {
    if (value.kind === "searching" && pendingFocusRef.current === "search") {
      pendingFocusRef.current = null;
      searchInputRef.current?.focus();
    } else if (value.kind === "new" && pendingFocusRef.current === "handedness") {
      pendingFocusRef.current = null;
      leftHandRef.current?.focus();
    }
  }, [value.kind]);

  function selectExisting(playerId: string) {
    onChange({ kind: "existing", id: playerId });
  }

  function startNewDraft(name: string) {
    pendingFocusRef.current = "handedness";
    onChange({ kind: "new", name, handedness: "", confirmedNearMatch: false });
  }

  function clearToSearch() {
    pendingFocusRef.current = "search";
    onChange(EMPTY_PLAYER_SLOT);
  }

  if (value.kind === "existing") {
    return (
      <ExistingPlayerSlot
        label={label}
        statusId={statusId}
        selected={players.find((player) => player.id === value.id)}
        rosterFetching={rosterFetching}
        disabled={disabled}
        onClear={clearToSearch}
        onEditPlayer={onEditPlayer}
      />
    );
  }

  if (value.kind === "new") {
    return (
      <NewPlayerSlot
        id={id}
        statusId={statusId}
        label={label}
        value={value}
        players={players}
        otherSlots={otherSlots}
        showValidation={showValidation}
        disabled={disabled}
        leftHandRef={leftHandRef}
        onChange={onChange}
        onSelectExisting={selectExisting}
        onClear={clearToSearch}
      />
    );
  }

  return (
    <SearchingPlayerSlot
      id={id}
      statusId={statusId}
      label={label}
      query={value.query}
      players={players}
      otherSlots={otherSlots}
      showValidation={showValidation}
      externalNotice={externalNotice}
      disabled={disabled}
      searchInputRef={searchInputRef}
      onQueryChange={(query) => onChange({ kind: "searching", query })}
      onSelectExisting={selectExisting}
      onStartNew={startNewDraft}
    />
  );
}

function ExistingPlayerSlot({
  label,
  statusId,
  selected,
  rosterFetching,
  disabled,
  onClear,
  onEditPlayer,
}: {
  label: string;
  statusId: string;
  selected: RosterPlayerOption | undefined;
  rosterFetching: boolean;
  disabled: boolean;
  onClear: () => void;
  onEditPlayer?: (player: RosterPlayerOption) => void;
}) {
  if (!selected) {
    if (rosterFetching) {
      return (
        <div className="new-match-field player-field">
          <span className="player-field-label">{label}</span>
          <div className="player-selected">
            <span className="player-selected-name">Updating Player…</span>
          </div>
        </div>
      );
    }
    return (
      <div className="new-match-field player-field">
        <span className="player-field-label">{label}</span>
        <div className="player-selected player-selected-missing">
          <span className="player-selected-missing-text">
            Player no longer exists in this Rally Log
          </span>
          <div className="player-selected-actions">
            <button
              type="button"
              className="player-icon-button"
              aria-label={`Clear ${label}`}
              title="Clear selection"
              disabled={disabled}
              onClick={onClear}
            >
              ×
            </button>
          </div>
        </div>
        <p className="player-field-error" id={statusId}>
          This Player was merged or deleted. Clear this slot and choose another Player.
        </p>
      </div>
    );
  }

  return (
    <div className="new-match-field player-field">
      <span className="player-field-label">{label}</span>
      <div className="player-selected">
        <span className="player-selected-name">{selected.name}</span>
        <span
          className="player-hand-tag"
          title={handTitle(selected.handedness)}
          aria-label={handTitle(selected.handedness)}
        >
          {handTag(selected.handedness)}
        </span>
        <div className="player-selected-actions">
          {onEditPlayer && (
            <button
              type="button"
              className="player-icon-button"
              aria-label={`Edit Player ${selected.name}`}
              title={`Edit or merge "${selected.name}" across all Matches`}
              disabled={disabled}
              onClick={() => onEditPlayer(selected)}
            >
              ✎
            </button>
          )}
          <button
            type="button"
            className="player-icon-button"
            aria-label={`Clear ${label}`}
            title="Clear selection"
            disabled={disabled}
            onClick={onClear}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

function NewPlayerSlot({
  id,
  statusId,
  label,
  value,
  players,
  otherSlots,
  showValidation,
  disabled,
  leftHandRef,
  onChange,
  onSelectExisting,
  onClear,
}: {
  id: string;
  statusId: string;
  label: string;
  value: Extract<PlayerSlotState, { kind: "new" }>;
  players: readonly RosterPlayerOption[];
  otherSlots: OtherSlotUsage;
  showValidation: boolean;
  disabled: boolean;
  leftHandRef: RefObject<HTMLButtonElement | null>;
  onChange: (next: PlayerSlotState) => void;
  onSelectExisting: (playerId: string) => void;
  onClear: () => void;
}) {
  const rightHandRef = useRef<HTMLButtonElement>(null);
  const check = useMemo(
    () => checkNewPlayerDraft(value.name, players, otherSlots),
    [value.name, players, otherSlots],
  );

  let validationMessage: string | null = null;
  if (showValidation) {
    if (check.kind === "empty") {
      validationMessage = "Enter a name for the new Player.";
    } else if (check.kind === "near-matches" && !value.confirmedNearMatch) {
      validationMessage = "Confirm Create anyway or use the existing Player.";
    } else if (
      check.kind !== "existing-collision" &&
      check.kind !== "staged-collision" &&
      !value.handedness
    ) {
      validationMessage = "Choose handedness (Left or Right).";
    }
  }

  const hasInlineError =
    check.kind === "existing-collision" ||
    check.kind === "staged-collision" ||
    validationMessage !== null;

  function handleHandKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      rightHandRef.current?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      leftHandRef.current?.focus();
    }
  }

  return (
    <div className="new-match-field player-field player-field-new">
      <div className="player-new-header">
        <div className="player-new-title">
          <label htmlFor={id}>{label}</label>
          <span className="player-new-badge">New</span>
        </div>
        <button
          type="button"
          className="player-icon-button"
          aria-label={`Clear ${label}`}
          title="Back to search"
          disabled={disabled}
          onClick={onClear}
        >
          ×
        </button>
      </div>

      <div className="player-new-controls">
        <input
          id={id}
          value={value.name}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={hasInlineError || undefined}
          aria-describedby={
            check.kind !== "ok" && check.kind !== "empty"
              ? statusId
              : validationMessage
                ? statusId
                : undefined
          }
          onChange={(event) =>
            onChange({
              ...value,
              name: event.target.value,
              confirmedNearMatch: false,
            })
          }
          required
        />
        <div className="player-hand-toggle" role="group" aria-label={`${label} handedness`}>
          <button
            ref={leftHandRef}
            type="button"
            aria-pressed={value.handedness === "left"}
            disabled={disabled}
            onKeyDown={handleHandKey}
            onClick={() => onChange({ ...value, handedness: "left" })}
          >
            Left
          </button>
          <button
            ref={rightHandRef}
            type="button"
            aria-pressed={value.handedness === "right"}
            disabled={disabled}
            onKeyDown={handleHandKey}
            onClick={() => onChange({ ...value, handedness: "right" })}
          >
            Right
          </button>
        </div>
      </div>

      {check.kind === "existing-collision" && (
        <div className="player-collision" id={statusId}>
          <span>
            Player "{check.player.name}" already exists
            {check.usedInSlot ? ` (already in ${check.usedInSlot}).` : "."}
          </span>
          {!check.usedInSlot && (
            <button
              type="button"
              className="player-inline-action"
              disabled={disabled}
              onClick={() => onSelectExisting(check.player.id)}
            >
              Use {check.player.name} ({handTag(check.player.handedness)})
            </button>
          )}
        </div>
      )}

      {check.kind === "staged-collision" && (
        <p className="player-field-error" id={statusId}>
          "{check.name}" is already staged as a new Player in {check.usedInSlot}.
        </p>
      )}

      {check.kind === "near-matches" && (
        <div className="player-near-match" id={statusId} role="status">
          <p className="player-near-match-title">
            Similar to existing {check.matches.length === 1 ? "Player" : "Players"}:
          </p>
          <div className="player-near-match-list">
            {check.matches.map(({ player: candidate, usedInSlot }) =>
              usedInSlot ? (
                <span key={candidate.id} className="player-near-match-used">
                  {candidate.name} ({handTag(candidate.handedness)}) — already in {usedInSlot}
                </span>
              ) : (
                <button
                  key={candidate.id}
                  type="button"
                  className="player-inline-action"
                  disabled={disabled}
                  onClick={() => onSelectExisting(candidate.id)}
                >
                  Use {candidate.name} ({handTag(candidate.handedness)})
                </button>
              ),
            )}
          </div>
          <label className="player-create-anyway">
            <input
              type="checkbox"
              checked={value.confirmedNearMatch}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, confirmedNearMatch: event.target.checked })}
            />
            Create anyway
          </label>
        </div>
      )}

      {validationMessage && (
        <p
          className="player-field-error"
          id={check.kind === "ok" || check.kind === "empty" ? statusId : undefined}
        >
          {validationMessage}
        </p>
      )}
    </div>
  );
}

function SearchingPlayerSlot({
  id,
  statusId,
  label,
  query,
  players,
  otherSlots,
  showValidation,
  externalNotice,
  disabled,
  searchInputRef,
  onQueryChange,
  onSelectExisting,
  onStartNew,
}: {
  id: string;
  statusId: string;
  label: string;
  query: string;
  players: readonly RosterPlayerOption[];
  otherSlots: OtherSlotUsage;
  showValidation: boolean;
  externalNotice: string | null;
  disabled: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onQueryChange: (query: string) => void;
  onSelectExisting: (playerId: string) => void;
  onStartNew: (name: string) => void;
}) {
  const listId = `${id}-options`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const trimmed = query.trim();
  const { options, hasPlayerMatches, canCreate } = useMemo(
    () => buildPlayerDropdown(query, players, otherSlots),
    [query, players, otherSlots],
  );
  const visible = open && options.length > 0 && !disabled;
  const effectiveActive =
    active >= 0 && active < options.length && !options[active]?.disabled ? active : -1;
  const selectableIndices = options
    .map((option, index) => (option.disabled ? -1 : index))
    .filter((index) => index >= 0);

  function activateOption(option: DropdownOption) {
    if (option.disabled) return;
    setOpen(false);
    setActive(-1);
    if (option.kind === "existing") {
      onSelectExisting(option.player.id);
    } else if (option.kind === "create") {
      onStartNew(option.name);
    }
  }

  function handleSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || disabled) return;

    if (event.key === "Escape" && visible) {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
      return;
    }

    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      if (selectableIndices.length === 0) return;
      const pos = selectableIndices.indexOf(effectiveActive);
      if (event.key === "ArrowDown") {
        setActive(selectableIndices[(pos + 1) % selectableIndices.length]!);
      } else {
        setActive(selectableIndices[pos <= 0 ? selectableIndices.length - 1 : pos - 1]!);
      }
      return;
    }

    if (event.key === "Enter") {
      const highlighted = effectiveActive >= 0 ? options[effectiveActive] : undefined;
      if (visible && highlighted && !highlighted.disabled) {
        event.preventDefault();
        activateOption(highlighted);
        return;
      }
      if (!hasPlayerMatches && canCreate) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
        onStartNew(trimmed);
        return;
      }
      if (visible && hasPlayerMatches) {
        // Never auto-create on bare Enter when any existing or fuzzy match is shown.
        event.preventDefault();
      }
    }
  }

  const searchError = showValidation
    ? trimmed
      ? "Pick an existing Player or choose + Create."
      : "Choose an existing Player or create a new one."
    : null;

  return (
    <div className="new-match-field player-field">
      <label htmlFor={id}>{label}</label>
      <div className="name-field">
        <input
          ref={searchInputRef}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={
            visible && effectiveActive >= 0 ? `${listId}-${effectiveActive}` : undefined
          }
          aria-invalid={searchError ? true : undefined}
          aria-describedby={externalNotice || searchError ? statusId : undefined}
          value={query}
          placeholder="Search or create Player…"
          disabled={disabled}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onKeyDown={handleSearchKey}
          autoComplete="off"
          spellCheck={false}
          required
        />
        {visible && (
          <div
            className="name-options player-options"
            id={listId}
            role="listbox"
            aria-label={label}
          >
            {options.map((option, index) => {
              const key = optionKey(option);
              const optionId = `${listId}-${index}`;
              if (option.kind === "existing") {
                return (
                  <button
                    type="button"
                    key={key}
                    id={optionId}
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === effectiveActive}
                    aria-disabled={option.disabled || undefined}
                    disabled={option.disabled}
                    className={`player-option${option.disabled ? " is-disabled" : ""}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => activateOption(option)}
                  >
                    <span className="player-option-main">
                      <span className="player-option-name">{option.player.name}</span>
                      <span className="player-hand-tag">{handTag(option.player.handedness)}</span>
                    </span>
                    {option.disabledReason && (
                      <span className="player-option-meta">Already in {option.disabledReason}</span>
                    )}
                  </button>
                );
              }
              if (option.kind === "staged-new") {
                return (
                  <button
                    type="button"
                    key={key}
                    id={optionId}
                    role="option"
                    tabIndex={-1}
                    aria-selected={false}
                    aria-disabled="true"
                    disabled
                    className="player-option is-disabled"
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <span className="player-option-main">
                      <span className="player-option-name">{option.staged.name}</span>
                      <span className="player-new-badge">New</span>
                    </span>
                    <span className="player-option-meta">Already in {option.disabledReason}</span>
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  key={key}
                  id={optionId}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === effectiveActive}
                  className="player-option player-option-create"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => activateOption(option)}
                >
                  + Create new Player "{option.name}"
                </button>
              );
            })}
          </div>
        )}
      </div>
      {externalNotice && (
        <p className="player-field-notice" id={statusId}>
          {externalNotice}
        </p>
      )}
      {searchError && (
        <p className="player-field-error" id={externalNotice ? undefined : statusId}>
          {searchError}
        </p>
      )}
    </div>
  );
}
