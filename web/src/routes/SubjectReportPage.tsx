import { getRouteApi, Link } from "@tanstack/react-router";
import {
  ApiError,
  getPlayerReport,
  getTeamReport,
  type PlayerMatchFilters,
  type TeamMatchFilters,
} from "../api/client";
import type { components } from "../api/schema";
import { disciplineLabel, genderLabel } from "./discipline";
import { MatchFilterForm } from "./MatchFilterForm";
import { hasMatchFilters, matchFilterDateError } from "./matchFilters";
import { asReportSplit, matchCountLabel, type ReportSplit } from "./reportOptions";
import { ReportLoadError, useReportQuery } from "./reportQuery";
import { ReportCoverage, ReportTables, teamReportColumns, type ReportColumn } from "./ReportTables";
import { reportTeamLabel } from "./teams";

type PlayerReport = components["schemas"]["PlayerReport"];
type TeamReport = components["schemas"]["TeamReport"];
type SubjectMatch = components["schemas"]["SubjectMatch"];

const playerRoute = getRouteApi("/players/$playerId");
const teamRoute = getRouteApi("/teams/$teamId");

function loadValidReport<T>(filters: TeamMatchFilters, load: () => Promise<T>): Promise<T> {
  const dateError = matchFilterDateError(filters);
  if (dateError) return Promise.reject(new ApiError(422, dateError));
  return load();
}

export function PlayerReportPage() {
  const { playerId } = playerRoute.useParams();
  const { by, ...filters } = playerRoute.useSearch();
  const navigate = playerRoute.useNavigate();
  const report = useReportQuery(
    ["players", playerId, filters],
    (signal) => loadValidReport(filters, () => getPlayerReport(playerId, filters, signal)),
    (previous) => (previous?.profile.id === playerId ? previous : undefined),
  );
  function applyFilters(value: PlayerMatchFilters) {
    void navigate({ search: (previous) => ({ ...value, by: previous.by }) });
  }

  if (report.isPending) return <p className="match-report notice">Loading Player report…</p>;
  if (report.isError) {
    return (
      <ReportLoadError
        error={report.error}
        retry={() => void report.refetch()}
        index="/players"
        clearFilters={hasMatchFilters(filters) ? () => applyFilters({}) : undefined}
      />
    );
  }
  return (
    <SubjectReport
      key={playerId}
      report={report.data}
      by={by}
      filters={filters}
      updating={report.isPlaceholderData}
      onFiltersChange={applyFilters}
      onSplitChange={(value) =>
        void navigate({ search: (previous) => ({ ...previous, by: asReportSplit(value) }) })
      }
    />
  );
}

export function TeamReportPage() {
  const { teamId } = teamRoute.useParams();
  const { by, ...filters } = teamRoute.useSearch();
  const navigate = teamRoute.useNavigate();
  const report = useReportQuery(
    ["teams", teamId, filters],
    (signal) => loadValidReport(filters, () => getTeamReport(teamId, filters, signal)),
    (previous) => (previous?.profile.id === teamId ? previous : undefined),
  );
  function applyFilters(value: TeamMatchFilters) {
    void navigate({ search: (previous) => ({ ...value, by: previous.by }) });
  }

  if (report.isPending) return <p className="match-report notice">Loading Team report…</p>;
  if (report.isError) {
    return (
      <ReportLoadError
        error={report.error}
        retry={() => void report.refetch()}
        index="/teams"
        clearFilters={hasMatchFilters(filters) ? () => applyFilters({}) : undefined}
      />
    );
  }
  return (
    <SubjectReport
      key={teamId}
      report={report.data}
      by={by}
      filters={filters}
      updating={report.isPlaceholderData}
      onFiltersChange={applyFilters}
      onSplitChange={(value) =>
        void navigate({ search: (previous) => ({ ...previous, by: asReportSplit(value) }) })
      }
    />
  );
}

function SubjectReport({
  report,
  by,
  filters,
  updating,
  onFiltersChange,
  onSplitChange,
}: {
  report: PlayerReport | TeamReport;
  by?: ReportSplit;
  filters: PlayerMatchFilters;
  updating: boolean;
  onFiltersChange: (value: PlayerMatchFilters) => void;
  onSplitChange: (value: string) => void;
}) {
  const {
    header,
    matches,
    profile,
    stats,
    undated_matches_excluded: undated,
    unclassified_matches_excluded: unclassified,
  } = report;
  const player = "partners" in report ? report : null;
  const filtered = hasMatchFilters(filters);
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
            {player && (
              <p className="subject-profile-meta">
                <span>{player.profile.handedness === "left" ? "Left" : "Right"}-handed</span>
                <span aria-hidden="true"> · </span>
                <span>{genderLabel(player.profile.gender)}</span>
              </p>
            )}
            {teamProfile && (
              <p className="subject-profile-meta">
                <span className="pill discipline-pill">{disciplineLabel(profile.discipline)}</span>
              </p>
            )}
            <p>
              <Link
                className="button"
                to="/compare"
                search={{ kind: teamProfile ? "team" : "player", a: profile.id }}
              >
                Compare
              </Link>
            </p>
            {!updating && (
              <>
                <ReportCoverage
                  matchCount={header.match_count}
                  rallies={header.rallies}
                  uncredited={header.uncredited}
                />
                {undated > 0 && (
                  <p>{matchCountLabel(undated)} left out because of missing dates.</p>
                )}
                {unclassified > 0 && (
                  <p>{matchCountLabel(unclassified)} left out because of unknown Discipline.</p>
                )}
              </>
            )}
          </div>
          {player && !updating && <PlayerConnections player={player} />}
        </header>
        <MatchFilterForm
          filters={filters}
          options={report.filter_options}
          showPartner={player !== null}
          showDiscipline={player !== null}
          onApply={onFiltersChange}
        />
        {updating ? (
          <output className="report-empty">Updating report…</output>
        ) : (
          <>
            <SubjectMatches matches={matches} showPartner={player !== null} filtered={filtered} />
            {header.rallies.counted > 0 ? (
              <ReportTables stats={stats} columns={columns} by={by} onSplitChange={onSplitChange} />
            ) : (
              (!filtered || matches.length > 0) && (
                <p className="report-empty">
                  No Rallies yet. Add Rallies in Annotate to see stats.
                </p>
              )
            )}
          </>
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
  filtered,
}: {
  matches: SubjectMatch[];
  showPartner: boolean;
  filtered: boolean;
}) {
  return (
    <section className="subject-matches" aria-labelledby="subject-matches-title">
      <h2 id="subject-matches-title">Matches</h2>
      {matches.length === 0 ? (
        <p className="report-empty">
          {filtered ? "No Matches match these filters" : "No Matches yet."}
        </p>
      ) : (
        <div className="subject-list-scroll">
          <table className="subject-list" aria-labelledby="subject-matches-title">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Tournament</th>
                {showPartner && <th scope="col">Discipline</th>}
                {showPartner && <th scope="col">Partner</th>}
                <th scope="col">Opponents</th>
                <th scope="col">Game scores</th>
                <th scope="col">Rallies</th>
                <th scope="col">Match Report</th>
              </tr>
            </thead>
            <tbody>
              {matches.map(
                ({ id, date, tournament, discipline, partner, opponents, games, rallies }) => (
                  <tr key={id}>
                    <td className="subject-date">
                      {date ? <time dateTime={date}>{date}</time> : "—"}
                    </td>
                    <th scope="row">{tournament}</th>
                    {showPartner && <td>{disciplineLabel(discipline)}</td>}
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
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
