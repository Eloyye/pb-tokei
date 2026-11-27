import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { ApiError, getMatchReport, isRetryable } from "../api/client";
import type { components } from "../api/schema";
import { waitUntilSaved } from "../lib/unsavedChanges";
import { useOpenRallyLogPicker } from "../shell/rallyLog";
import { asReportSplit, REPORT_SPLITS, type ReportSplit } from "./reportOptions";
import "./report.css";

type MatchReport = components["schemas"]["MatchReport"];
type ReportStat = components["schemas"]["ReportStat"];
type ReportSubRow = components["schemas"]["ReportSubRow"];
type ReportValues = components["schemas"]["ReportValues"];
type ReportValue = components["schemas"]["ReportValue"];
type ReportRate = components["schemas"]["ReportRate"];
type ReportMix = components["schemas"]["ReportMix"];
type ReportTeam = components["schemas"]["ReportTeam"];

type Column = { id: string; label: string; kind: "team" | "player"; teamLetter: "a" | "b" };
type TableContext = { columns: Column[]; by?: ReportSplit };

const route = getRouteApi("/matches/$matchId/$workspace");
const PERCENT = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 });
const PER100 = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function ReportPage({ matchId }: { matchId: string }) {
  const { by } = route.useSearch();
  const navigate = route.useNavigate();
  const openPicker = useOpenRallyLogPicker();
  const report = useQuery({
    queryKey: ["match-report", matchId],
    queryFn: async ({ signal }) => {
      // Annotate can still be flushing its last edit when the Report tab opens.
      await waitUntilSaved();
      signal.throwIfAborted();
      return getMatchReport(matchId, signal);
    },
    gcTime: 0,
    refetchOnMount: "always",
    retry: (failures, error) => failures < 3 && isRetryable(error),
  });

  if (report.isPending) return <p className="match-report notice">Loading Match report…</p>;
  if (report.isError) {
    const conflict = report.error instanceof ApiError && report.error.status === 409;
    return (
      <p className="match-report notice error">
        {report.error.message}{" "}
        <button
          type="button"
          className="button"
          onClick={conflict ? openPicker : () => void report.refetch()}
        >
          {conflict ? "Choose a Rally Log" : "Retry"}
        </button>
      </p>
    );
  }
  return (
    <Report
      key={matchId}
      report={report.data}
      by={by}
      onSplitChange={(value) => void navigate({ search: { by: asReportSplit(value) } })}
    />
  );
}

function teamLabel(team: ReportTeam) {
  return team.players.map((player) => player.name).join(" / ");
}

