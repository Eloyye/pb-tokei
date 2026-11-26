import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { Challenge, Game, Rally, Ruling, Shot, WinnerSource } from "../api/client";
import {
  type AnnotateContext,
  type AnnotateEdit,
  CONTACT_KIND_LABELS,
  cycleContactZone,
  cycleSettled,
  ERROR_LABELS,
  RALLY_FIELDS,
  REFEREE_CALL_LABELS,
  type RallyDetails,
  type RallyField,
  type Selection,
  SHOT_CLASS_LABELS,
  SHOT_FIELDS,
  type ShotField,
  selectedEntry,
  selectedRally,
  setChallenge,
  setErrorPlayer,
  setHitter,
  setRallyDetails,
  switchHitterTeam,
  toggleFlag,
  ZONE_LABELS,
} from "../lib/annotate";
import {
  RALLY_PHASE_LABELS,
  rallyPhase,
  SHOT_TYPE_LABELS,
  shotType,
  TEAM_STATUS_LABELS,
  teamStatuses,
} from "../lib/derived";
import { formatTimecode } from "../lib/frames";
import type { RuleIssue } from "../lib/ruleChecks";
import { manualWinner } from "../lib/sideout";
import {
  type Fact,
  formatScore,
  isShot,
  observed,
  parseScore,
  playerName,
  type Roster,
  teamKey,
  teamPlayers,
  UNKNOWN,
  zoneForPoint,
} from "../lib/rallyLog";
import { Panel } from "./Panel";

export type InspectorTab = "shot" | "rally";
export type InspectorForm = "details" | "challenge" | null;

const WINNER_SOURCE_LABELS: Record<WinnerSource, string> = {
  challenge: "Challenge",
  referee_call: "Referee Call",
  scoreboard: "scoreboard",
  next_serve: "next Serve",
  play: "seen in play",
};

const CALL_PRESETS = ["Out", "In", "Kitchen fault", "Fault on serve"];

const CHECKLIST_KEY = "pb-tokei:soft-hard-checklist";

/** A fact shown by how we know it: Observed plain, Inferred italic with `inf`, Unknown dashed. */
export function FactValue<T>({ fact, format }: { fact: Fact<T>; format: (value: T) => ReactNode }) {
  return (
    <span className={`val cert-${fact.certainty}`}>
      {fact.value === null ? "Unknown" : format(fact.value)}
    </span>
  );
}

