import type {
  Challenge,
  ContactKind,
  CourtPoint,
  ErrorKind,
  Game,
  Parity,
  Rally,
  RallyEntry,
  RefereeCall,
  Score,
  Shot,
  ShotClass,
  ShotPosition,
  Zone,
} from "../api/client";
import {
  contactZoneFor,
  type Fact,
  FRONTCOURT_MAX_Y_FT,
  firstPlayer,
  formatScore,
  inferred,
  isFramed,
  isGap,
  isShot,
  known,
  newRally,
  newShot,
  observed,
  otherTeam,
  partnerOf,
  playerName,
  renumberGames,
  renumberRallies,
  type Roster,
  shotsOf,
  sortEntries,
  teamOf,
  teamPlayers,
  UNKNOWN,
  withAllPositions,
} from "./rallyLog";
import { manualWinner, normalizeGame } from "./sideout";

/**
 * Rally and Shot entry in the Annotate workspace (#12): every key's edit to the Match's Games as
 * a pure function, so each one is one undo step (docs/annotation-ui.md, "Keymap").
 */

/** What the operator is working on: a Game, a Rally in it, and a Shot or Observation Gap. */
export interface Selection {
  /** Index into the Games: the active Game. */
  game: number;
  /** Index into the active Game's Rallies. */
  rally: number | null;
  /** Index into the selected Rally's entries. */
  entry: number | null;
}

export const NO_SELECTION: Selection = { game: 0, rally: null, entry: null };

export interface AnnotateContext {
  games: Game[];
  selection: Selection;
  roster: Roster;
  /** The playhead. */
  frame: number;
}

export interface AnnotateEdit {
  games: Game[];
  selection: Selection;
  message: string;
}

/** The Rally under the selection, if there is one. */
export function selectedRally(games: readonly Game[], selection: Selection): Rally | undefined {
  if (selection.rally === null) return undefined;
  return games[selection.game]?.rallies[selection.rally];
}

export function selectedEntry(
  games: readonly Game[],
  selection: Selection,
): RallyEntry | undefined {
  if (selection.entry === null) return undefined;
  return selectedRally(games, selection)?.entries[selection.entry];
}

export function selectedShot(games: readonly Game[], selection: Selection): Shot | undefined {
  const entry = selectedEntry(games, selection);
  return isShot(entry) ? entry : undefined;
}

/** A valid selection for these Games: indices clamped, entries dropped when gone. */
export function clampSelection(games: readonly Game[], selection: Selection): Selection {
  if (games.length === 0) return NO_SELECTION;
  const game = Math.min(Math.max(0, selection.game), games.length - 1);
  const rallies = games[game]!.rallies;
  const rally =
    selection.rally === null || rallies.length === 0
      ? null
      : Math.min(selection.rally, rallies.length - 1);
  const entries = rally === null ? [] : rallies[rally]!.entries;
  const entry =
    rally === null || selection.entry === null || selection.entry >= entries.length
      ? null
      : selection.entry;
  return { game, rally, entry };
}

/** Selects a Rally and its first Shot (if any). */
export function selectRally(games: readonly Game[], game: number, rally: number): Selection {
  const entries = games[game]?.rallies[rally]?.entries ?? [];
  const first = entries.findIndex(isShot);
  return { game, rally, entry: first < 0 ? null : first };
}

function unchanged(ctx: AnnotateContext, message: string): AnnotateEdit {
  return { games: ctx.games, selection: ctx.selection, message };
}

function rallyLabel(game: Game, rally: Rally): string {
  return `G${game.number} R${rally.number}`;
}

/** Replaces one Game, normalising it (Shot numbers, winners, cascade after `fromIndex`). */
function withGame(
  ctx: AnnotateContext,
  gameIndex: number,
  rallies: Rally[],
  fromIndex: number,
): Game[] {
  const games = [...ctx.games];
  games[gameIndex] = normalizeGame(
    { ...games[gameIndex]!, rallies: renumberRallies(rallies) },
    ctx.roster,
    fromIndex,
  );
  return games;
}

/** An edit to the selected Rally: its first edit makes it In progress; later Rallies cascade. */
function editRally(
  ctx: AnnotateContext,
  change: (rally: Rally) => Rally | string,
  selection?: (rally: Rally) => Selection,
): AnnotateEdit {
  const { selection: sel } = ctx;
  const rally = selectedRally(ctx.games, sel);
  if (!rally || sel.rally === null)
    return unchanged(ctx, "Select a Rally first (Shift+I starts one)");
  const changed = change(rally);
  if (typeof changed === "string") return unchanged(ctx, changed);
  const next: Rally = {
    ...changed,
    status: changed.status === "empty" ? "in_progress" : changed.status,
  };
  const rallies = [...ctx.games[sel.game]!.rallies];
  rallies[sel.rally] = next;
  const games = withGame(ctx, sel.game, rallies, sel.rally);
  return {
    games,
    selection: selection ? selection(next) : sel,
    message: "",
  };
}

/** An edit to the selected Shot. */
function editShot(
  ctx: AnnotateContext,
  change: (shot: Shot, rally: Rally) => Shot | string,
  message: (shot: Shot) => string,
): AnnotateEdit {
  const entry = ctx.selection.entry;
  const shot = selectedShot(ctx.games, ctx.selection);
  if (!shot || entry === null) return unchanged(ctx, "Select a Shot first (M adds one)");
  let after: Shot | undefined;
  const edit = editRally(ctx, (rally) => {
    const changed = change(shot, rally);
    if (typeof changed === "string") return changed;
    after = changed;
    const entries = [...rally.entries];
    entries[entry] = changed;
    return { ...rally, entries };
  });
  if (!after) return edit;
  const saved = selectedShot(edit.games, edit.selection) ?? after;
  return { ...edit, message: message(saved) };
}

