import type { components } from "../api/schema";
import { matchFilters, type MatchFilters } from "./matchFilters";
import { asReportSplit, type ReportSplit } from "./reportOptions";

export type LeaderboardSearch = MatchFilters & {
  kind?: components["schemas"]["SubjectKind"];
  stat?: string;
  minimum?: number;
  by?: ReportSplit;
  bucket?: string | number;
};

export function asMinimum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  return undefined;
}

export function leaderboardSearch(search: Record<string, unknown>): LeaderboardSearch {
  const { kind, stat, minimum, bucket } = search;
  const by = asReportSplit(search.by);
  return {
    ...matchFilters(search),
    kind: kind === "player" || kind === "team" ? kind : undefined,
    stat: typeof stat === "string" && stat ? stat : undefined,
    minimum: asMinimum(minimum),
    by,
    bucket: by && (typeof bucket === "string" || typeof bucket === "number") ? bucket : undefined,
  };
}
