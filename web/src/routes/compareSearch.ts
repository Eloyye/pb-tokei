import type { components } from "../api/schema";
import { asId, matchFilters, type MatchFilters } from "./matchFilters";
import { asReportSplit, REPORT_SPLITS, type ReportSplit } from "./reportOptions";

export type SubjectKind = components["schemas"]["SubjectKind"];

export type CompareSearch = MatchFilters & {
  kind?: SubjectKind;
  a?: string;
  b?: string;
  by?: ReportSplit;
};

/** Splits that apply to every column of a compare: Teams have no Court Half. */
export function compareSplits(kind: SubjectKind): ReportSplit[] {
  const splits = Object.keys(REPORT_SPLITS) as ReportSplit[];
  return kind === "team" ? splits.filter((split) => split !== "court_half") : splits;
}

export function compareSearch(search: Record<string, unknown>): CompareSearch {
  const kind = search.kind === "team" ? "team" : search.kind === "player" ? "player" : undefined;
  const by = asReportSplit(search.by);
  const a = asId(search.a);
  const b = asId(search.b);
  return {
    ...matchFilters(search),
    kind,
    a,
    b: b === a ? undefined : b,
    by: by && compareSplits(kind ?? "player").includes(by) ? by : undefined,
  };
}