function Keys({ keys, lit = [] }: { keys: string[]; lit?: string[] }) {
  return (
    <span className="keys">
      {keys.map((k) => (
        <kbd key={k} className={lit.includes(k) ? "lit" : ""}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

function Row({
  label,
  cursor,
  onClick,
  children,
  keys,
  issues,
  readOnly = false,
}: {
  label: string;
  cursor: boolean;
  onClick?: () => void;
  children: ReactNode;
  keys?: ReactNode;
  issues?: readonly RuleIssue[];
  readOnly?: boolean;
}) {
  return (
    <div className={`insp-row ${cursor ? "cursor" : ""} ${readOnly ? "ro" : ""}`}>
      {readOnly ? (
        <span className="lbl">{label}</span>
      ) : (
        // The label's button covers the whole row (CSS), so clicking anywhere on it works.
        <button type="button" className="lbl" aria-pressed={cursor} onClick={onClick}>
          {label}
        </button>
      )}
      <span>{children}</span>
      {keys ?? <span />}
      {issues?.map((issue) => (
        <div key={issue.id} className={`badge ${issue.severity}`}>
          {issue.message}
        </div>
      ))}
    </div>
  );
}

/**
 * The Inspector: the selected Shot's facts (and Positions at contact, and a Derived preview) or
 * the selected Rally's, each row with its keys. The blue row is the field cursor `C` acts on.
 */
export function InspectorPanel({
  focused,
  tab,
  onTabChange,
  games,
  selection,
  roster,
  frame,
  cursor,
  onCursor,
  form,
  onOpenForm,
  onCloseForm,
  onEdit,
  onMoveContactHere,
  onSyncFromTracking,
  onDeleteRally,
  issues = [],
  onSelectIssue,
}: {
  focused: boolean;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  games: readonly Game[];
  selection: Selection;
  roster: Roster;
  frame: number;
  cursor: Record<InspectorTab, number>;
  onCursor: (tab: InspectorTab, index: number) => void;
  form: InspectorForm;
  onOpenForm: (form: Exclude<InspectorForm, null>) => void;
  onCloseForm: () => void;
  onEdit: (edit: (ctx: AnnotateContext) => AnnotateEdit) => void;
  onMoveContactHere: () => void;
  onSyncFromTracking: () => void;
  onDeleteRally: () => void;
  issues?: readonly RuleIssue[];
  onSelectIssue?: (issue: RuleIssue) => void;
}) {
  const rally = selectedRally(games, selection);
  const entry = selectedEntry(games, selection);
  const rallyIssues =
    selection.rally === null
      ? []
      : issues.filter(
          (i) =>
            i.gameIndex === selection.game &&
            i.rallyIndex === selection.rally &&
            i.entryIndex === null,
        );
  const rallyShotIssues =
    selection.rally === null
      ? []
      : issues.filter(
          (i) =>
            i.gameIndex === selection.game &&
            i.rallyIndex === selection.rally &&
            i.entryIndex !== null,
        );
  const currentShotIssues =
    selection.rally === null || selection.entry === null
      ? []
      : rallyShotIssues.filter((i) => i.entryIndex === selection.entry);
  return (
    <Panel
      id="inspector"
      focused={focused}
      tabs={
        <div role="tablist" aria-label="Inspector" style={{ display: "flex" }}>
          {(["shot", "rally"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`panel-tab ${tab === t ? "active" : ""}`}
              onClick={() => onTabChange(t)}
            >
              {t === "shot" ? "Shot" : "Rally"}
            </button>
          ))}
        </div>
      }
    >
      <div className="insp-body" role="tabpanel">
        {tab === "shot" ? (
          !rally ? (
            <p className="empty">
              <strong>No Rally selected.</strong> Press <kbd>⇧I</kbd> at a Serve to start one, then{" "}
              <kbd>M</kbd> at each contact to add Shots.
            </p>
          ) : entry === undefined ? (
            <p className="empty">
              <strong>No Shot selected.</strong> Press <kbd>M</kbd> at a contact to add one, or{" "}
              <kbd>↑</kbd>/<kbd>↓</kbd> to move between Shots.
            </p>
          ) : entry.type === "gap" ? (
            <div className="insp-title">
              <div className="t">Observation Gap ({entry.missing})</div>
              <div className="s">
                An {entry.missing} number of Shots happened unseen. <kbd>G</kbd>/<kbd>⇧G</kbd> flip
                or remove it, <kbd>⌫</kbd> deletes it.
              </div>
            </div>
          ) : (
            <ShotTab
              shot={entry}
              rally={rally}
              index={selection.entry!}
              roster={roster}
              frame={frame}
              cursor={cursor.shot}
              onCursor={(i) => onCursor("shot", i)}
              onEdit={onEdit}
              onMoveContactHere={onMoveContactHere}
              onSyncFromTracking={onSyncFromTracking}
              issues={currentShotIssues}
            />
          )
        ) : !rally ? (
          <p className="empty">
            <strong>No Rally selected.</strong> Press <kbd>⇧I</kbd> to start one at the playhead, or{" "}
            <kbd>⇧U</kbd> to add an Unseen Rally.
          </p>
        ) : (
          <RallyTab
            rally={rally}
            gameNumber={games[selection.game]?.number ?? 1}
            roster={roster}
            cursor={cursor.rally}
            onCursor={(i) => onCursor("rally", i)}
            form={form}
            onOpenForm={onOpenForm}
            onCloseForm={onCloseForm}
            onEdit={onEdit}
            onDeleteRally={onDeleteRally}
            issues={rallyIssues}
            shotIssues={rallyShotIssues}
            onSelectIssue={onSelectIssue}
          />
        )}
      </div>
    </Panel>
  );
}

function playerLabel(roster: Roster, id: string): ReactNode {
  const team = teamKey(roster, roster.players.find((p) => p.id === id)?.team_id ?? null);
  return (
    <>
      {team && <span className={`swatch team-${team}`} />}
      {playerName(roster, id)}
    </>
  );
}

function teamLabel(roster: Roster, id: string): ReactNode {
  const team = teamKey(roster, id);
  const names = teamPlayers(roster, id).map((p) => p.name.split(" ").at(-1));
  return (
    <>
      {team && <span className={`swatch team-${team}`} />}
      {names.join(" / ")}
    </>
  );
}

function ShotTab({
  shot,
  rally,
  index,
  roster,
  frame,
  cursor,
  onCursor,
  onEdit,
  onMoveContactHere,
  onSyncFromTracking,
  issues,
}: {
  shot: Shot;
  rally: Rally;
  index: number;
  roster: Roster;
  frame: number;
  cursor: number;
  onCursor: (index: number) => void;
  onEdit: (edit: (ctx: AnnotateContext) => AnnotateEdit) => void;
  onMoveContactHere: () => void;
  onSyncFromTracking: () => void;
  issues: readonly RuleIssue[];
}) {
  const [checklistOpen, setChecklistOpen] = useState(() => {
    try {
      return localStorage.getItem(CHECKLIST_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const contact = shot.contact_frame.value;
  const number = shot.shot_number.value;
  const at = shotFieldIndex;
  const issuesFor = (field: ShotField) => issues.filter((i) => i.field === field);
  const row = (field: ShotField) => ({
    cursor: cursor === at(field),
    issues: issuesFor(field),
  });
  const click = (field: ShotField, edit?: (ctx: AnnotateContext) => AnnotateEdit) => () => {
    onCursor(at(field));
    if (edit) onEdit(edit);
  };
  const shotClass = shot.shot_class.value;
  const kind = shot.contact_kind.value;
  const errorKind = shot.error?.kind.value ?? null;
  const errorKeys: Record<string, string> = {
    net: "1",
    out: "2",
    kitchen_fault: "3",
    double_hit: "4",
    body_hit: "5",
  };
  const statuses = teamStatuses(roster, rally).get(index);
  const type = shotType(roster, rally, index);
  const phase = rallyPhase(roster, rally, index);
  return (
    <>
      <div className="insp-title">
        <div className="t">
          {number === null ? "Shot ?" : `Shot ${number}`}
          {number === null && (
            <span className="dimmed" style={{ fontWeight: 400, fontSize: 11 }}>
              number unknown after an Observation Gap
            </span>
          )}
        </div>
        <div className="s">
          {contact === null ? "contact Unknown" : `frame ${contact} · ${formatTimecode(contact)}`}
          {contact !== null && contact !== frame && (
            <>
              <span className="insp-offset" title="The playhead isn't on this Shot's contact">
                {frame > contact ? "+" : "−"}
                {Math.abs(frame - contact)} f
              </span>
              <button type="button" className="button" onClick={onMoveContactHere}>
                Move contact here
              </button>
            </>
          )}
        </div>
      </div>
      <div className="sect">Recorded</div>
      <Row
        label="Hitter"
        {...row("hitter_id")}
        onClick={click("hitter_id", switchHitterTeam)}
        keys={<Keys keys={["X", "⇧H"]} />}
      >
        <FactValue fact={shot.hitter_id} format={(id) => playerLabel(roster, id)} />
      </Row>
      <Row
        label="Shot Class"
        {...row("shot_class")}
        onClick={click("shot_class")}
        keys={
          <Keys
            keys={["S", "H", "L", "O"]}
            lit={
              shotClass === null
                ? []
                : [{ soft: "S", hard: "H", lob: "L", overhead: "O" }[shotClass]]
            }
          />
        }
      >
        <FactValue fact={shot.shot_class} format={(v) => SHOT_CLASS_LABELS[v]} />
      </Row>
      <details
        className="checklist"
        open={checklistOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setChecklistOpen(open);
          try {
            localStorage.setItem(CHECKLIST_KEY, open ? "open" : "closed");
          } catch {
            // Remembering is a convenience only.
          }
        }}
      >
        <summary>Soft or Hard?</summary>
        <div>
          <b>Soft:</b> descending as it crosses the net and landing (or, for a Volley, would land)
          in the opponent's Frontcourt.
        </div>
        <div>
          <b>Hard:</b> anything else that isn't a Lob or Overhead.
        </div>
      </details>
      <Row
        label="Contact Kind"
        {...row("contact_kind")}
        onClick={click("contact_kind")}
        keys={<Keys keys={["V", "B"]} lit={kind === null ? [] : [kind === "volley" ? "V" : "B"]} />}
      >
        <FactValue fact={shot.contact_kind} format={(v) => CONTACT_KIND_LABELS[v]} />
      </Row>
      <Row
        label="Contact Zone"
        {...row("contact_zone")}
        onClick={click("contact_zone", cycleContactZone)}
        keys={
          <span className="keys">
            <span className="hint">from hitter · click</span>
          </span>
        }
      >
        <FactValue fact={shot.contact_zone} format={(v) => ZONE_LABELS[v]} />
      </Row>
      <Row
        label="Erne"
        {...row("erne")}
        onClick={click("erne", (c) => toggleFlag(c, "erne"))}
        keys={<Keys keys={["E"]} lit={shot.erne.value ? ["E"] : []} />}
      >
        <FactValue fact={shot.erne} format={(v) => (v ? "Yes" : "No")} />
      </Row>
      <Row
        label="ATP"
        {...row("atp")}
        onClick={click("atp", (c) => toggleFlag(c, "atp"))}
        keys={<Keys keys={["T"]} lit={shot.atp.value ? ["T"] : []} />}
      >
        <FactValue fact={shot.atp} format={(v) => (v ? "Yes" : "No")} />
      </Row>
      <Row
        label="Landing"
        {...row("landing")}
        onClick={click("landing")}
        keys={
          <span className="keys">
            <span className="hint">click court</span>
          </span>
        }
      >
        <FactValue fact={shot.landing} format={(p) => `${p.x.toFixed(1)}, ${p.y.toFixed(1)} ft`} />
      </Row>
      <Row
        label="Error"
        {...row("error")}
        onClick={click("error")}
        keys={
          <Keys
            keys={["1", "2", "3", "4", "5", "0"]}
            lit={errorKind === null ? [] : [errorKeys[errorKind]!]}
          />
        }
      >
        {shot.error ? (
          <span style={{ display: "inline-flex", gap: 4, alignItems: "center", minWidth: 0 }}>
            <FactValue fact={shot.error.kind} format={(v) => ERROR_LABELS[v]} />
            <select
              aria-label="Error's Player"
              value={shot.error.player_id.value ?? ""}
              className={`val cert-${shot.error.player_id.certainty}`}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                const id = event.target.value;
                if (id) onEdit((c) => setErrorPlayer(c, id));
              }}
            >
              <option value="">Unknown</option>
              {roster.players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </span>
        ) : (
          <span className="val cert-observed">None</span>
        )}
      </Row>
      <div className="sect">
        Positions at contact
        <button
          type="button"
          title="Re-pull positions and Settled from Player Tracking (⌘Z undoes)"
          onClick={onSyncFromTracking}
        >
          Sync from tracking
        </button>
      </div>
      <div className="insp-positions">
        {roster.players.map((p) => {
          const pos = shot.positions[p.id] ?? { position: UNKNOWN, settled: UNKNOWN };
          const point = pos.position.value;
          const settled = pos.settled;
          return (
            <div key={p.id} className="insp-position">
              <span className={`swatch team-${p.team}`} />
              <button
                type="button"
                className="name"
                title="Make this Player the hitter"
                onClick={() => onEdit((c) => setHitter(c, p.id))}
                style={{ fontWeight: shot.hitter_id.value === p.id ? 600 : 400 }}
              >
                {p.name}
              </button>
              <FactValue
                fact={pos.position}
                format={() =>
                  point &&
                  `${point.x.toFixed(1)}, ${Math.abs(point.y).toFixed(1)} ft · ${ZONE_LABELS[zoneForPoint(point)]}`
                }
              />
              <button
                type="button"
                className={`settled-badge cert-${settled.certainty}`}
                title="Settled: in the Frontcourt and no longer moving toward the net (click to change)"
                onClick={() => onEdit((c) => cycleSettled(c, p.id))}
              >
                {settled.value === null ? "Unknown" : settled.value ? "Settled" : "Moving"}
              </button>
            </div>
          );
        })}
      </div>
      <div className="sect">Derived</div>
      <Row label="Shot Type" cursor={false} readOnly>
        <span className="val derived">{type === null ? "—" : SHOT_TYPE_LABELS[type]}</span>
      </Row>
      <Row label="Rally Phase" cursor={false} readOnly>
        <span className="val derived">{phase === null ? "—" : RALLY_PHASE_LABELS[phase]}</span>
      </Row>
      {[roster.teamA, roster.teamB].map((team) => (
        <Row key={team} label="Team Status" cursor={false} readOnly>
          <span className="val derived">
            {teamLabel(roster, team)}: {TEAM_STATUS_LABELS[statuses?.[team] ?? "unknown"]}
          </span>
        </Row>
      ))}
      <div className="derived-label">Derived · computed, never stored</div>
    </>
  );
}

function RallyTab({
  rally,
  gameNumber,
  roster,
  cursor,
  onCursor,
  form,
  onOpenForm,
  onCloseForm,
  onEdit,
  onDeleteRally,
  issues,
  shotIssues,
  onSelectIssue,
}: {
  rally: Rally;
  gameNumber: number;
  roster: Roster;
  cursor: number;
  onCursor: (index: number) => void;
  form: InspectorForm;
  onOpenForm: (form: Exclude<InspectorForm, null>) => void;
  onCloseForm: () => void;
  onEdit: (edit: (ctx: AnnotateContext) => AnnotateEdit) => void;
  onDeleteRally: () => void;
  issues: readonly RuleIssue[];
  shotIssues: readonly RuleIssue[];
  onSelectIssue?: (issue: RuleIssue) => void;
}) {
  const at = rallyFieldIndex;
  const issuesFor = (field: RallyField) => issues.filter((i) => i.field === field);
  const row = (field: RallyField) => ({
    cursor: cursor === at(field),
    issues: issuesFor(field),
    onClick: () => {
      onCursor(at(field));
      if (
        ["score", "serving_team_id", "server_id", "returner_id", "scoreboard_winner_id"].includes(
          field,
        )
      ) {
        onOpenForm("details");
      } else if (field === "challenge") onOpenForm("challenge");
    },
  });
  const call = rally.referee_call.value;
  const winnerId = rally.winner_id.value;
  const winner = winnerId !== null && (
    <>
      {teamLabel(roster, winnerId)}
      {rally.winner_source && (
        <span className="dimmed"> · {WINNER_SOURCE_LABELS[rally.winner_source]}</span>
      )}
    </>
  );
  const shots = rally.entries.filter((e) => e.type === "shot").length;
  const frames =
    rally.start_frame === null ? "Unseen" : `${rally.start_frame}–${rally.end_frame ?? "open"}`;
  return (
    <>
      <div className="insp-title">
        <div className="t">
          Game {gameNumber} · Rally {rally.number}
          <button
            type="button"
            className="button"
            style={{ marginLeft: "auto" }}
            title="Delete this Rally (⇧⌫)"
            onClick={onDeleteRally}
          >
            Delete
          </button>
        </div>
        <div className="s">
          {frames}
          {rally.start_frame !== null && ` · ${formatTimecode(rally.start_frame)}`} · {shots}{" "}
          {shots === 1 ? "Shot" : "Shots"}
        </div>
      </div>
      <Row label="Frames" {...row("frames")} keys={<Keys keys={["⇧I", "⇧O"]} />}>
        <span className={`val ${rally.start_frame === null ? "cert-unknown" : "cert-observed"}`}>
          {frames}
        </span>
      </Row>
      <Row label="Score called" {...row("score")} keys={<Keys keys={["⇧S"]} />}>
        <FactValue fact={rally.score} format={() => formatScore(rally.score)} />
      </Row>
      <Row label="Serving Team" {...row("serving_team_id")} keys={<Keys keys={["⇧S"]} />}>
        <FactValue fact={rally.serving_team_id} format={(id) => teamLabel(roster, id)} />
      </Row>
      <Row label="Server" {...row("server_id")} keys={<Keys keys={["⇧S"]} />}>
        <FactValue fact={rally.server_id} format={(id) => playerLabel(roster, id)} />
      </Row>
      <Row label="Returner" {...row("returner_id")} keys={<Keys keys={["⇧S"]} />}>
        <FactValue fact={rally.returner_id} format={(id) => playerLabel(roster, id)} />
      </Row>
      {form === "details" && (
        <DetailsForm
          rally={rally}
          roster={roster}
          onCancel={onCloseForm}
          onSave={(details) => {
            onEdit((c) => setRallyDetails(c, details));
            onCloseForm();
          }}
        />
      )}
      <Row
        label="Referee Call"
        {...row("referee_call")}
        keys={
          <Keys
            keys={["⇧P", "⇧2", "⇧X"]}
            lit={call === null ? [] : [{ point: "⇧P", second_server: "⇧2", side_out: "⇧X" }[call]]}
          />
        }
      >
        <FactValue fact={rally.referee_call} format={(v) => REFEREE_CALL_LABELS[v]} />
      </Row>
      <Row label="Challenge" {...row("challenge")} keys={<Keys keys={["⇧C"]} />}>
        {rally.challenge ? (
          <span className="val cert-observed">
            {playerName(roster, rally.challenge.challenger_id.value)} ·{" "}
            {rally.challenge.original_call.value ?? "call Unknown"} ·{" "}
            {rally.challenge.ruling.value ?? "ruling Unknown"}
          </span>
        ) : (
          <span className="val cert-observed">None</span>
        )}
      </Row>
      {form === "challenge" && (
        <ChallengeForm
          challenge={rally.challenge}
          roster={roster}
          onCancel={onCloseForm}
          onSave={(challenge) => {
            onEdit((c) => setChallenge(c, challenge));
            onCloseForm();
          }}
        />
      )}
      <Row label="Winner" {...row("winner_id")}>
        <FactValue fact={rally.winner_id} format={() => winner} />
      </Row>
      <Row label="Scoreboard" {...row("scoreboard_winner_id")} keys={<Keys keys={["⇧S"]} />}>
        <FactValue fact={rally.scoreboard_winner_id} format={(id) => teamLabel(roster, id)} />
      </Row>
      <Row
        label="Status"
        {...row("status")}
        keys={<Keys keys={["Enter"]} lit={rally.status === "done" ? ["Enter"] : []} />}
      >
        <span className="val cert-observed">
          {{ empty: "○ Empty", in_progress: "● In progress", done: "✓ Done" }[rally.status]}
        </span>
      </Row>
      {shotIssues.length > 0 && (
        <>
          <div className="sect">Shot issues in this Rally</div>
          <div className="rally-shot-issues">
            {shotIssues.map((issue) => {
              const entry = issue.entryIndex === null ? undefined : rally.entries[issue.entryIndex];
              const num = isShot(entry) ? entry.shot_number.value : null;
              return (
                <button
                  key={issue.id}
                  type="button"
                  className={`badge ${issue.severity} clickable`}
                  onClick={() => onSelectIssue?.(issue)}
                >
                  Shot {num ?? "?"}: {issue.message}
                </button>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function shotFieldIndex(field: ShotField): number {
  return SHOT_FIELDS.indexOf(field);
}

function rallyFieldIndex(field: RallyField): number {
  return RALLY_FIELDS.indexOf(field);
}

/** Keeps the fact when its value didn't change, else Observed (or Unknown when cleared). */
function edited<T>(current: Fact<T>, next: T | null, same: (a: T, b: T) => boolean): Fact<T> {
  if (next === null) return current.value === null ? current : UNKNOWN;
  if (current.value !== null && same(current.value, next)) return current;
  return observed(next);
}

function eq<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function keepOrSet<T>(current: Fact<T> | undefined, next: T | null): Fact<T> {
  return edited(current ?? UNKNOWN, next, eq);
}

/** Enter saves, Esc cancels: global shortcuts stay off while a form field has focus. */
function useFormKeys(onSave: () => void, onCancel: () => void) {
  const ref = useRef<HTMLFormElement>(null);
  const latest = useRef({ onSave, onCancel });
  useEffect(() => {
    latest.current = { onSave, onCancel };
  });
  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    const listener = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onCancel();
      } else if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onSave();
      }
    };
    form.addEventListener("keydown", listener);
    return () => form.removeEventListener("keydown", listener);
  }, []);
  return ref;
}

function useAutofocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    element?.focus();
    // Typing replaces what was there, as in any inline editor.
    if (element instanceof HTMLInputElement) element.select();
  }, []);
  return ref;
}

function DetailsForm({
  rally,
  roster,
  onSave,
  onCancel,
}: {
  rally: Rally;
  roster: Roster;
  onSave: (details: RallyDetails) => void;
  onCancel: () => void;
}) {
  const first = useAutofocus<HTMLInputElement>();
  const [score, setScore] = useState(rally.score.value === null ? "" : formatScore(rally.score));
  const [serving, setServing] = useState(rally.serving_team_id.value ?? "");
  const [server, setServer] = useState(rally.server_id.value ?? "");
  const [returner, setReturner] = useState(rally.returner_id.value ?? "");
  const [scoreboard, setScoreboard] = useState(rally.scoreboard_winner_id.value ?? "");
  const manualNow = manualWinner(rally) ?? "";
  const [manual, setManual] = useState(manualNow);
  const parsed = score.trim() === "" ? null : parseScore(score);
  const invalid = score.trim() !== "" && parsed === null;
  const save = () => {
    if (invalid) return;
    onSave({
      score: edited(rally.score, parsed, eq),
      serving_team_id: edited(rally.serving_team_id, serving || null, eq),
      server_id: edited(rally.server_id, server || null, eq),
      returner_id: edited(rally.returner_id, returner || null, eq),
      scoreboard_winner_id: edited(rally.scoreboard_winner_id, scoreboard || null, eq),
      manual_winner: manual || null,
    });
  };
  const teams = [roster.teamA, roster.teamB];
  const teamOptions = teams.map((t) => (
    <option key={t} value={t}>
      {teamPlayers(roster, t)
        .map((p) => p.name)
        .join(" / ")}
    </option>
  ));
  const playerOptions = roster.players.map((p) => (
    <option key={p.id} value={p.id}>
      {p.name}
    </option>
  ));
  const formRef = useFormKeys(save, onCancel);
  return (
    <form
      className="insp-form"
      aria-label="Rally details"
      ref={formRef}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save();
      }}
    >
      <label>
        Score called
        <input
          ref={first}
          value={score}
          placeholder="s-r-n, e.g. 4-2-1"
          aria-invalid={invalid}
          onChange={(event) => setScore(event.target.value)}
        />
      </label>
      <label>
        Serving Team
        <select value={serving} onChange={(event) => setServing(event.target.value)}>
          <option value="">Unknown</option>
          {teamOptions}
        </select>
      </label>
      <label>
        Server
        <select value={server} onChange={(event) => setServer(event.target.value)}>
          <option value="">Unknown</option>
          {playerOptions}
        </select>
      </label>
      <label>
        Returner
        <select value={returner} onChange={(event) => setReturner(event.target.value)}>
          <option value="">Unknown</option>
          {playerOptions}
        </select>
      </label>
      <label>
        Scoreboard
        <select value={scoreboard} onChange={(event) => setScoreboard(event.target.value)}>
          <option value="">Unknown</option>
          {teamOptions}
        </select>
      </label>
      <label>
        Winner in play
        <select value={manual} onChange={(event) => setManual(event.target.value)}>
          <option value="">None</option>
          {teamOptions}
        </select>
      </label>
      <div className="btns">
        <button type="button" className="button" onClick={onCancel}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button type="submit" className="button primary" disabled={invalid}>
          Save <kbd>Enter</kbd>
        </button>
      </div>
    </form>
  );
}

function ChallengeForm({
  challenge,
  roster,
  onSave,
  onCancel,
}: {
  challenge: Challenge | null;
  roster: Roster;
  onSave: (challenge: Challenge | null) => void;
  onCancel: () => void;
}) {
  const first = useAutofocus<HTMLSelectElement>();
  const [challenger, setChallenger] = useState(challenge?.challenger_id.value ?? "");
  const currentCall = challenge?.original_call.value ?? "";
  const [preset, setPreset] = useState(
    currentCall === "" ? "" : CALL_PRESETS.includes(currentCall) ? currentCall : "other",
  );
  const [custom, setCustom] = useState(CALL_PRESETS.includes(currentCall) ? "" : currentCall);
  const [ruling, setRuling] = useState<Ruling | "">(challenge?.ruling.value ?? "");
  const save = () => {
    const call = preset === "other" ? custom.trim() : preset;
    onSave({
      challenger_id: keepOrSet(challenge?.challenger_id, challenger || null),
      original_call: keepOrSet(challenge?.original_call, call || null),
      ruling: keepOrSet(challenge?.ruling, ruling || null),
    });
  };
  const formRef = useFormKeys(save, onCancel);
  return (
    <form
      className="insp-form"
      aria-label="Challenge"
      ref={formRef}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save();
      }}
    >
      <label>
        Challenger
        <select
          ref={first}
          value={challenger}
          onChange={(event) => setChallenger(event.target.value)}
        >
          <option value="">Unknown</option>
          {roster.players.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Original call
        <select value={preset} onChange={(event) => setPreset(event.target.value)}>
          <option value="">Unknown</option>
          {CALL_PRESETS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="other">Other…</option>
        </select>
      </label>
      {preset === "other" && (
        <label>
          Call
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder="What was called"
          />
        </label>
      )}
      <label>
        Ruling
        <select value={ruling} onChange={(event) => setRuling(event.target.value as Ruling | "")}>
          <option value="">Unknown</option>
          <option value="upheld">Upheld</option>
          <option value="overturned">Overturned</option>
        </select>
      </label>
      <div className="btns">
        {challenge && (
          <button
            type="button"
            className="button"
            onClick={() => onSave(null)}
            style={{ marginRight: "auto" }}
          >
            Clear Challenge
          </button>
        )}
        <button type="button" className="button" onClick={onCancel}>
          Cancel <kbd>Esc</kbd>
        </button>
        <button type="submit" className="button primary">
          Save <kbd>Enter</kbd>
        </button>
      </div>
    </form>
  );
}
