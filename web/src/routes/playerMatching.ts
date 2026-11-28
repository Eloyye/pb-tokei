import type { Handedness } from "../api/client";
import { fuzzyNearMatchScore, normalizeFuzzy, normalizeName } from "./nameMatching";

export { fuzzyNearMatchScore, normalizeFuzzy, normalizeName } from "./nameMatching";

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