// --- Games and Rallies --------------------------------------------------------------------

function ensureGame(ctx: AnnotateContext): AnnotateContext {
  if (ctx.games.length > 0) return { ...ctx, selection: clampSelection(ctx.games, ctx.selection) };
  return { ...ctx, games: [{ number: 1, rallies: [] }], selection: NO_SELECTION };
}

/** Whether `frame` is inside a framed Rally (other than `except`); its index if so. */
function rallyContaining(rallies: readonly Rally[], frame: number, except: number | null): number {
  return rallies.findIndex(
    (r, i) =>
      i !== except &&
      r.start_frame !== null &&
      r.end_frame !== null &&
      r.start_frame <= frame &&
      frame <= r.end_frame,
  );
}

/** Moves the Rally at `index` among the framed Rallies by start frame; returns its new index. */
function placeChronologically(rallies: Rally[], index: number): number {
  const [rally] = rallies.splice(index, 1);
  const start = rally!.start_frame ?? 0;
  let at = rallies.findIndex((r) => r.start_frame !== null && r.start_frame > start);
  if (at < 0) at = rallies.length;
  rallies.splice(at, 0, rally!);
  return at;
}

function firstShotFrame(rally: Rally): number | null {
  return shotsOf(rally)[0]?.contact_frame.value ?? null;
}

function lastShotFrame(rally: Rally): number | null {
  return shotsOf(rally).at(-1)?.contact_frame.value ?? null;
}

/**
 * `Shift+I`: starts a new open-ended Rally at the playhead (when none is selected, or the
 * playhead is past the selected Rally's end), or moves the selected Rally's start here.
 */
export function markRallyStart(input: AnnotateContext): AnnotateEdit {
  const ctx = ensureGame(input);
  const { frame } = ctx;
  const gameIndex = ctx.selection.game;
  const game = ctx.games[gameIndex]!;
  const rallyIndex = ctx.selection.rally;
  const rally = selectedRally(ctx.games, ctx.selection);

  const moveStart =
    rally !== undefined &&
    (rally.start_frame === null ||
      (rally.end_frame !== null
        ? frame <= rally.end_frame
        : firstShotFrame(rally) === null || frame <= firstShotFrame(rally)!));
  if (rally && rallyIndex !== null && moveStart) {
    const inside = rallyContaining(game.rallies, frame, rallyIndex);
    if (inside >= 0) {
      return unchanged(ctx, `Frame ${frame} is inside ${rallyLabel(game, game.rallies[inside]!)}`);
    }
    const first = firstShotFrame(rally);
    if (first !== null && frame > first) {
      return unchanged(ctx, `A Rally must start at or before its first Shot (frame ${first})`);
    }
    const rallies = [...game.rallies];
    rallies[rallyIndex] = {
      ...rally,
      start_frame: frame,
      status: rally.status === "empty" ? "in_progress" : rally.status,
    };
    const at = placeChronologically(rallies, rallyIndex);
    const games = withGame(ctx, gameIndex, rallies, Math.min(at, rallyIndex) - 1);
    return {
      games,
      selection: { ...ctx.selection, rally: at },
      message: `${rallyLabel(game, rally)} starts at frame ${frame}`,
    };
  }
  if (rally && rally.end_frame === null) {
    return unchanged(ctx, "Close this Rally with Shift+O before starting the next");
  }
  const inside = rallyContaining(game.rallies, frame, null);
  if (inside >= 0) {
    return {
      ...unchanged(ctx, `The playhead is inside ${rallyLabel(game, game.rallies[inside]!)}`),
      selection: selectRally(ctx.games, gameIndex, inside),
    };
  }
  const rallies = [...game.rallies];
  let at = rallies.findIndex((r) => r.start_frame !== null && r.start_frame > frame);
  if (at < 0) at = rallies.length;
  rallies.splice(at, 0, newRally(at + 1, frame));
  const games = withGame(ctx, gameIndex, rallies, at - 1);
  const created = games[gameIndex]!.rallies[at]!;
  return {
    games,
    selection: { game: gameIndex, rally: at, entry: null },
    message: `${rallyLabel(games[gameIndex]!, created)} started at frame ${frame} (score ${formatScore(created.score)}); M adds Shots, Shift+O ends it`,
  };
}

/** `Shift+O`: ends the selected Rally at the playhead. */
export function markRallyEnd(ctx: AnnotateContext): AnnotateEdit {
  const { frame, selection } = ctx;
  const rally = selectedRally(ctx.games, selection);
  if (!rally || selection.rally === null) return unchanged(ctx, "Start a Rally with Shift+I first");
  if (rally.start_frame === null) {
    return unchanged(ctx, "Frame this Unseen Rally's start with Shift+I first");
  }
  if (frame < rally.start_frame) {
    return unchanged(ctx, `A Rally can't end before it starts (frame ${rally.start_frame})`);
  }
  const game = ctx.games[selection.game]!;
  const inside = rallyContaining(game.rallies, frame, selection.rally);
  const overlapping = game.rallies.findIndex(
    (r, i) =>
      i !== selection.rally &&
      r.start_frame !== null &&
      r.start_frame > rally.start_frame! &&
      r.start_frame <= frame,
  );
  if (inside >= 0 || overlapping >= 0) {
    const other = game.rallies[inside >= 0 ? inside : overlapping]!;
    return unchanged(ctx, `Rallies can't overlap: ${rallyLabel(game, other)} is in the way`);
  }
  const last = lastShotFrame(rally);
  const edit = editRally(ctx, (r) => ({ ...r, end_frame: frame }));
  const label = rallyLabel(game, rally);
  return {
    ...edit,
    message:
      last !== null && frame < last
        ? `${label} now ends at frame ${frame}, before its last Shot (frame ${last})`
        : `${label}: frames ${rally.start_frame}–${frame}`,
  };
}

