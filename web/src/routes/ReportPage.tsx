import { getRouteApi } from "@tanstack/react-router";
import { getMatchReport } from "../api/client";
import type { components } from "../api/schema";
import { disciplineLabel } from "./discipline";
import { asReportSplit, type ReportSplit } from "./reportOptions";
import { ReportLoadError, useReportQuery } from "./reportQuery";
import { ReportCoverage, ReportTables, teamReportColumns } from "./ReportTables";
import { reportTeamLabel } from "./teams";

type MatchReport = components["schemas"]["MatchReport"];
const route = getRouteApi("/matches/$matchId/$workspace");

export function ReportPage({ matchId }: { matchId: string }) {
  const { by } = route.useSearch();
  const navigate = route.useNavigate();
  const report = useReportQuery(["match-report", matchId], (signal) =>
    getMatchReport(matchId, signal),
  );

  if (report.isPending) return <p className="match-report notice">Loading Match report…</p>;
  if (report.isError) {
    return <ReportLoadError error={report.error} retry={() => void report.refetch()} />;
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
  const columns = [
    ...teamReportColumns(header.teams[0], "a", true),
    ...teamReportColumns(header.teams[1], "b", true),
  ];

  return (
    <main className="match-report">
      <div className="report-content">
        <ReportHeader header={header} />
        {header.rallies.counted === 0 ? (
          <p className="report-empty">
            No Rallies yet. Add Rallies in Annotate to see Match stats.
          </p>
        ) : (
          <ReportTables stats={stats} columns={columns} by={by} onSplitChange={onSplitChange} />
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
        <p className="report-tournament">
          {header.tournament}
          <span className="report-meta-sep" aria-hidden="true">
            {" "}
            ·{" "}
          </span>
          <span className="report-discipline">{disciplineLabel(header.discipline)}</span>
        </p>
        <h1>
          <span className="report-team-a">{reportTeamLabel(teams[0])}</span>
          <span className="report-versus">vs</span>
          <span className="report-team-b">{reportTeamLabel(teams[1])}</span>
        </h1>
        <ReportCoverage rallies={rallies} uncredited={uncredited} />
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
