import { useMemo, useState } from "react";
import type { MatchDetail, PlayerTrackingFrameOut, TeamEnd } from "../api/client";
import type { Point } from "../lib/calibrations";
import { nearTeamKeyFor, playerInitialsMap } from "../lib/players";
import { CourtDiagram, type CourtPlayerDot } from "./CourtDiagram";
import { Panel, PanelTitle } from "./Panel";

/** Court diagram showing live tracked Players at the playhead, with drag-to-place fixes. */
export function CourtPanel({
  match,
  focused,
  frame = 0,
  frameData,
  teamEnds = [],
  selectedPlayerId = null,
  onSelectPlayer,
  onMovePlayer,
  onPlaceOnCourt,
}: {
  match: MatchDetail;
  focused: boolean;
  frame?: number;
  frameData?: PlayerTrackingFrameOut;
  teamEnds?: readonly TeamEnd[];
  selectedPlayerId?: string | null;
  onSelectPlayer?: (playerId: string) => void;
  onMovePlayer?: (playerId: string, courtPoint: Point) => void;
  onPlaceOnCourt?: (courtPoint: Point) => void;
}) {
  const initials = useMemo(() => playerInitialsMap(match.players), [match.players]);
  const trackedById = useMemo(
    () => new Map((frameData?.players ?? []).map((p) => [p.player_id, p])),
    [frameData],
  );
  const nearKey = nearTeamKeyFor(match, teamEnds, frame, frameData?.near_team_id);
  const nearLabel = nearKey === "a" ? match.team_a.join(" / ") : match.team_b.join(" / ");
  const farLabel = nearKey === "a" ? match.team_b.join(" / ") : match.team_a.join(" / ");

  const dots: CourtPlayerDot[] = match.players.map((p) => {
    const tp = trackedById.get(p.id);
    return {
      id: p.id,
      name: p.name,
      initials: initials.get(p.id) ?? "?",
      team: p.team,
      x: tp?.position_x ?? null,
      y: tp?.position_y ?? null,
      certainty: tp?.position_certainty ?? "unknown",
      selected: p.id === selectedPlayerId,
    };
  });
  const anyKnown = dots.some((d) => d.certainty !== "unknown");

  return (
    <Panel
      id="court"
      focused={focused}
      tabs={<PanelTitle>Court</PanelTitle>}
      tools={<span>near end = Main View camera</span>}
    >
      <div className="court-wrap">
        <CourtDiagram
          nearTeam={nearLabel}
          farTeam={farLabel}
          nearTeamKey={nearKey}
          players={dots}
          interactive={Boolean(onMovePlayer)}
          selectedPlayerId={selectedPlayerId}
          onSelectPlayer={onSelectPlayer}
          onMovePlayer={onMovePlayer}
          onPlaceOnCourt={onPlaceOnCourt}
        />
        <div className="court-note">
          {anyKnown
            ? "Drag any Player dot to override position"
            : "Track and anchor Players in Calibrate → Players, or drag dots onto the court"}
        </div>
      </div>
    </Panel>
  );
}

type InspectorTab = "shot" | "rally";

/** Properties of the current Shot or Rally. Empty until Rally and Shot entry exists. */
export function InspectorPanel({ focused }: { focused: boolean }) {
  const [tab, setTab] = useState<InspectorTab>("shot");
  return (
    <Panel
      id="inspector"
      focused={focused}
      tabs={
        <div role="tablist" aria-label="Inspector" style={{ display: "flex" }}>
          {(["shot", "rally"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`panel-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "shot" ? "Shot" : "Rally"}
            </button>
          ))}
        </div>
      }
    >
      <div className="panel-body" role="tabpanel">
        {tab === "shot" ? (
          <p className="empty">
            <strong>No Shot selected.</strong> The current Shot's Hitter, Shot Class, Contact Kind,
            Zone, Erne, ATP, landing and Error will show here, each marked Observed, Inferred or
            Unknown.
          </p>
        ) : (
          <p className="empty">
            <strong>No Rally selected.</strong> The current Rally's frames, score, Serving Team,
            Server, Returner, Referee Call, Challenge and winner will show here.
          </p>
        )}
      </div>
    </Panel>
  );
}

export function RalliesPanel({ focused }: { focused: boolean }) {
  return (
    <Panel
      id="rallies"
      focused={focused}
      className="area-rallies"
      tabs={<PanelTitle>Rallies</PanelTitle>}
      tools={<span className="mono">0</span>}
    >
      <div className="panel-body">
        <p className="empty">
          No Rallies yet. They will be listed here by Game, with status, score and issues.
        </p>
      </div>
    </Panel>
  );
}
