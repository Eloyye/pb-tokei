import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { listPlayers, listTeams } from "../api/client";
import { ReportLoadError, useReportQuery } from "./reportQuery";
import { reportTeamLabel } from "./teams";
import "./report.css";

type IndexRow = { id: string; name: ReactNode; hand?: string; matchCount: number };

export function PlayersPage() {
  const players = useReportQuery(["players"], listPlayers);
  if (players.isPending) return <p className="match-report notice">Loading Players…</p>;
  if (players.isError) {
    return <ReportLoadError error={players.error} retry={() => void players.refetch()} />;
  }
  return (
    <SubjectIndex
      title="Players"
      nameHeading="Name"
      showHandedness
      rows={players.data.map((player) => ({
        id: player.id,
        name: (
          <Link className="report-link" to="/players/$playerId" params={{ playerId: player.id }}>
            {player.name}
          </Link>
        ),
        hand: player.handedness === "left" ? "Left" : "Right",
        matchCount: player.match_count,
      }))}
    />
  );
}

export function TeamsPage() {
  const teams = useReportQuery(["teams"], listTeams);
  if (teams.isPending) return <p className="match-report notice">Loading Teams…</p>;
  if (teams.isError) {
    return <ReportLoadError error={teams.error} retry={() => void teams.refetch()} />;
  }
  return (
    <SubjectIndex
      title="Teams"
      nameHeading="Team"
      rows={teams.data.map((team) => ({
        id: team.id,
        name: (
          <Link className="report-link" to="/teams/$teamId" params={{ teamId: team.id }}>
            {reportTeamLabel(team)}
          </Link>
        ),
        matchCount: team.match_count,
      }))}
    />
  );
}

function SubjectIndex({
  title,
  nameHeading,
  showHandedness = false,
  rows,
}: {
  title: "Players" | "Teams";
  nameHeading: string;
  showHandedness?: boolean;
  rows: IndexRow[];
}) {
  return (
    <main className="match-report">
      <div className="report-content subject-index">
        <header className="report-header report-matchup">
          <h1 id="subject-index-title">{title}</h1>
        </header>
        {rows.length === 0 ? (
          <p className="report-empty">No {title} yet.</p>
        ) : (
          <table className="subject-list" aria-labelledby="subject-index-title">
            <thead>
              <tr>
                <th scope="col">{nameHeading}</th>
                {showHandedness && <th scope="col">Handedness</th>}
                <th scope="col" className="subject-number">
                  Matches
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.name}</th>
                  {showHandedness && <td>{row.hand}</td>}
                  <td className="subject-number">{row.matchCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
