import type { Game, RallyStatus } from "../api/client";
import type { Selection } from "../lib/annotate";
import { formatScore, type Roster, teamKey } from "../lib/rallyLog";
import { countIssuesByRally, rallyIssueKey, type RuleIssue } from "../lib/ruleChecks";
import type { OpenContextMenu } from "./contextMenuItems";
import { Panel, PanelTitle } from "./Panel";

const STATUS_MARK: Record<RallyStatus, string> = { empty: "○", in_progress: "●", done: "✓" };
const STATUS_LABEL: Record<RallyStatus, string> = {
  empty: "Empty",
  in_progress: "In progress",
  done: "Done",
};

/**
 * The Match's Rallies grouped by Game: status, number, the Serving Team's colour and the score
 * called. Clicking a row (or `PgUp`/`PgDn`) moves to that Rally.
 */
export function RalliesPanel({
  focused,
  games,
  selection,
  roster,
  issues,
  onSelectRally,
  onContextMenu,
  onSelectGame,
  onAddUnseen,
  onAddGame,
  onDeleteGame,
}: {
  focused: boolean;
  games: readonly Game[];
  selection: Selection;
  roster: Roster;
  issues?: readonly RuleIssue[];
  onSelectRally: (game: number, rally: number) => void;
  onContextMenu?: OpenContextMenu;
  onSelectGame: (game: number) => void;
  onAddUnseen: () => void;
  onAddGame: () => void;
  onDeleteGame: (game: number) => void;
}) {
  const all = games.flatMap((g) => g.rallies);
  const done = all.filter((r) => r.status === "done").length;
  const countsByRally = issues ? countIssuesByRally(issues) : null;
  return (
    <Panel
      id="rallies"
      focused={focused}
      className="area-rallies"
      tabs={<PanelTitle>Rallies</PanelTitle>}
      tools={
        <span className="rallies-tools" style={{ display: "contents" }}>
          <span className="mono" title="Rallies Done out of all Rallies">
            {done} / {all.length}
          </span>
          <button
            type="button"
            className="icon-button"
            title="Insert an Unseen Rally after this one (Shift+U)"
            onClick={onAddUnseen}
          >
            + Unseen
          </button>
          <button
            type="button"
            className="icon-button"
            title="Start the next Game (Shift+Enter)"
            onClick={onAddGame}
          >
            + Game
          </button>
        </span>
      }
    >
      <div className="rally-list" aria-label="Rallies">
        {games.length === 0 && (
          <p className="empty">
            No Rallies yet. Press <kbd>⇧I</kbd> at a Serve to start Game 1's first Rally.
          </p>
        )}
        {games.map((game, gi) => (
          <div key={game.number}>
            <div className={`game-h ${gi === selection.game ? "active" : ""}`}>
              <button
                type="button"
                onClick={() => onSelectGame(gi)}
                title="Make this the active Game"
              >
                Game {game.number}
              </button>
              <span>
                {game.rallies.length === 0 ? (
                  <button
                    type="button"
                    title={`Delete the empty Game ${game.number}`}
                    aria-label={`Delete Game ${game.number}`}
                    onClick={() => onDeleteGame(gi)}
                  >
                    ×
                  </button>
                ) : (
                  `${game.rallies.filter((r) => r.status === "done").length}/${game.rallies.length}`
                )}
              </span>
            </div>
            {game.rallies.map((rally, ri) => {
              const team = teamKey(roster, rally.serving_team_id.value);
              const on = gi === selection.game && ri === selection.rally;
              const counts = countsByRally?.get(rallyIssueKey(gi, ri));
              const hasIssues = Boolean(counts && (counts.red > 0 || counts.amber > 0));
              return (
                <button
                  key={ri}
                  type="button"
                  aria-pressed={on}
                  className={`r-row ${on ? "on" : ""}`}
                  onClick={() => onSelectRally(gi, ri)}
                  onContextMenu={(event) =>
                    onContextMenu?.(event, { kind: "rally", game: gi, rally: ri })
                  }
                  title={`${STATUS_LABEL[rally.status]}${rally.start_frame === null ? " · Unseen" : ""}${on ? " · click to deselect" : ""}`}
                >
                  <span className={`st ${rally.status}`}>{STATUS_MARK[rally.status]}</span>
                  <span className="num">R{rally.number}</span>
                  <span className={`sc ${rally.score.value === null ? "unk" : ""}`}>
                    <span className={`swatch ${team ? `team-${team}` : "unknown"}`} />
                    {formatScore(rally.score)}
                  </span>
                  <span className="r-meta">
                    <span className="frames">
                      {rally.start_frame === null
                        ? "unseen"
                        : `${rally.start_frame}–${rally.end_frame ?? "…"}`}
                    </span>
                    {hasIssues && counts && (
                      <span className="iss">
                        {counts.red > 0 && (
                          <span
                            className="red"
                            title={`${counts.red} red ${counts.red === 1 ? "issue" : "issues"}`}
                          >
                            {counts.red}
                          </span>
                        )}
                        {counts.amber > 0 && (
                          <span
                            className="amber"
                            title={`${counts.amber} amber ${counts.amber === 1 ? "issue" : "issues"}`}
                          >
                            {counts.amber}
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </Panel>
  );
}
