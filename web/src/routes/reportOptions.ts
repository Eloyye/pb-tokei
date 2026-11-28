import type { components } from "../api/schema";

export type ReportSplit = components["schemas"]["ReportSplit"];

export const REPORT_SPLITS: Record<ReportSplit, string> = {
  rally_phase: "Rally Phase",
  shot_number: "Shot Number",
  opening: "Opening",
  court_half: "Court Half",
};

export function asReportSplit(value: unknown): ReportSplit | undefined {
  if (typeof value === "string" && Object.hasOwn(REPORT_SPLITS, value)) return value as ReportSplit;
  return undefined;
}

export function reportSearch(search: Record<string, unknown>): { by?: ReportSplit } {
  const by = asReportSplit(search.by);
  return by ? { by } : {};
}

export function matchCountLabel(count: number): string {
  return `${count} ${count === 1 ? "Match" : "Matches"}`;
}