/** `Shift+U`: inserts an Unseen Rally after the selected one (or at the end of the Game). */
export function insertUnseenRally(input: AnnotateContext): AnnotateEdit {
  const ctx = ensureGame(input);
  const gameIndex = ctx.selection.game;
  const game = ctx.games[gameIndex]!;
  const at = ctx.selection.rally === null ? game.rallies.length : ctx.selection.rally + 1;
  const rallies = [...game.rallies];
  rallies.splice(at, 0, newRally(at + 1));
  const games = withGame(ctx, gameIndex, rallies, at - 1);
  return {
    games,
    selection: { game: gameIndex, rally: at, entry: null },
    message: `Unseen ${rallyLabel(games[gameIndex]!, games[gameIndex]!.rallies[at]!)} inserted`,
  };
}

/** `Shift+Enter`: starts Game N + 1 and makes it the active Game. */
export function startNextGame(ctx: AnnotateContext): AnnotateEdit {
  const number = ctx.games.length + 1;
  return {
    games: [...ctx.games, { number, rallies: [] }],
    selection: { game: ctx.games.length, rally: null, entry: null },
    message: `Game ${number} started: Shift+I starts its Rally 1 at 0-0-2`,
  };
}

/** Deletes an empty Game (Games are renumbered). */
export function deleteGame(ctx: AnnotateContext, gameIndex: number): AnnotateEdit {
  const game = ctx.games[gameIndex];
  if (!game) return unchanged(ctx, "No such Game");
  if (game.rallies.length > 0) return unchanged(ctx, `Game ${game.number} still has Rallies`);
  const games = renumberGames(ctx.games.filter((_, i) => i !== gameIndex));
  return {
    games,
    selection: clampSelection(games, {
      game: Math.max(0, ctx.selection.game - (ctx.selection.game >= gameIndex ? 1 : 0)),
      rally: null,
      entry: null,
    }),
    message: `Game ${game.number} deleted`,
  };
}

/** `Shift+Backspace`: deletes the selected Rally. */
export function deleteRally(ctx: AnnotateContext): AnnotateEdit {
  const { selection } = ctx;
  const rally = selectedRally(ctx.games, selection);
  if (!rally || selection.rally === null) return unchanged(ctx, "Select a Rally to delete");
  const game = ctx.games[selection.game]!;
  const rallies = game.rallies.filter((_, i) => i !== selection.rally);
  const games = withGame(ctx, selection.game, rallies, selection.rally - 1);
  const next = rallies.length === 0 ? null : Math.min(selection.rally, rallies.length - 1);
  return {
    games,
    selection:
      next === null
        ? { game: selection.game, rally: null, entry: null }
        : selectRally(games, selection.game, next),
    message: `${rallyLabel(game, rally)} deleted (⌘Z to undo)`,
  };
}

/** `Enter`: marks the selected Rally Done and moves to the next one. */
export function markRallyDone(ctx: AnnotateContext): AnnotateEdit {
  const { selection } = ctx;
  const rally = selectedRally(ctx.games, selection);
  if (!rally || selection.rally === null) return unchanged(ctx, "Select a Rally first");
  const rallies = [...ctx.games[selection.game]!.rallies];
  rallies[selection.rally] = { ...rally, status: "done" };
  const games = [...ctx.games];
  games[selection.game] = { ...games[selection.game]!, rallies };
  const label = rallyLabel(games[selection.game]!, rally);
  const next = nextRallySelection(games, selection, 1);
  if (next) {
    return { games, selection: next, message: `${label} Done` };
  }
  return {
    games,
    selection,
    message: `${label} Done. Space plays on to find the next Rally; Shift+I starts it`,
  };
}

/** The Rally `direction` steps from the selected one, across Games; undefined at either end. */
export function nextRallySelection(
  games: readonly Game[],
  selection: Selection,
  direction: 1 | -1,
): Selection | undefined {
  const flat: [number, number][] = games.flatMap((g, gi) =>
    g.rallies.map((_, ri) => [gi, ri] as [number, number]),
  );
  if (flat.length === 0) return undefined;
  const current = flat.findIndex(([gi, ri]) => gi === selection.game && ri === selection.rally);
  const target =
    current < 0
      ? direction === 1
        ? flat.findIndex(([gi]) => gi >= selection.game)
        : flat.length - 1
      : current + direction;
  const found = flat[target];
  return found ? selectRally(games, found[0], found[1]) : undefined;
}

