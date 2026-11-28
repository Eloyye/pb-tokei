import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import type { components } from "../api/schema";
import { matchCountLabel, REPORT_SPLITS, type ReportSplit } from "./reportOptions";
import { reportTeamLabel } from "./teams";
import "./report.css";

type ReportStat = components["schemas"]["ReportStat"];
type ReportSubRow = components["schemas"]["ReportSubRow"];
type ReportValues = components["schemas"]["ReportValues"];
type ReportValue = components["schemas"]["ReportValue"];
type ReportRate = components["schemas"]["ReportRate"];
type ReportMix = components["schemas"]["ReportMix"];
type ReportTeam = components["schemas"]["ReportTeam"];
type ReportRallies = components["schemas"]["ReportRallies"];
type CompareMarks = components["schemas"]["CompareMarks"];
/** A Compare stat carries which of its values are clearly different. */
type MarkedStat = ReportStat &
  Partial<Pick<components["schemas"]["CompareStat"], "marks" | "row_marks">>;

export type ReportColumn = { id: string; label: string; link?: boolean } & (
  | { kind: "team"; teamLetter: "a" | "b" }
  | { kind: "player" }
);
type TableContext = { columns: ReportColumn[]; by?: ReportSplit };

const PERCENT = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 0 });
const DECIMAL = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

export function teamReportColumns(
  team: ReportTeam,
  teamLetter: "a" | "b",
  linkTeam: boolean,
): ReportColumn[] {
  return [
    {
      id: team.id,
      label: linkTeam ? `Team: ${reportTeamLabel(team)}` : "Team",
      kind: "team",
      teamLetter,
      link: linkTeam,
    },
    ...team.players.map((player): ReportColumn => ({
      id: player.id,
      label: player.name,
      kind: "player",
      link: true,
    })),
  ];
}

export function ReportCoverage({
  rallies,
  uncredited,
  matchCount,
}: {
  rallies: ReportRallies;
  uncredited: number;
  matchCount?: number;
}) {
  return (
    <>
      <p>
        {matchCount !== undefined && `${matchCountLabel(matchCount)} · `}
        {rallies.counted} Rallies counted · {rallies.done} Done, {rallies.in_progress} In progress,{" "}
        {rallies.empty} Empty
      </p>
      {uncredited > 0 && (
        <p>
          {uncredited} observations{matchCount !== undefined && " across these Matches"}{" "}
          couldn&apos;t be credited to a Team
        </p>
      )}
    </>
  );
}

export function ReportTables({
  stats,
  columns,
  by,
  splits = Object.keys(REPORT_SPLITS) as ReportSplit[],
  onSplitChange,
}: TableContext & {
  stats: MarkedStat[];
  splits?: ReportSplit[];
  onSplitChange: (value: string) => void;
}) {
  const context = { columns, by };
  const reasons = stats.find((stat) => stat.id === "outcome_reason");
  const groups = new Set(stats.map((stat) => stat.group));
  const marked = stats.some((stat) => stat.marks !== undefined);
  return (
    <>
      <div className="report-tools">
        <label>
          Break down by
          <select value={by ?? ""} onChange={(event) => onSplitChange(event.currentTarget.value)}>
            <option value="">None</option>
            {splits.map((id) => (
              <option key={id} value={id}>
                {REPORT_SPLITS[id]}
              </option>
            ))}
          </select>
        </label>
        <span>Rate bars show 90% Wilson intervals</span>
        {marked && (
          <span>
            <span className="report-different">Clearly different</span>: the 90% intervals
            don&apos;t overlap
          </span>
        )}
      </div>
      {[...groups].map((group) => (
        <div className="report-table-scroll" key={group}>
          <table className="report-table" data-columns={columns.length}>
            <caption>
              <h2>{group}</h2>
            </caption>
            <thead>
              <tr>
                <th scope="col">Stat</th>
                {columns.map((column) => (
                  <th key={column.id} scope="col" className={columnClass(column)}>
                    <ColumnHeading column={column} />
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
  );
}

function ColumnHeading({ column }: { column: ReportColumn }) {
  if (!column.link) return column.label;
  return column.kind === "team" ? (
    <Link className="report-link" to="/teams/$teamId" params={{ teamId: column.id }}>
      {column.label}
    </Link>
  ) : (
    <Link className="report-link" to="/players/$playerId" params={{ playerId: column.id }}>
      {column.label}
    </Link>
  );
}

function StatRows({
  stat,
  reasons,
  context,
}: {
  stat: MarkedStat;
  reasons?: ReportStat;
  context: TableContext;
}) {
  if (stat.sub_rows === null) {
    return (
      <ValueRows label={stat.label} stat={stat} row={stat} context={context} marks={stat.marks} />
    );
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
          <ValueRows
            label={row.label}
            stat={stat}
            row={row}
            context={context}
            indent={1}
            marks={stat.row_marks?.[row.id]}
          />
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
  marks,
}: {
  label: string;
  stat: ReportStat;
  row: ReportStat | ReportSubRow;
  context: TableContext;
  indent?: number;
  marks?: CompareMarks;
}) {
  const { columns, by } = context;
  if (by === undefined || !stat.splits_by.includes(by)) {
    return (
      <ValueRow
        label={label}
        stat={stat}
        values={row.values}
        context={context}
        indent={indent}
        different={marks?.clearly_different}
      />
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
          different={marks?.breakdowns[by]?.includes(bucket)}
        />
      ))}
    </>
  );
}

function columnClass(column: ReportColumn) {
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
  different = false,
}: {
  label: string;
  stat: ReportStat;
  values: ReportValues;
  context: TableContext;
  indent: number;
  different?: boolean;
}) {
  const { columns, by } = context;
  return (
    <tr className={different ? "report-row-different" : undefined}>
      <th scope="row" data-indent={indent}>
        {label}
        {different && (
          <>
            {" "}
            <span className="report-different">Clearly different</span>
          </>
        )}
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
                <ReportCellValue
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

export function ReportCellValue({
  value,
  kind,
  countsOnly = false,
}: {
  value?: ReportValue;
  kind: ReportStat["kind"];
  countsOnly?: boolean;
}) {
  let content;
  if (value && "categories" in value) {
    content = <MixValue value={value} countsOnly={countsOnly} />;
  } else if (value && "estimate" in value) {
    content = <RateValue value={value} per100={kind === "per100"} />;
  } else if (value && "average" in value) {
    content = `${DECIMAL.format(value.average)} per Match (${value.count} in ${value.matches})`;
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
  const format = per100 ? DECIMAL : PERCENT;
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
