import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { listPlayers, listTeams } from "../api/client";
import { disciplineLabel, genderLabel } from "./discipline";
import { type EditableRecord, EditRecordDialog } from "./EditRecordDialog";
import { ReportLoadError, useReportQuery } from "./reportQuery";
import { reportTeamLabel } from "./teams";
import "./report.css";

type IndexRow = {
  id: string;
  name: ReactNode;
  hand?: string;
  gender?: string;
  discipline?: string;
  matchCount: number;
  actions?: ReactNode;
};

type PlayerRecord = Extract<EditableRecord, { kind: "player" }>;

export function PlayersPage() {
  const queryClient = useQueryClient();
  const players = useReportQuery(["players"], listPlayers);
  const [editingPlayer, setEditingPlayer] = useState<PlayerRecord | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  if (players.isPending) return <p className="match-report notice">Loading Players…</p>;
  if (players.isError) {
    return <ReportLoadError error={players.error} retry={() => void players.refetch()} />;
  }
  return (
    <>
      <SubjectIndex
        title="Players"
        nameHeading="Name"
        showHandedness
        showGender
        showActions
        statusMessage={statusMessage}
        rows={players.data.map((player) => ({
          id: player.id,
          name: (
            <Link className="report-link" to="/players/$playerId" params={{ playerId: player.id }}>
              {player.name}
            </Link>
          ),
          hand: player.handedness === "left" ? "Left" : "Right",
          gender: genderLabel(player.gender),
          matchCount: player.match_count,
          actions: (
            <button
              type="button"
              className="button"
              aria-label={`Edit Player ${player.name}`}
              onClick={() =>
                setEditingPlayer({
                  kind: "player",
                  id: player.id,
                  name: player.name,
                  handedness: player.handedness,
                  gender: player.gender,
                })
              }
            >
              Edit
            </button>
          ),
        }))}
      />
      {editingPlayer && (
        <EditRecordDialog
          key={`player:${editingPlayer.id}`}
          record={editingPlayer}
          scope="global"
          onClose={() => setEditingPlayer(null)}
          onSaved={(message) => {
            setEditingPlayer(null);
            setStatusMessage(message);
            void queryClient.invalidateQueries({ queryKey: ["players"] });
            void queryClient.invalidateQueries({ queryKey: ["teams"] });
            void queryClient.invalidateQueries({ queryKey: ["matches"] });
            void queryClient.invalidateQueries({ queryKey: ["roster"] });
            void queryClient.invalidateQueries({ queryKey: ["leaderboard"] });
            void queryClient.invalidateQueries({ queryKey: ["compare"] });
          }}
        />
      )}
    </>
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
      showDiscipline
      rows={teams.data.map((team) => ({
        id: team.id,
        name: (
          <Link className="report-link" to="/teams/$teamId" params={{ teamId: team.id }}>
            {reportTeamLabel(team)}
          </Link>
        ),
        discipline: disciplineLabel(team.discipline),
        matchCount: team.match_count,
      }))}
    />
  );
}

function SubjectIndex({
  title,
  nameHeading,
  showHandedness = false,
  showGender = false,
  showDiscipline = false,
  showActions = false,
  statusMessage = null,
  rows,
}: {
  title: "Players" | "Teams";
  nameHeading: string;
  showHandedness?: boolean;
  showGender?: boolean;
  showDiscipline?: boolean;
  showActions?: boolean;
  statusMessage?: string | null;
  rows: IndexRow[];
}) {
  return (
    <main className="match-report">
      <div className="report-content subject-index">
        <header className="report-header report-matchup">
          <h1 id="subject-index-title">{title}</h1>
        </header>
        {statusMessage && <output className="edit-match-status">{statusMessage}</output>}
        {rows.length === 0 ? (
          <p className="report-empty">No {title} yet.</p>
        ) : (
          <table className="subject-list" aria-labelledby="subject-index-title">
            <thead>
              <tr>
                <th scope="col">{nameHeading}</th>
                {showHandedness && <th scope="col">Handedness</th>}
                {showGender && <th scope="col">Gender</th>}
                {showDiscipline && <th scope="col">Discipline</th>}
                <th scope="col" className="subject-number">
                  Matches
                </th>
                {showActions && <th scope="col" className="subject-actions" aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.name}</th>
                  {showHandedness && <td>{row.hand}</td>}
                  {showGender && <td>{row.gender}</td>}
                  {showDiscipline && <td>{row.discipline}</td>}
                  <td className="subject-number">{row.matchCount}</td>
                  {showActions && <td className="subject-actions">{row.actions}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