/** The Shot `direction` steps from the selected entry in the selected Rally. */
export function nextShotSelection(
  games: readonly Game[],
  selection: Selection,
  direction: 1 | -1,
): Selection | undefined {
  const rally = selectedRally(games, selection);
  if (!rally) return undefined;
  const shots = rally.entries.flatMap((e, i) => (isShot(e) ? [i] : []));
  if (shots.length === 0) return undefined;
  const current = selection.entry;
  const target =
    current === null
      ? direction === 1
        ? shots[0]
        : shots.at(-1)
      : direction === 1
        ? shots.find((i) => i > current)
        : shots.findLast((i) => i < current);
  return target === undefined ? undefined : { ...selection, entry: target };
}

/** `Shift+P` / `Shift+2` / `Shift+X`: records the Referee Call (again clears it). */
export function setRefereeCall(ctx: AnnotateContext, call: RefereeCall): AnnotateEdit {
  const rally = selectedRally(ctx.games, ctx.selection);
  const clearing =
    rally?.referee_call.value === call && rally.referee_call.certainty === "observed";
  const edit = editRally(ctx, (r) => ({ ...r, referee_call: clearing ? UNKNOWN : observed(call) }));
  if (!edit.message)
    edit.message = clearing ? "Referee Call cleared" : `Referee Call: ${REFEREE_CALL_LABELS[call]}`;
  return edit;
}

/** The Rally details form (`Shift+S`): the facts as the operator left them. */
export interface RallyDetails {
  score: Fact<Score>;
  serving_team_id: Fact<string>;
  server_id: Fact<string>;
  returner_id: Fact<string>;
  scoreboard_winner_id: Fact<string>;
  /** A winner seen in play with no Error or Referee Call; null for none. */
  manual_winner: string | null;
}

export function setRallyDetails(ctx: AnnotateContext, details: RallyDetails): AnnotateEdit {
  const edit = editRally(ctx, (r) => {
    const enteredByHand = manualWinner(r) !== null;
    return {
      ...r,
      score: details.score,
      serving_team_id: details.serving_team_id,
      server_id: details.server_id,
      returner_id: details.returner_id,
      scoreboard_winner_id: details.scoreboard_winner_id,
      ...(details.manual_winner !== null
        ? { winner_id: observed(details.manual_winner), winner_source: "play" as const }
        : enteredByHand
          ? { winner_id: UNKNOWN, winner_source: null }
          : {}),
    };
  });
  if (!edit.message) edit.message = "Rally details saved";
  return edit;
}

/** `Shift+C`: records the Challenge (null clears it). */
export function setChallenge(ctx: AnnotateContext, challenge: Challenge | null): AnnotateEdit {
  const edit = editRally(ctx, (r) => ({ ...r, challenge }));
  if (!edit.message) edit.message = challenge ? "Challenge recorded" : "Challenge cleared";
  return edit;
}

// --- Shots --------------------------------------------------------------------------------

/** The hitter a new Shot at `index` defaults to, and why. */
function defaultHitter(roster: Roster, rally: Rally, index: number): string | null {
  const entries = rally.entries;
  const before = entries.slice(0, index);
  const gapBefore = before.some(isGap);
  const shotsBefore = before.filter(isShot).length;
  const serving = rally.serving_team_id.value;
  if (!gapBefore && shotsBefore === 0) {
    return rally.server_id.value ?? firstPlayer(roster, serving ?? roster.teamA);
  }
  if (!gapBefore && shotsBefore === 1) {
    return (
      rally.returner_id.value ??
      firstPlayer(roster, serving === null ? roster.teamB : otherTeam(roster, serving))
    );
  }
  // Teams alternate: count the odd Observation Gaps since the last Shot with a known hitter.
  let oddGaps = 0;
  for (let i = index - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (isGap(entry)) {
      if (entry.missing === "odd") oddGaps += 1;
      continue;
    }
    const hitter = entry.hitter_id.value;
    const team = hitter === null ? null : teamOf(roster, hitter);
    if (team === null) return null;
    return firstPlayer(roster, oddGaps % 2 === 0 ? otherTeam(roster, team) : team);
  }
  // Only Observation Gaps before it: Shot 1 is the Serving Team's.
  const servingTeam = serving ?? roster.teamA;
  return firstPlayer(roster, oddGaps % 2 === 0 ? servingTeam : otherTeam(roster, servingTeam));
}

/**
 * `M`: adds a Shot at the playhead to the selected Rally, with the four Players' positions and
 * Settled facts snapshotted from Player Tracking (null leaves them Unknown).
 */
export function addShot(
  ctx: AnnotateContext,
  snapshot: Record<string, ShotPosition> | null,
): AnnotateEdit {
  const { frame, selection, roster } = ctx;
  const rally = selectedRally(ctx.games, selection);
  if (!rally || selection.rally === null) {
    return unchanged(ctx, "Start a Rally with Shift+I before adding Shots");
  }
  if (rally.start_frame !== null && frame < rally.start_frame) {
    return unchanged(ctx, `This Rally starts at frame ${rally.start_frame}`);
  }
  if (rally.end_frame !== null && frame > rally.end_frame) {
    return unchanged(ctx, `This Rally ends at frame ${rally.end_frame}; Shift+O moves its end`);
  }
  if (shotsOf(rally).some((s) => s.contact_frame.value === frame)) {
    return unchanged(ctx, `There is already a Shot at frame ${frame}`);
  }
  const shot: Shot = {
    ...newShot(frame),
    positions: withAllPositions(roster, snapshot ?? {}),
  };
  const entries = sortEntries([...rally.entries, shot]);
  const index = entries.indexOf(shot);
  const placed = { ...rally, entries };
  const hitter = defaultHitter(roster, placed, index);
  const before = entries.slice(0, index);
  const number = before.some(isGap) ? null : before.filter(isShot).length + 1;
  const filled: Shot = {
    ...shot,
    hitter_id: hitter === null ? UNKNOWN : inferred(hitter),
    // Two-bounce rule: the Return and the third Shot bounce.
    contact_kind: number === 2 || number === 3 ? inferred<ContactKind>("bounce") : UNKNOWN,
  };
  const withZone: Shot = { ...filled, contact_zone: contactZoneFor(filled) };
  entries[index] = withZone;
  const edit = editRally(
    ctx,
    (r) => ({ ...r, entries }),
    () => ({ ...selection, entry: index }),
  );
  const label = number === null ? "Shot ?" : `Shot ${number}`;
  edit.message = `${label} at frame ${frame}: hitter ${playerName(roster, hitter)} (inferred)${
    snapshot ? "" : "; positions Unknown until Players are tracked"
  }`;
  return edit;
}