function Report({
  report,
  by,
  onSplitChange,
}: {
  report: MatchReport;
  by?: ReportSplit;
  onSplitChange: (value: string) => void;
}) {
  const { header, stats } = report;
  const columns = header.teams.flatMap((team, index): Column[] => {
    const teamLetter = index === 0 ? "a" : "b";
    return [
      { id: team.id, label: `Team: ${teamLabel(team)}`, kind: "team", teamLetter },
      ...team.players.map((player): Column => ({
        id: player.id,
        label: player.name,
        kind: "player",
        teamLetter,
      })),
    ];
  });
  const context = { columns, by };
  const reasons = stats.find((stat) => stat.id === "outcome_reason");
  const groups = new Set(stats.map((stat) => stat.group));

  return (
    <main className="match-report">
      <div className="report-content">
        <ReportHeader header={header} />
        {header.rallies.counted === 0 ? (
          <p className="report-empty">
            No Rallies yet. Add Rallies in Annotate to see Match stats.
          </p>
        ) : (
          <>
            <div className="report-tools">
              <label>
                Break down by
                <select
                  value={by ?? ""}
                  onChange={(event) => onSplitChange(event.currentTarget.value)}
                >
                  <option value="">None</option>
                  {Object.entries(REPORT_SPLITS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <span>Rate bars show 90% Wilson intervals</span>
            </div>
            {[...groups].map((group) => (
              <div className="report-table-scroll" key={group}>
                <table className="report-table">
                  <caption>
                    <h2>{group}</h2>
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Stat</th>
                      {columns.map((column) => (
                        <th key={column.id} scope="col" className={columnClass(column)}>
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  {stats
                    .filter((stat) => stat.group === group && stat !== reasons)
                    .map((stat) => (
                      <tbody key={stat.id}>
                        <StatRows
                          context={context}
                          stat={stat}
                          reasons={stat.id === "shot_outcome" ? reasons : undefined}
                        />
                      </tbody>
                    ))}
                </table>
              </div>
            ))}
          </>
        )}
      </div>
    </main>
  );
}

function ReportHeader({ header }: { header: MatchReport["header"] }) {
  const { teams, games, rallies, uncredited } = header;
  return (
    <header className="report-header">
      <div className="report-matchup">
        <p className="report-tournament">{header.tournament}</p>
        <h1>
          <span className="report-team-a">{teamLabel(teams[0])}</span>
          <span className="report-versus">vs</span>
          <span className="report-team-b">{teamLabel(teams[1])}</span>
        </h1>
        <p>
          {rallies.counted} Rallies counted · {rallies.done} Done, {rallies.in_progress} In
          progress, {rallies.empty} Empty
        </p>
        {uncredited > 0 && <p>{uncredited} observations couldn&apos;t be credited to a Team</p>}
      </div>
      {games.length > 0 && (
        <ul className="report-scores" aria-label="Game scores">
          {games.map(({ number, score }) => (
            <li key={number}>
              <span>Game {number}</span>
              {score === null ? (
                <span className="report-no-score">Score unavailable</span>
              ) : (
                <strong aria-label={`Game ${number}, ${score[0]} to ${score[1]}`}>
                  <span className="report-team-a">{score[0]}</span>
                  <span className="report-versus">–</span>
                  <span className="report-team-b">{score[1]}</span>
                </strong>
              )}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

function StatRows({
  stat,
  reasons,
  context,
}: {
  stat: ReportStat;
  reasons?: ReportStat;
  context: TableContext;
}) {
  if (stat.sub_rows === null) {
    return <ValueRows label={stat.label} stat={stat} row={stat} context={context} />;
  }
  return (
    <>
      <tr className="report-stat-heading">
        <th colSpan={context.columns.length + 1} scope="rowgroup">
          {stat.label}
        </th>
      </tr>
      {stat.rows.map((row) => (
        <Fragment key={row.id}>
          <ValueRows label={row.label} stat={stat} row={row} context={context} indent={1} />
          {reasons && <WhyRows shotType={row} reasons={reasons} context={context} />}
        </Fragment>
      ))}
    </>
  );
}

function WhyRows({
  shotType,
  reasons,
  context,
}: {
  shotType: ReportSubRow;
  reasons: ReportStat;
  context: TableContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const row = reasons.rows.find((reasonRow) => reasonRow.id === shotType.id);
  if (!row) return null;
  return (
    <>
      <tr className="report-why-heading">
        <td colSpan={context.columns.length + 1}>
          <button
            type="button"
            aria-label={`Why · ${shotType.label}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <span aria-hidden>{expanded ? "▾" : "▸"}</span> Why
          </button>
        </td>
      </tr>
      {expanded && (
        <ValueRows label={reasons.label} stat={reasons} row={row} context={context} indent={2} />
      )}
    </>
  );
}

function ValueRows({
  label,
  stat,
  row,
  context,
  indent = 0,
}: {
  label: string;
  stat: ReportStat;
  row: ReportStat | ReportSubRow;
  context: TableContext;
  indent?: number;
}) {
  const { columns, by } = context;
  if (by === undefined || !stat.splits_by.includes(by)) {
    return (
      <ValueRow label={label} stat={stat} values={row.values} context={context} indent={indent} />
    );
  }
  return (
    <>
      <tr className="report-stat-heading">
        <th colSpan={columns.length + 1} data-indent={indent}>
          {label}
        </th>
      </tr>
      {Object.entries(row.breakdowns[by] ?? {}).map(([bucket, values]) => (
        <ValueRow
          key={bucket}
          label={bucket}
          stat={stat}
          values={values}
          context={context}
          indent={indent + 1}
        />
      ))}
    </>
  );
}

function columnClass(column: Column) {
  return column.kind === "team"
    ? `report-team-column report-team-${column.teamLetter}`
    : "report-player-column";
}

function ValueRow({
  label,
  stat,
  values,
  context,
  indent,
}: {
  label: string;
  stat: ReportStat;
  values: ReportValues;
  context: TableContext;
  indent: number;
}) {
  const { columns, by } = context;
  return (
    <tr>
      <th scope="row" data-indent={indent}>
        {label}
      </th>
      {columns.map((column) => {
        const applies = stat.applies_to === "both" || stat.applies_to === column.kind;
        const skips =
          by !== undefined &&
          (!stat.splits_by.includes(by) || (by === "court_half" && column.kind === "team"));
        return (
          <td key={column.id} className={columnClass(column)}>
            {applies &&
              (skips ? (
                <span className="report-muted">doesn&apos;t split by this</span>
              ) : (
                <Value
                  value={values[column.id]}
                  kind={stat.kind}
                  countsOnly={stat.id === "outcome_reason"}
                />
              ))}
          </td>
        );
      })}
    </tr>
  );
}

function Value({
  value,
  kind,
  countsOnly,
}: {
  value?: ReportValue;
  kind: ReportStat["kind"];
  countsOnly: boolean;
}) {
  let content;
  if (value && "categories" in value) {
    content = <MixValue value={value} countsOnly={countsOnly} />;
  } else if (value && "estimate" in value) {
    content = <RateValue value={value} per100={kind === "per100"} />;
  } else if (kind === "count" || countsOnly) {
    content = value?.count ?? 0;
  } else {
    content = <span className="report-muted">0 of 0 · —</span>;
  }
  return (
    <>
      {content}
      {!!value?.left_out && <span className="report-left-out"> · {value.left_out} left out</span>}
    </>
  );
}

function RateValue({ value, per100 }: { value: ReportRate; per100: boolean }) {
  const { count, of, estimate, low, high } = value;
  if (estimate === null || low === null || high === null) {
    return (
      <span className="report-muted">
        {count} of {of} · —
      </span>
    );
  }
  const format = per100 ? PER100 : PERCENT;
  const suffix = per100 ? " per 100" : "";
  const lowText = format.format(low).replace(/%$/, "");
  const position = (estimateOnScale: number) =>
    per100 ? `${estimateOnScale}%` : `calc(${estimateOnScale} * 100%)`;
  return (
    <>
      <span>
        {count} of {of} · {format.format(estimate)}
        {suffix} ({lowText}–{format.format(high)})
      </span>
      <span className="report-rate-track" aria-hidden="true">
        <span
          className="report-rate-interval"
          style={{ left: position(low), right: `calc(100% - ${position(high)})` }}
        />
        <span className="report-rate-tick" style={{ left: position(estimate) }} />
      </span>
    </>
  );
}

function MixValue({ value, countsOnly }: { value: ReportMix; countsOnly: boolean }) {
  if (value.of === 0) return countsOnly ? 0 : <span className="report-muted">0 of 0 · —</span>;
  return (
    <div className="report-mix-track">
      {value.categories
        .filter((category) => category.count > 0)
        .map((category) => {
          const { id, label, count, estimate, low, high } = category;
          const share =
            estimate != null && low != null && high != null
              ? ` · ${PERCENT.format(estimate)} (${PERCENT.format(low)}–${PERCENT.format(high)})`
              : "";
          const description = `${label} · ${count}${share}`;
          return (
            <span key={id} data-category={id} title={description} style={{ flexGrow: count }}>
              <span aria-hidden="true">{count}</span>
              <span className="report-segment-label">{description}</span>
            </span>
          );
        })}
    </div>
  );
}
