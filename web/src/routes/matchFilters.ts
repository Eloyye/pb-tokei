import type { PlayerMatchFilters, TeamMatchFilters } from "../api/client";
import type { components } from "../api/schema";
import { isValidMatchDate } from "./matchDate";
import { reportSearch } from "./reportOptions";

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

export function teamMatchFilters(search: Record<string, unknown>): TeamMatchFilters {
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
    opponent: asId(search.opponent),
  };
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
