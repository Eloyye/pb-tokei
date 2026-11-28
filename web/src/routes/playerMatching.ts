import type { Handedness } from "../api/client";

export interface RosterPlayerOption {
  id: string;
  name: string;
  handedness: Handedness;
}

export interface StagedNewPlayer {
  name: string;
  normalizedName: string;
  handedness: Handedness | "";
  slotLabel: string;
}

export interface OtherSlotUsage {
  /** Existing Player IDs assigned in other slots, mapped to their slot label (e.g. "Team A"). */
  existingIds: ReadonlyMap<string, string>;
  /** Staged new Players in other slots. */
  stagedNew: readonly StagedNewPlayer[];
}

export type DropdownOption =
  | {
      kind: "existing";
      player: RosterPlayerOption;
      disabled: boolean;
      disabledReason?: string;
    }
  | {
      kind: "staged-new";
      staged: StagedNewPlayer;
      disabled: true;
      disabledReason: string;
    }
  | {
      kind: "create";
      name: string;
      disabled: false;
    };

export type DraftCheck =
  | { kind: "empty" }
  | { kind: "existing-collision"; player: RosterPlayerOption; usedInSlot?: string }
  | { kind: "staged-collision"; name: string; usedInSlot: string }
  | { kind: "near-matches"; matches: { player: RosterPlayerOption; usedInSlot?: string }[] }
  | { kind: "ok" };

export const MAX_DROPDOWN_PLAYERS = 8;
const MAX_NEAR_MATCHES = 3;

/** Matches backend case + internal-whitespace folding (`" ".join(name.split()).casefold()`). */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Normalizes punctuation, whitespace, and case for fuzzy Player comparison so hyphen and
 * punctuation variants ("Anna-Leigh Waters" <-> "Anna Leigh Waters", "J.W. Johnson" <->
 * "JW Johnson", "O'Brien" <-> "OBrien") match reliably.
 */
