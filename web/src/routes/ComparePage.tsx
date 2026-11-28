import { getRouteApi } from "@tanstack/react-router";
import { ApiError, getComparison } from "../api/client";
import type { components } from "../api/schema";
import { compareSplits, type CompareSearch, type SubjectKind } from "./compareSearch";
import { MatchFilterForm } from "./MatchFilterForm";
import { matchFilterDateError, matchFilters, type MatchFilters } from "./matchFilters";
import { asReportSplit, matchCountLabel } from "./reportOptions";
import { ReportLoadError, useReportQuery } from "./reportQuery";
import { ReportCoverage, ReportTables, type ReportColumn } from "./ReportTables";
import { reportTeamLabel } from "./teams";
import "./report.css";

type Comparison = components["schemas"]["Comparison"];
type CompareSide = NonNullable<Comparison["a"]>;
type Choice = Comparison["choices"][number];

const route = getRouteApi("/compare");

function subjectLabel(subject: Choice): string {
  return "players" in subject ? reportTeamLabel(subject) : subject.name;
}

function sideColumn(side: CompareSide, letter: "a" | "b"): ReportColumn {
  const { subject } = side;
  return "players" in subject
    ? {
        id: subject.id,
        label: reportTeamLabel(subject),
        kind: "team",
        teamLetter: letter,
        link: true,
      }
    : { id: subject.id, label: subject.name, kind: "player", link: true };
}

export function ComparePage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind = "player", a, b, by, ...filters } = search;
  const dateError = matchFilterDateError(filters);
  const report = useReportQuery(
    ["compare", kind, a, b, filters],
    (signal) => {
      if (dateError) throw new ApiError(422, dateError);
      return getComparison({ ...filters, kind, a, b }, signal);
    },
    (previous) => (previous?.kind === kind ? previous : undefined),
  );
  const subject = kind === "team" ? "Team" : "Player";

  function updateSearch(update: Partial<CompareSearch>) {
    void navigate({ search: (previous) => ({ ...previous, ...update }) });
  }

  function changeKind(next: SubjectKind) {
    if (next === kind) return;
    const nextBy = by && compareSplits(next).includes(by) ? by : undefined;
    void navigate({ search: { ...filters, kind: next, by: nextBy } });
  }

  const kindPicker = (
    <fieldset className="leaderboard-kind">
      <legend>Compare</legend>
      <label>
        <input
          type="radio"
          name="compare-kind"
          checked={kind === "player"}
          onChange={() => changeKind("player")}
        />
        Players
      </label>
      <label>
        <input
          type="radio"
          name="compare-kind"
          checked={kind === "team"}
          onChange={() => changeKind("team")}
        />
        Teams
      </label>
    </fieldset>
  );

  if (report.isPending) return <output className="match-report notice">Loading Compare…</output>;
  if (report.isError) {
    const status = report.error instanceof ApiError ? report.error.status : undefined;
    if (status !== 404 && status !== 422) {
      return <ReportLoadError error={report.error} retry={() => void report.refetch()} />;
    }
    return (
      <p className="match-report notice error" role="alert">
        {dateError ?? report.error.message}{" "}
        <button
          type="button"
          className="button"
          onClick={() => {
            if (dateError) updateSearch(matchFilters({}));
            else void navigate({ search: { kind } });
          }}
        >
          {dateError ? "Clear filters" : "Choose again"}
        </button>
      </p>
    );
  }

  const data = report.data;
  const updating = report.isPlaceholderData;
  const sides = [data.a, data.b] as const;
  const columns = sides.flatMap((side, index) =>
    side ? [sideColumn(side, index === 0 ? "a" : "b")] : [],
  );
  const counted = sides.reduce((total, side) => total + (side?.header.rallies.counted ?? 0), 0);

  return (
    <main className="match-report">
      <div className="report-content">
        <header className="report-header report-matchup">
          <h1>Compare</h1>
        </header>
        <div className="leaderboard-controls">
          {kindPicker}
          <SubjectSelect
            label={`${subject} A`}
            subject={subject}
            value={a}
            other={b}
            choices={data.choices}
            onChange={(value) => updateSearch({ a: value })}
          />
          <SubjectSelect
            label={`${subject} B`}
            subject={subject}
            value={b}
            other={a}
            choices={data.choices}
            onChange={(value) => updateSearch({ b: value })}
          />
        </div>
        <MatchFilterForm
          options={data.filter_options}
          filters={filters}
          onApply={(value: MatchFilters) =>
            void navigate({ search: { ...matchFilters(value), kind, a, b, by } })
          }
        />
        {updating ? (
          <output className="report-empty">Updating Compare…</output>
        ) : !data.a || !data.b ? (
          <p className="report-empty">Choose two {subject}s to compare.</p>
        ) : (
          <>
            <section className="compare-coverage" aria-label="Coverage">
              {sides.map(
                (side, index) =>
                  side && (
                    <div key={side.subject.id}>
                      <h2>
                        {index === 0 ? "A" : "B"}: {subjectLabel(side.subject)}
                      </h2>
                      <ReportCoverage
                        matchCount={side.header.match_count}
                        rallies={side.header.rallies}
                        uncredited={side.header.uncredited}
                      />
                      {side.undated_matches_excluded > 0 && (
                        <p>
                          {matchCountLabel(side.undated_matches_excluded)} left out because of
                          missing dates.
                        </p>
                      )}
                    </div>
                  ),
              )}
            </section>
            {counted > 0 ? (
              <ReportTables
                stats={data.stats}
                columns={columns}
                by={by}
                splits={compareSplits(kind)}
                onSplitChange={(value) => updateSearch({ by: asReportSplit(value) })}
              />
            ) : (
              <p className="report-empty">No Rallies yet. Add Rallies in Annotate to see stats.</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function SubjectSelect({
  label,
  subject,
  value,
  other,
  choices,
  onChange,
}: {
  label: string;
  subject: string;
  value?: string;
  other?: string;
  choices: Choice[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="match-filter-field">
      {label}
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || undefined)}
      >
        <option value="">Choose a {subject}</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id} disabled={choice.id === other}>
            {subjectLabel(choice)}
          </option>
        ))}
        {value && !choices.some((choice) => choice.id === value) && (
          <option value={value}>Unavailable {subject}</option>
        )}
      </select>
    </label>
  );
}
