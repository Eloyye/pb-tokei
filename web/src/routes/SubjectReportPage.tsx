import { getRouteApi, Link } from "@tanstack/react-router";
import { getPlayerReport, getTeamReport } from "../api/client";
import type { components } from "../api/schema";
import { asReportSplit, matchCountLabel, type ReportSplit } from "./reportOptions";
import { ReportLoadError, useReportQuery } from "./reportQuery";
import { ReportCoverage, ReportTables, teamReportColumns, type ReportColumn } from "./ReportTables";
import { reportTeamLabel } from "./teams";

type PlayerReport = components["schemas"]["PlayerReport"];
type TeamReport = components["schemas"]["TeamReport"];
type SubjectMatch = components["schemas"]["SubjectMatch"];

const playerRoute = getRouteApi("/players/$playerId");
const teamRoute = getRouteApi("/teams/$teamId");

export function PlayerReportPage() {
  const { playerId } = playerRoute.useParams();
  const { by } = playerRoute.useSearch();
  const navigate = playerRoute.useNavigate();
  const report = useReportQuery(["players", playerId], (signal) =>
    getPlayerReport(playerId, signal),
  );
  if (report.isPending) return <p className="match-report notice">Loading Player report…</p>;
  if (report.isError) {
    return (
      <ReportLoadError error={report.error} retry={() => void report.refetch()} index="/players" />
    );
  }
  return (
    <SubjectReport
      key={playerId}
      report={report.data}
      by={by}
      onSplitChange={(value) => void navigate({ search: { by: asReportSplit(value) } })}
    />
  );
}

export function TeamReportPage() {
  const { teamId } = teamRoute.useParams();
  const { by } = teamRoute.useSearch();
  const navigate = teamRoute.useNavigate();
  const report = useReportQuery(["teams", teamId], (signal) => getTeamReport(teamId, signal));
  if (report.isPending) return <p className="match-report notice">Loading Team report…</p>;
  if (report.isError) {
    return (
      <ReportLoadError error={report.error} retry={() => void report.refetch()} index="/teams" />
    );
  }
  return (
    <SubjectReport
      key={teamId}
      report={report.data}
      by={by}
      onSplitChange={(value) => void navigate({ search: { by: asReportSplit(value) } })}
    />
  );
}

function SubjectReport({
  report,
  by,
  onSplitChange,
}: {
  report: PlayerReport | TeamReport;
  by?: ReportSplit;
  onSplitChange: (value: string) => void;
}) {
  const { header, matches, profile, stats } = report;
  const player = "partners" in report ? report : null;
  const teamProfile = "players" in profile;
  const title = teamProfile ? reportTeamLabel(profile) : profile.name;
  const columns: ReportColumn[] = teamProfile
    ? teamReportColumns(profile, "a", false)
    : [{ id: profile.id, label: profile.name, kind: "player" }];

  return (
    <main className="match-report">
      <div className="report-content">
        <header className="report-header">
          <div className="report-matchup">
            <h1>{title}</h1>
            {player && <p>{player.profile.handedness === "left" ? "Left" : "Right"}-handed</p>}
            <ReportCoverage
              matchCount={header.match_count}
              rallies={header.rallies}
              uncredited={header.uncredited}
            />
          </div>
          {player && <PlayerConnections player={player} />}
        </header>
        <SubjectMatches matches={matches} showPartner={player !== null} />
        {header.rallies.counted === 0 ? (
          <p className="report-empty">No Rallies yet. Add Rallies in Annotate to see stats.</p>
        ) : (
          <ReportTables stats={stats} columns={columns} by={by} onSplitChange={onSplitChange} />
        )}
      </div>
    </main>
  );
}

function PlayerConnections({ player }: { player: PlayerReport }) {
  const { played_for, partners } = player;
  if (played_for.length === 0 && partners.length === 0) return null;

  return (
    <div className="subject-connections">
      {partners.length > 0 && (
        <section aria-labelledby="report-partners">
          <h2 id="report-partners">Partners</h2>
          <ul>
            {partners.map(({ player: partner, team, match_count: count }) => (
              <li key={team.id}>
                <Link className="report-link" to="/teams/$teamId" params={{ teamId: team.id }}>
                  {partner.name}
                </Link>{" "}
                <span>({matchCountLabel(count)})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {played_for.length > 0 && (
        <section aria-labelledby="report-franchises">
          <h2 id="report-franchises">Played for</h2>
          <ul>
            {played_for.map((franchise) => (
              <li key={franchise.id}>
                <strong>{franchise.name}</strong>
                <ul>
                  {franchise.tournaments.map((tournament) => (
                    <li key={tournament.id}>
                      {tournament.name} ({matchCountLabel(tournament.match_count)})
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SubjectMatches({
  matches,
  showPartner,
}: {
  matches: SubjectMatch[];
  showPartner: boolean;
}) {
  return (
    <section className="subject-matches" aria-labelledby="subject-matches-title">
      <h2 id="subject-matches-title">Matches</h2>
      {matches.length === 0 ? (
        <p className="report-empty">No Matches yet.</p>
      ) : (
        <div className="subject-list-scroll">
          <table className="subject-list" aria-labelledby="subject-matches-title">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Tournament</th>
                {showPartner && <th scope="col">Partner</th>}
                <th scope="col">Opponents</th>
                <th scope="col">Game scores</th>
                <th scope="col">Rallies</th>
                <th scope="col">Match Report</th>
              </tr>
            </thead>
            <tbody>
              {matches.map(({ id, date, tournament, partner, opponents, games, rallies }) => (
                <tr key={id}>
                  <td className="subject-date">
                    {date ? <time dateTime={date}>{date}</time> : "—"}
                  </td>
                  <th scope="row">{tournament}</th>
                  {showPartner && <td>{partner?.name}</td>}
                  <td>{reportTeamLabel(opponents)}</td>
                  <td>
                    {games.length === 0 ? (
                      "—"
                    ) : (
                      <ul className="subject-scores">
                        {games.map(({ number, score }) => (
                          <li key={number}>
                            <span className="report-segment-label">Game {number}: </span>
                            {score === null ? "—" : score.join("–")}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td>
                    {rallies.counted === 0
                      ? "No Rallies yet"
                      : `${rallies.done} Done / ${rallies.in_progress} In progress / ${rallies.empty} Empty`}
                  </td>
                  <td>
                    <Link
                      to="/matches/$matchId/$workspace"
                      params={{ matchId: id, workspace: "report" }}
                      className="report-link"
                    >
                      Report
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
