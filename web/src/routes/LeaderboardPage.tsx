import { getRouteApi, Link } from "@tanstack/react-router";
import { ApiError, getLeaderboard } from "../api/client";
import type { components } from "../api/schema";
import { asMinimum, type LeaderboardSearch } from "./leaderboardSearch";
import { MatchFilterForm } from "./MatchFilterForm";
import { hasMatchFilters, matchFilterDateError, matchFilters } from "./matchFilters";
import { asReportSplit, matchCountLabel, REPORT_SPLITS, type ReportSplit } from "./reportOptions";
import { ReportLoadError, useReportQuery } from "./reportQuery";
import { ReportCellValue } from "./ReportTables";
import { reportTeamLabel } from "./teams";
import "./report.css";

type LeaderboardStat = components["schemas"]["LeaderboardStat"];
type LeaderboardRow = components["schemas"]["Leaderboard"]["rows"][number];
type SubjectKind = components["schemas"]["SubjectKind"];

const route = getRouteApi("/leaderboard");

function appliesTo(stat: LeaderboardStat, kind: SubjectKind) {
  return stat.applies_to === "both" || stat.applies_to === kind;
}

function supportsSplit(stat: LeaderboardStat, by?: ReportSplit) {
  return by === undefined || stat.splits_by.includes(by);
}

