import type { PlayerMatchFilters, TeamMatchFilters } from "../api/client";
import type { components } from "../api/schema";
import { isValidMatchDate } from "./matchDate";
import { reportSearch } from "./reportOptions";

export type MatchFilters = Omit<TeamMatchFilters, "opponent">;

export const TOURS = { ppa: "PPA", app: "APP", mlp: "MLP" } satisfies Record<
  components["schemas"]["Tour"],
  string
>;

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function asId(value: unknown) {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : undefined;
}

function asDate(value: unknown) {
  return typeof value === "string" && isValidMatchDate(value) ? value : undefined;
}

export function hasMatchFilters(filters: MatchFilters): boolean {
  return Object.values(filters).some(Boolean);
}

export function matchFilterDateError({ date_from, date_to }: MatchFilters): string | undefined {
  if (date_from && date_to && date_from > date_to) {
    return "Date from must be on or before Date to.";
  }
}

export function matchFilters(search: Record<string, unknown>): MatchFilters {
  const rawTournaments = Array.isArray(search.tournament) ? search.tournament : [search.tournament];
  const tournaments = [
    ...new Set(rawTournaments.map(asId).filter((id) => id !== undefined)),
  ].toSorted();
  const tour = search.tour;
  return {
    tournament: tournaments.length ? tournaments : undefined,
    tour:
      typeof tour === "string" && Object.hasOwn(TOURS, tour)
        ? (tour as keyof typeof TOURS)
        : undefined,
    date_from: asDate(search.date_from),
    date_to: asDate(search.date_to),
  };
}

export function teamMatchFilters(search: Record<string, unknown>): TeamMatchFilters {
  return { ...matchFilters(search), opponent: asId(search.opponent) };
}

export function playerMatchFilters(search: Record<string, unknown>): PlayerMatchFilters {
  return { ...teamMatchFilters(search), partner: asId(search.partner) };
}

export function teamReportSearch(search: Record<string, unknown>) {
  return { ...teamMatchFilters(search), ...reportSearch(search) };
}

export function playerReportSearch(search: Record<string, unknown>) {
  return { ...playerMatchFilters(search), ...reportSearch(search) };
}