export const REFEREE_CALL_LABELS: Record<RefereeCall, string> = {
  point: "Point",
  second_server: "Second server",
  side_out: "Side out",
};

export const SHOT_CLASS_LABELS: Record<ShotClass, string> = {
  soft: "Soft",
  hard: "Hard",
  lob: "Lob",
  overhead: "Overhead",
};

export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  volley: "Volley",
  bounce: "Bounce",
};

export const ERROR_LABELS: Record<ErrorKind, string> = {
  net: "Net",
  out: "Out",
  kitchen_fault: "Kitchen Fault",
  double_hit: "Double Hit",
  body_hit: "Body Hit",
};

export const ZONE_LABELS: Record<Zone, string> = {
  frontcourt: "Frontcourt",
  midcourt: "Midcourt",
  backcourt: "Backcourt",
};

export function setShotClass(ctx: AnnotateContext, value: ShotClass): AnnotateEdit {
  return editShot(
    ctx,
    (s) => ({ ...s, shot_class: observed(value) }),
    () => `Shot Class: ${SHOT_CLASS_LABELS[value]}`,
  );
}

export function setContactKind(ctx: AnnotateContext, value: ContactKind): AnnotateEdit {
  return editShot(
    ctx,
    (s) => ({ ...s, contact_kind: observed(value) }),
    () => `Contact Kind: ${CONTACT_KIND_LABELS[value]}`,
  );
}

export function toggleFlag(ctx: AnnotateContext, flag: "erne" | "atp"): AnnotateEdit {
  const label = flag === "erne" ? "Erne" : "ATP";
  return editShot(
    ctx,
    (s) => ({ ...s, [flag]: observed(!(s[flag].value ?? false)) }),
    (s) => `${label} ${s[flag].value ? "on" : "off"}`,
  );
}

/** Sets the hitter (Observed), keeping the Contact Zone and the hitter's own Error in step. */
function withHitter(shot: Shot, hitter: string): Shot {
  const previous = shot.hitter_id.value;
  const error =
    shot.error && shot.error.kind.value !== "body_hit" && shot.error.player_id.value === previous
      ? { ...shot.error, player_id: { ...shot.error.player_id, value: hitter } }
      : shot.error;
  const next = { ...shot, hitter_id: observed(hitter), error };
  return { ...next, contact_zone: syncedZone(next) };
}

/** The Contact Zone from the hitter's position, unless it was set by hand with no position. */
function syncedZone(shot: Shot): Fact<Zone> {
  const fromPosition = contactZoneFor(shot);
  if (known(fromPosition)) return fromPosition;
  return shot.contact_zone.certainty === "observed" ? shot.contact_zone : UNKNOWN;
}

/** `X`: the hitter's partner hit it instead. */
export function swapHitterToPartner(ctx: AnnotateContext): AnnotateEdit {
  return editShot(
    ctx,
    (s) => {
      const hitter = s.hitter_id.value;
      const partner = hitter === null ? null : partnerOf(ctx.roster, hitter);
      if (partner === null) return "Set the hitter first (Shift+H picks a Team)";
      return withHitter(s, partner);
    },
    (s) => `Hitter: ${playerName(ctx.roster, s.hitter_id.value)}`,
  );
}

/** `Shift+H`: the other Team hit it. */
export function switchHitterTeam(ctx: AnnotateContext): AnnotateEdit {
  return editShot(
    ctx,
    (s) => {
      const hitter = s.hitter_id.value;
      const team = hitter === null ? null : teamOf(ctx.roster, hitter);
      const target = team === null ? ctx.roster.teamA : otherTeam(ctx.roster, team);
      const player = firstPlayer(ctx.roster, target);
      return player === null ? "No Players in this Match" : withHitter(s, player);
    },
    (s) => `Hitter: ${playerName(ctx.roster, s.hitter_id.value)}`,
  );
}

/** Sets the hitter directly (clicking a Player in the Inspector). */
export function setHitter(ctx: AnnotateContext, playerId: string): AnnotateEdit {
  return editShot(
    ctx,
    (s) => withHitter(s, playerId),
    () => `Hitter: ${playerName(ctx.roster, playerId)}`,
  );
}