export function normalizeFuzzy(name: string): string {
  return name
    .replace(/[-–—]/g, " ")
    .replace(/[.'’‘]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function maxEditDistance(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  if (minLen < 3) return 0;
  if (minLen < 5) return 1;
  return 2;
}

/** Optimal string alignment (Damerau-Levenshtein) distance, capped at `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return Infinity;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prevPrev[j - 2]! + 1);
      }
      curr.push(best);
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > limit) return Infinity;
    prevPrev = prev;
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * All words of one name appear in the other. Requires at least 2 characters on both sides so
 * single-character queries don't fuzzy-match, and requires full-word containment rather than
 * single-word overlap so sibling pairs ("Ben Johns" / "Collin Johns", "JW Johnson" /
 * "Jorja Johnson", "Jade Kawamoto" / "Jackie Kawamoto") never false-positive.
 */
function wordsContained(a: string, b: string): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const left = a.split(" ");
  const right = b.split(" ");
  return left.every((word) => right.includes(word)) || right.every((word) => left.includes(word));
}

/** Lower score means a closer near-match; null means not a near-match. */
export function fuzzyNearMatchScore(queryFuzzy: string, targetFuzzy: string): number | null {
  if (!queryFuzzy || !targetFuzzy) return null;
  if (queryFuzzy === targetFuzzy) return 0;
  const limit = maxEditDistance(queryFuzzy, targetFuzzy);
  const distance = editDistance(queryFuzzy, targetFuzzy, limit);
  if (distance <= limit) return distance;
  if (wordsContained(queryFuzzy, targetFuzzy)) return 3;
  return null;
}

function dropdownMatchTier(
  queryNorm: string,
  queryFuzzy: string,
  targetNorm: string,
  targetFuzzy: string,
): number | null {
  if (!queryNorm) return 0;
  if (targetNorm === queryNorm) return 0;
  if (queryFuzzy && targetFuzzy === queryFuzzy) return 1;
  if (targetNorm.startsWith(queryNorm) || (queryFuzzy && targetFuzzy.startsWith(queryFuzzy))) {
    return 2;
  }
  if (targetNorm.includes(queryNorm) || (queryFuzzy && targetFuzzy.includes(queryFuzzy))) {
    return 3;
  }
  const fuzzy = fuzzyNearMatchScore(queryFuzzy, targetFuzzy);
  return fuzzy === null ? null : 4 + fuzzy;
}

export interface SearchDropdownResult {
  options: DropdownOption[];
  hasPlayerMatches: boolean;
  canCreate: boolean;
}

export function buildPlayerDropdown(
  query: string,
  players: readonly RosterPlayerOption[],
  otherSlots: OtherSlotUsage,
): SearchDropdownResult {
  const trimmed = query.trim();
  const queryNorm = normalizeName(query);
  const queryFuzzy = normalizeFuzzy(query);

  const ranked: { tier: number; option: DropdownOption }[] = [];
  let hasExactOrNormalizedCollision = false;

  for (const player of players) {
    const targetNorm = normalizeName(player.name);
    if (queryNorm && targetNorm === queryNorm) {
      hasExactOrNormalizedCollision = true;
    }
    const tier = dropdownMatchTier(queryNorm, queryFuzzy, targetNorm, normalizeFuzzy(player.name));
    if (tier === null) continue;
    const disabledReason = otherSlots.existingIds.get(player.id);
    ranked.push({
      tier,
      option: {
        kind: "existing",
        player,
        disabled: disabledReason !== undefined,
        disabledReason,
      },
    });
  }

  for (const staged of otherSlots.stagedNew) {
    if (!staged.normalizedName) continue;
    if (queryNorm && staged.normalizedName === queryNorm) {
      hasExactOrNormalizedCollision = true;
    }
    const tier = dropdownMatchTier(
      queryNorm,
      queryFuzzy,
      staged.normalizedName,
      normalizeFuzzy(staged.name),
    );
    if (tier === null) continue;
    ranked.push({
      tier,
      option: {
        kind: "staged-new",
        staged,
        disabled: true,
        disabledReason: staged.slotLabel,
      },
    });
  }

  ranked.sort((a, b) => a.tier - b.tier);
  const playerOptions = ranked.slice(0, MAX_DROPDOWN_PLAYERS).map(({ option }) => option);
  const canCreate = trimmed.length > 0 && !hasExactOrNormalizedCollision;
  const options: DropdownOption[] = canCreate
    ? [...playerOptions, { kind: "create", name: trimmed, disabled: false }]
    : playerOptions;

  return {
    options,
    hasPlayerMatches: playerOptions.length > 0,
    canCreate,
  };
}

export function checkNewPlayerDraft(
  name: string,
  players: readonly RosterPlayerOption[],
  otherSlots: OtherSlotUsage,
): DraftCheck {
  const trimmed = name.trim();
  if (!trimmed) return { kind: "empty" };
  const norm = normalizeName(trimmed);

  const matchingExisting = players.filter((player) => normalizeName(player.name) === norm);
  if (matchingExisting.length > 0) {
    // Prefer an unused Player (so legacy duplicate rows can still pick the unused one).
    const colliding =
      matchingExisting.find((p) => p.name === trimmed && !otherSlots.existingIds.has(p.id)) ??
      matchingExisting.find((p) => !otherSlots.existingIds.has(p.id)) ??
      matchingExisting.find((p) => p.name === trimmed) ??
      matchingExisting[0]!;
    return {
      kind: "existing-collision",
      player: colliding,
      usedInSlot: otherSlots.existingIds.get(colliding.id),
    };
  }

  const staged = otherSlots.stagedNew.find((item) => item.normalizedName === norm);
  if (staged) {
    return {
      kind: "staged-collision",
      name: staged.name,
      usedInSlot: staged.slotLabel,
    };
  }

  const fuzzy = normalizeFuzzy(trimmed);
  if (!fuzzy) return { kind: "ok" };

  const near: { score: number; player: RosterPlayerOption }[] = [];
  for (const player of players) {
    const score = fuzzyNearMatchScore(fuzzy, normalizeFuzzy(player.name));
    if (score !== null) near.push({ score, player });
  }
  if (near.length > 0) {
    near.sort((a, b) => a.score - b.score);
    return {
      kind: "near-matches",
      matches: near.slice(0, MAX_NEAR_MATCHES).map(({ player }) => ({
        player,
        usedInSlot: otherSlots.existingIds.get(player.id),
      })),
    };
  }

  return { kind: "ok" };
}
