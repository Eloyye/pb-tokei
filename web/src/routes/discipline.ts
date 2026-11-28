import type { Discipline, Gender, Handedness } from "../api/client";

export const DISCIPLINES = {
  mens_doubles: "Men's Doubles",
  womens_doubles: "Women's Doubles",
  mixed_doubles: "Mixed Doubles",
} satisfies Record<Discipline, string>;

export const DISCIPLINE_LIST: readonly Discipline[] = [
  "mens_doubles",
  "womens_doubles",
  "mixed_doubles",
];

export function disciplineLabel(discipline: Discipline | null | undefined): string {
  return discipline ? DISCIPLINES[discipline] : "—";
}

export function genderLabel(gender: Gender | null | undefined): string {
  if (gender === "male") return "Male";
  if (gender === "female") return "Female";
  return "—";
}

export function genderShort(gender: Gender | null | undefined): "M" | "W" | "?" {
  if (gender === "male") return "M";
  if (gender === "female") return "W";
  return "?";
}

export function playerMetaBadge(player: {
  handedness: Handedness;
  gender: Gender | null | undefined;
}): string {
  const hand = player.handedness === "left" ? "L" : "R";
  return `${hand} · ${genderShort(player.gender)}`;
}

export function teamDiscipline(
  genders: readonly [Gender | null | "", Gender | null | ""],
): Discipline | null {
  const [first, second] = genders;
  if (!first || !second) return null;
  if (first === second) {
    return first === "male" ? "mens_doubles" : "womens_doubles";
  }
  return "mixed_doubles";
}

export function deriveMatchDiscipline(
  teamA: readonly [Gender | null | "", Gender | null | ""],
  teamB: readonly [Gender | null | "", Gender | null | ""],
): { discipline: Discipline | null; error: string | null } {
  const discA = teamDiscipline(teamA);
  const discB = teamDiscipline(teamB);
  if (!discA || !discB) return { discipline: null, error: null };
  if (discA !== discB) {
    return {
      discipline: null,
      error: `Invalid Match lineup: ${DISCIPLINES[discA]} vs ${DISCIPLINES[discB]} (must be Men's Doubles, Women's Doubles, or Mixed Doubles).`,
    };
  }
  return { discipline: discA, error: null };
}

export function requiredGenderForSlot(
  helper: Discipline | "",
  partnerGender: Gender | null | "",
): Gender | null {
  if (helper === "mens_doubles") return "male";
  if (helper === "womens_doubles") return "female";
  if (helper === "mixed_doubles") {
    if (partnerGender === "male") return "female";
    if (partnerGender === "female") return "male";
  }
  return null;
}

export function isGenderEligible(
  gender: Gender | null | undefined,
  required: Gender | null,
): boolean {
  return required === null || !gender || gender === required;
}

export function franchiseMatchLabel(match: {
  team_a: readonly string[];
  team_b: readonly string[];
  discipline: Discipline | null;
}): string {
  return `${match.team_a.join(" / ")} vs ${match.team_b.join(" / ")} (${disciplineLabel(match.discipline)})`;
}