function distance(a: CourtPoint, b: CourtPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * `1`–`5`: the Shot's Error. The Error's Player defaults to the hitter, or for a Body Hit to the
 * opponent nearest the landing; pressing `5` or `3` again cycles the Player. `0` (null) clears.
 */
export function setError(ctx: AnnotateContext, kind: ErrorKind | null): AnnotateEdit {
  const { roster } = ctx;
  if (kind === null) {
    // A winner worked out from this Error is recomputed without it; one entered by hand stays.
    return editShot(
      ctx,
      (s) => ({ ...s, error: null }),
      () => "Error cleared",
    );
  }
  return editShot(
    ctx,
    (s) => {
      const hitter = s.hitter_id.value;
      const current = s.error;
      const repeat =
        current?.kind.value === kind && current.player_id.value !== null && hitter !== null;
      let player: Fact<string> = UNKNOWN;
      if (hitter !== null) {
        const team = teamOf(roster, hitter);
        const opponents = team === null ? [] : teamPlayers(roster, otherTeam(roster, team));
        if (kind === "body_hit") {
          if (repeat) {
            const other = opponents.find((p) => p.id !== current!.player_id.value);
            player = other ? observed(other.id) : current!.player_id;
          } else {
            const landing = s.landing.value;
            const nearest =
              landing === null
                ? undefined
                : opponents
                    .map((p) => ({ id: p.id, at: s.positions[p.id]?.position.value ?? null }))
                    .filter((p): p is { id: string; at: CourtPoint } => p.at !== null)
                    .toSorted((a, b) => distance(a.at, landing) - distance(b.at, landing))[0]?.id;
            const fallback = nearest ?? opponents[0]?.id;
            player = fallback === undefined ? UNKNOWN : inferred(fallback);
          }
        } else if (kind === "kitchen_fault" && repeat) {
          const other = current!.player_id.value === hitter ? partnerOf(roster, hitter) : hitter;
          player = other === null ? current!.player_id : observed(other);
        } else {
          player = inferred(hitter);
        }
      }
      return { ...s, error: { kind: observed(kind), player_id: player } };
    },
    (s) =>
      `Error: ${ERROR_LABELS[kind]} by ${playerName(roster, s.error?.player_id.value ?? null)}`,
  );
}

/** Sets the Error's Player directly (Inspector). */
export function setErrorPlayer(ctx: AnnotateContext, playerId: string): AnnotateEdit {
  return editShot(
    ctx,
    (s) =>
      s.error
        ? { ...s, error: { ...s.error, player_id: observed(playerId) } }
        : "No Error to change",
    () => `Error's Player: ${playerName(ctx.roster, playerId)}`,
  );
}

/**
 * `G` / `Shift+G`: an Observation Gap after the selected Shot (or a leading gap before any
 * Shot). The same key again removes it; the other key flips odd and even.
 */
export function toggleGap(ctx: AnnotateContext, parity: Parity): AnnotateEdit {
  const rally = selectedRally(ctx.games, ctx.selection);
  if (!rally) return unchanged(ctx, "Select a Rally first");
  const selected = ctx.selection.entry;
  const noShots = shotsOf(rally).length === 0;
  let at: number;
  if (isGap(selected === null ? undefined : rally.entries[selected])) at = selected!;
  else if (noShots) at = 0;
  else if (selected === null) return unchanged(ctx, "Select a Shot to put the gap after");
  else at = selected + 1;
  const existing = rally.entries[at];
  const entries = [...rally.entries];
  let message: string;
  let entry: number | null = ctx.selection.entry;
  if (isGap(existing)) {
    if (existing.missing === parity) {
      entries.splice(at, 1);
      message = `${parity === "odd" ? "Odd" : "Even"} gap removed`;
      if (entry === at) entry = at > 0 ? at - 1 : entries.length > 0 ? 0 : null;
    } else {
      entries[at] = { type: "gap", missing: parity };
      message = `Gap is now ${parity}`;
    }
  } else {
    entries.splice(at, 0, { type: "gap", missing: parity });
    message = `${parity === "odd" ? "Odd" : "Even"} Observation Gap added${at === 0 ? " before the first Shot" : ""}`;
    if (noShots) entry = 0;
  }
  const edit = editRally(
    ctx,
    (r) => ({ ...r, entries }),
    () => ({ ...ctx.selection, entry }),
  );
  return { ...edit, message };
}

/** `Backspace`: deletes the selected Shot or Observation Gap. */
export function deleteEntry(ctx: AnnotateContext): AnnotateEdit {
  const index = ctx.selection.entry;
  const entry = selectedEntry(ctx.games, ctx.selection);
  if (!entry || index === null) return unchanged(ctx, "Select a Shot or gap to delete");
  let remaining = 0;
  const edit = editRally(
    ctx,
    (r) => {
      const entries = r.entries.filter((_, i) => i !== index);
      remaining = entries.length;
      return { ...r, entries };
    },
    () => ({ ...ctx.selection, entry: remaining === 0 ? null : Math.max(0, index - 1) }),
  );
  return { ...edit, message: `${entry.type === "gap" ? "Observation Gap" : "Shot"} deleted` };
}

/** Moves a Shot's contact to `frame` (Move contact here, or dragging its pin). */
export function moveContact(ctx: AnnotateContext, entryIndex: number, frame: number): AnnotateEdit {
  const rally = selectedRally(ctx.games, ctx.selection);
  const shot = rally?.entries[entryIndex];
  if (!rally || !isShot(shot)) return unchanged(ctx, "Select a Shot first");
  if (rally.start_frame !== null && frame < rally.start_frame) {
    return unchanged(ctx, `This Rally starts at frame ${rally.start_frame}`);
  }
  if (rally.end_frame !== null && frame > rally.end_frame) {
    return unchanged(ctx, `This Rally ends at frame ${rally.end_frame}`);
  }
  if (shotsOf(rally).some((s) => s !== shot && s.contact_frame.value === frame)) {
    return unchanged(ctx, `There is already a Shot at frame ${frame}`);
  }
  const moved: Shot = { ...shot, contact_frame: observed(frame) };
  const entries = rally.entries.map((e) => (e === shot ? moved : e));
  const sorted = shot.contact_frame.value === null ? entries : sortEntries(entries);
  const at = sorted.indexOf(moved);
  const edit = editRally(
    { ...ctx, selection: { ...ctx.selection, entry: entryIndex } },
    (r) => ({ ...r, entries: sorted }),
    () => ({ ...ctx.selection, entry: at }),
  );
  return { ...edit, message: `Contact moved to frame ${frame}` };
}

/** Court + surround bounds for clicks, in feet. */
const COURT_BOUNDS = { x: 16, y: 32 };

function clampPoint(point: CourtPoint): CourtPoint {
  return {
    x: Math.max(-COURT_BOUNDS.x, Math.min(COURT_BOUNDS.x, point.x)),
    y: Math.max(-COURT_BOUNDS.y, Math.min(COURT_BOUNDS.y, point.y)),
  };
}

/** Clicking the court: the Shot's landing. */
export function setLanding(ctx: AnnotateContext, point: CourtPoint): AnnotateEdit {
  const p = clampPoint(point);
  return editShot(
    ctx,
    (s) => ({ ...s, landing: observed(p) }),
    () => `Landing (${p.x.toFixed(1)}, ${p.y.toFixed(1)} ft)`,
  );
}

/**
 * Dragging a Player's dot on the Court diagram: that Shot's position only (Observed). A Player
 * dragged out of the Frontcourt isn't Settled; the hitter's Contact Zone follows.
 */
export function moveShotPosition(
  ctx: AnnotateContext,
  playerId: string,
  point: CourtPoint,
): AnnotateEdit {
  const p = clampPoint(point);
  return editShot(
    ctx,
    (s) => {
      const current = s.positions[playerId] ?? { position: UNKNOWN, settled: UNKNOWN };
      const settled = Math.abs(p.y) > FRONTCOURT_MAX_Y_FT ? observed(false) : current.settled;
      const next = {
        ...s,
        positions: { ...s.positions, [playerId]: { position: observed(p), settled } },
      };
      return s.hitter_id.value === playerId ? { ...next, contact_zone: syncedZone(next) } : next;
    },
    () => `${playerName(ctx.roster, playerId)} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)} ft)`,
  );
}

/** Clicking a Player's Settled badge: Unknown → Settled → Moving → Unknown. */
export function cycleSettled(ctx: AnnotateContext, playerId: string): AnnotateEdit {
  return editShot(
    ctx,
    (s) => {
      const current = s.positions[playerId] ?? { position: UNKNOWN, settled: UNKNOWN };
      const settled: Fact<boolean> =
        current.settled.value === null
          ? observed(true)
          : current.settled.value
            ? observed(false)
            : UNKNOWN;
      return { ...s, positions: { ...s.positions, [playerId]: { ...current, settled } } };
    },
    (s) => {
      const value = s.positions[playerId]?.settled.value ?? null;
      return `${playerName(ctx.roster, playerId)}: ${value === null ? "Settled Unknown" : value ? "Settled" : "Moving"}`;
    },
  );
}

/** Clicking Contact Zone: Frontcourt → Midcourt → Backcourt (Observed), set by hand. */
export function cycleContactZone(ctx: AnnotateContext): AnnotateEdit {
  const order: Zone[] = ["frontcourt", "midcourt", "backcourt"];
  return editShot(
    ctx,
    (s) => {
      const current = s.contact_zone.value;
      const next = order[(current === null ? -1 : order.indexOf(current)) + 1] ?? order[0]!;
      return { ...s, contact_zone: observed(next) };
    },
    (s) => `Contact Zone: ${ZONE_LABELS[s.contact_zone.value!]}`,
  );
}

/** Sync from tracking: re-pulls every Player's position and Settled fact for the Shot. */
export function syncShotPositions(
  ctx: AnnotateContext,
  snapshot: Record<string, ShotPosition> | null,
): AnnotateEdit {
  return editShot(
    ctx,
    (s) => {
      const next = { ...s, positions: withAllPositions(ctx.roster, snapshot ?? {}) };
      return { ...next, contact_zone: syncedZone(next) };
    },
    () => (snapshot ? "Positions synced from Player Tracking" : "No Player Tracking at this frame"),
  );
}

/**
 * Swap A / Swap B parked on the selected Shot's contact: swaps those teammates on this Shot too
 * (positions, and the hitter or Error's Player if it was one of them).
 */
export function swapShotTeammates(ctx: AnnotateContext, teamId: string): AnnotateEdit {
  const [a, b] = teamPlayers(ctx.roster, teamId).map((p) => p.id);
  if (a === undefined || b === undefined) return unchanged(ctx, "No such Team");
  const swap = (id: string | null) => (id === a ? b : id === b ? a : id);
  return editShot(
    ctx,
    (s) => {
      const positions = { ...s.positions };
      const pa = s.positions[a];
      const pb = s.positions[b];
      if (pb) positions[a] = pb;
      else delete positions[a];
      if (pa) positions[b] = pa;
      else delete positions[b];
      const next: Shot = {
        ...s,
        positions,
        hitter_id: { ...s.hitter_id, value: swap(s.hitter_id.value) },
        error: s.error
          ? {
              ...s.error,
              player_id: { ...s.error.player_id, value: swap(s.error.player_id.value) },
            }
          : null,
      };
      return { ...next, contact_zone: syncedZone(next) };
    },
    () => "Teammates swapped on this Shot",
  );
}

// --- Certainty cycling --------------------------------------------------------------------

export type ShotField =
  | "hitter_id"
  | "shot_class"
  | "contact_kind"
  | "contact_zone"
  | "erne"
  | "atp"
  | "landing"
  | "error";
export type RallyField =
  | "frames"
  | "score"
  | "serving_team_id"
  | "server_id"
  | "returner_id"
  | "referee_call"
  | "challenge"
  | "winner_id"
  | "scoreboard_winner_id"
  | "status";

export const SHOT_FIELDS: ShotField[] = [
  "hitter_id",
  "shot_class",
  "contact_kind",
  "contact_zone",
  "erne",
  "atp",
  "landing",
  "error",
];
export const RALLY_FIELDS: RallyField[] = [
  "frames",
  "score",
  "serving_team_id",
  "server_id",
  "returner_id",
  "referee_call",
  "challenge",
  "winner_id",
  "scoreboard_winner_id",
  "status",
];

/** Facts `C` can cycle: Observed → Inferred → Unknown → Observed. */
const CYCLABLE_RALLY: ReadonlySet<RallyField> = new Set([
  "score",
  "serving_team_id",
  "server_id",
  "returner_id",
  "referee_call",
  "scoreboard_winner_id",
]);

/** Values set aside when a fact cycles to Unknown, restored when it cycles back. */
export type Stash = ReadonlyMap<string, unknown>;

/** One step of `C`: Observed → Inferred → Unknown (stashing the value) → Observed (restoring). */
export function cycleFact<T>(
  fact: Fact<T>,
  stashed: T | undefined,
): { fact: Fact<T>; stash: T | undefined } | null {
  if (fact.certainty === "observed")
    return { fact: { ...fact, certainty: "inferred" }, stash: stashed };
  if (fact.certainty === "inferred") return { fact: UNKNOWN, stash: fact.value ?? undefined };
  if (stashed === undefined) return null;
  return { fact: observed(stashed), stash: undefined };
}

function stashKey(selection: Selection, games: readonly Game[], field: string): string {
  const rally = selectedRally(games, selection);
  return `${games[selection.game]?.number}:${rally?.number}:${selection.entry ?? "rally"}:${field}`;
}

/** `C` on the focused field. Returns the edit and the updated stash. */
export function cycleCertainty(
  ctx: AnnotateContext,
  tab: "shot" | "rally",
  field: ShotField | RallyField,
  stash: Stash,
): { edit: AnnotateEdit; stash: Stash } {
  const key = stashKey(ctx.selection, ctx.games, field);
  const nextStash = new Map(stash);
  const finish = <T>(fact: Fact<T>, apply: (next: Fact<T>) => AnnotateEdit) => {
    const cycled = cycleFact(fact, stash.get(key) as T | undefined);
    if (!cycled) {
      return { edit: unchanged(ctx, "Nothing to restore: set a value with its key"), stash };
    }
    if (cycled.stash === undefined) nextStash.delete(key);
    else nextStash.set(key, cycled.stash);
    const edit = apply(cycled.fact);
    return { edit: { ...edit, message: `Certainty: ${cycled.fact.certainty}` }, stash: nextStash };
  };
  if (tab === "shot") {
    const shot = selectedShot(ctx.games, ctx.selection);
    if (!shot) return { edit: unchanged(ctx, "Select a Shot first"), stash };
    if (field === "error") {
      const error = shot.error;
      if (!error) return { edit: unchanged(ctx, "No Error on this Shot"), stash };
      return finish(error.kind, (kind) =>
        editShot(
          ctx,
          (s) => ({ ...s, error: { ...error, kind } }),
          () => "",
        ),
      );
    }
    const name = field as Exclude<ShotField, "error">;
    return finish(shot[name] as Fact<unknown>, (next) =>
      editShot(
        ctx,
        (s) => ({ ...s, [name]: next }),
        () => "",
      ),
    );
  }
  const rally = selectedRally(ctx.games, ctx.selection);
  if (!rally) return { edit: unchanged(ctx, "Select a Rally first"), stash };
  if (!CYCLABLE_RALLY.has(field as RallyField)) {
    const reason =
      field === "winner_id"
        ? "The winner is worked out from its sources"
        : "This field has no certainty to cycle";
    return { edit: unchanged(ctx, reason), stash };
  }
  const name = field as "score";
  return finish(rally[name] as Fact<unknown>, (next) =>
    editRally(ctx, (r) => ({ ...r, [name]: next }) as Rally),
  );
}

/** Whether the playhead is parked on the selected Shot's contact frame. */
export function parkedOnShot(games: readonly Game[], selection: Selection, frame: number): boolean {
  return selectedShot(games, selection)?.contact_frame.value === frame;
}

/** Framed Rallies of every Game, for the Timeline. */
export function framedRallies(
  games: readonly Game[],
): { game: number; rally: number; value: Rally; gameNumber: number }[] {
  return games.flatMap((g, gi) =>
    g.rallies.flatMap((r, ri) =>
      isFramed(r) ? [{ game: gi, rally: ri, value: r, gameNumber: g.number }] : [],
    ),
  );
}