export function LeaderboardPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind = "player", minimum = 30, stat, by, bucket, ...filters } = search;
  const dateError = matchFilterDateError(filters);
  const report = useReportQuery(
    ["leaderboard", search],
    (signal) => {
      if (dateError) throw new ApiError(422, dateError);
      return getLeaderboard(
        { ...search, bucket: bucket === undefined ? undefined : String(bucket) },
        signal,
      );
    },
    (previous) => previous,
  );

  function updateSearch(update: Partial<LeaderboardSearch>) {
    void navigate({ search: (previous) => ({ ...previous, ...update }) });
  }

  if (report.isPending)
    return <output className="match-report notice">Loading Leaderboard…</output>;
  if (report.isError) {
    if (!(report.error instanceof ApiError) || report.error.status !== 422) {
      return <ReportLoadError error={report.error} retry={() => void report.refetch()} />;
    }
    return (
      <p className="match-report notice error" role="alert">
        {dateError ?? "These Leaderboard settings are unavailable."}{" "}
        <button
          type="button"
          className="button"
          onClick={() => {
            if (dateError) updateSearch(matchFilters({}));
            else void navigate({ search: {} });
          }}
        >
          {dateError ? "Clear filters" : "Reset Leaderboard"}
        </button>
      </p>
    );
  }

  const data = report.data;
  const stats = data.stats.filter((option) => appliesTo(option, kind));
  const statId = report.isPlaceholderData ? stat : data.stat;
  const selected =
    stats.find((option) => option.id === statId) ??
    stats.find((option) => option.kind === "rate" && supportsSplit(option, by));
  const buckets = by ? (data.buckets[by] ?? []) : [];
  const groups = new Set(stats.map((option) => option.group));
  const subject = kind === "team" ? "Team" : "Player";

  function changeRanking(nextKind: SubjectKind, nextBy: ReportSplit | undefined) {
    const nextStat =
      selected && appliesTo(selected, nextKind) && supportsSplit(selected, nextBy)
        ? selected.id
        : undefined;
    updateSearch({
      kind: nextKind,
      stat: nextStat,
      by: nextBy,
      bucket: nextBy === by ? bucket : undefined,
    });
  }

  return (
    <main className="match-report">
      <div className="report-content leaderboard">
        <header className="report-header report-matchup">
          <h1>Leaderboard</h1>
        </header>
        <div className="leaderboard-controls">
          <fieldset className="leaderboard-kind">
            <legend>Rank</legend>
            <label>
              <input
                type="radio"
                name="leaderboard-kind"
                checked={kind === "player"}
                onChange={() => changeRanking("player", by)}
              />
              Players
            </label>
            <label>
              <input
                type="radio"
                name="leaderboard-kind"
                checked={kind === "team"}
                onChange={() => changeRanking("team", by === "court_half" ? undefined : by)}
              />
              Teams
            </label>
          </fieldset>
          <label className="match-filter-field">
            Stat
            <select
              value={selected?.id ?? ""}
              onChange={(event) => updateSearch({ stat: event.currentTarget.value })}
            >
              {[...groups].map((group) => (
                <optgroup key={group} label={group}>
                  {stats
                    .filter((option) => option.group === group)
                    .map((option) => (
                      <option
                        key={option.id}
                        value={option.id}
                        disabled={!supportsSplit(option, by)}
                      >
                        {option.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="match-filter-field">
            Break down by
            <select
              value={by ?? ""}
              onChange={(event) => changeRanking(kind, asReportSplit(event.currentTarget.value))}
            >
              <option value="">None</option>
              {Object.entries(REPORT_SPLITS).map(([split, label]) => (
                <option
                  key={split}
                  value={split}
                  disabled={split === "court_half" && kind === "team"}
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          {by && (
            <label className="match-filter-field">
              Bucket
              <select
                value={bucket ?? buckets[0] ?? ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  updateSearch({ bucket: /^\d+$/.test(value) ? Number(value) : value });
                }}
              >
                {buckets.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          )}
          <form
            className="leaderboard-minimum"
            onSubmit={(event) => {
              event.preventDefault();
              const value = asMinimum(Number(new FormData(event.currentTarget).get("minimum")));
              if (value !== undefined) updateSearch({ minimum: value });
            }}
          >
            <label className="match-filter-field">
              Minimum attempts
              <input
                key={minimum}
                name="minimum"
                type="number"
                min={1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                defaultValue={minimum}
                required
              />
            </label>
            <button type="submit" className="button">
              Set minimum
            </button>
          </form>
        </div>
        <MatchFilterForm
          options={data.filter_options}
          filters={filters}
          onApply={(value) => updateSearch(matchFilters(value))}
        />
        {report.isPlaceholderData ? (
          <output className="report-empty">Updating Leaderboard…</output>
        ) : (
          <section className="leaderboard-results" aria-label="Rankings">
            <output className="leaderboard-coverage">
              <span>{matchCountLabel(data.match_count)}</span>
              <span>
                {data.hidden_count} {subject}
                {data.hidden_count === 1 ? "" : "s"} hidden below {minimum}{" "}
                {minimum === 1 ? "attempt" : "attempts"}
              </span>
              {data.undated_matches_excluded > 0 && (
                <span>
                  {matchCountLabel(data.undated_matches_excluded)} left out because of missing dates
                </span>
              )}
            </output>
            {data.rows.length > 0 && selected ? (
              <RankingTable rows={data.rows} stat={selected} kind={kind} />
            ) : (
              <p className="report-empty">
                {data.match_count === 0
                  ? hasMatchFilters(filters)
                    ? "No Matches match these filters."
                    : "No Matches yet."
                  : `No ${subject}s meet the minimum for this stat.`}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function RankingTable({
  rows,
  stat,
  kind,
}: {
  rows: LeaderboardRow[];
  stat: LeaderboardStat;
  kind: SubjectKind;
}) {
  return (
    <div className="subject-list-scroll">
      <table className="subject-list leaderboard-table" aria-label="Leaderboard results">
        <thead>
          <tr>
            <th scope="col" className="subject-number">
              Rank
            </th>
            <th scope="col">{kind === "team" ? "Team" : "Player"}</th>
            <th scope="col" aria-sort="descending">
              {stat.label}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ rank, subject, value, kind: rowKind }) => (
            <tr key={subject.id}>
              <td className="subject-number">{rank}</td>
              <th scope="row">
                {rowKind === "team" ? (
                  <Link className="report-link" to="/teams/$teamId" params={{ teamId: subject.id }}>
                    {reportTeamLabel(subject)}
                  </Link>
                ) : (
                  <Link
                    className="report-link"
                    to="/players/$playerId"
                    params={{ playerId: subject.id }}
                  >
                    {subject.name}
                  </Link>
                )}
              </th>
              <td className="leaderboard-rate">
                <ReportCellValue kind={stat.kind} value={value} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="leaderboard-interval-note">Rate bars show 90% Wilson intervals</p>
    </div>
  );
}
