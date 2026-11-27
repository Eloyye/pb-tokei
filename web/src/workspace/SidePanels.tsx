import { type ReactNode, useMemo } from "react";
import type { MatchDetail, PlayerTrackingFrameOut, Shot, TeamEnd } from "../api/client";
import type { Point } from "../lib/calibrations";
import { formatTimecode } from "../lib/frames";
import type { CourtSlot } from "../lib/layout";
import { nearTeamKeyFor, playerInitialsMap } from "../lib/players";
import { teamKey, type Roster } from "../lib/rallyLog";
import {
  type CourtGhost,
  CourtDiagram,
  type CourtLanding,
  type CourtNavigation,
  type CourtPlayerDot,
} from "./CourtDiagram";
import { CourtViewControls } from "./CourtViewControls";
import { Panel, PanelTitle } from "./Panel";

/**
 * The Court diagram. With a Shot selected it shows that Shot's recorded positions (the hitter
 * ringed, the previous Shot's as ghosts, the landing as a ✕): clicking the court sets the
 * landing and dragging a dot edits that Shot only. Otherwise it shows live tracked Players at the
 * playhead, with drag-to-place anchor fixes.
 */
export function CourtPanel({
  match,
  focused,
  frame = 0,
  frameData,
  teamEnds = [],
  selectedPlayerId = null,
  onSelectPlayer,
  onDeselectPlayer,
  onMovePlayer,
  onPlaceOnCourt,
  roster,
  shot,
  previousShot,
  onSetLanding,
  onMoveShotPlayer,
  onDeselectShot,
  slot = "side",
  navigation,
  swapButton,
}: {
  match: MatchDetail;
  focused: boolean;
  frame?: number;
  frameData?: PlayerTrackingFrameOut;
  teamEnds?: readonly TeamEnd[];
  selectedPlayerId?: string | null;
  onSelectPlayer?: (playerId: string) => void;
  onDeselectPlayer?: () => void;
  onMovePlayer?: (playerId: string, courtPoint: Point) => void;
  onPlaceOnCourt?: (courtPoint: Point) => void;
  roster?: Roster;
  /** The selected Shot, if any: its recorded positions replace live tracking. */
  shot?: Shot;
  previousShot?: Shot;
  onSetLanding?: (courtPoint: Point) => void;
  onMoveShotPlayer?: (playerId: string, courtPoint: Point) => void;
  /** Deselects the current Shot so the diagram returns to live Player Tracking. */
  onDeselectShot?: () => void;
  slot?: CourtSlot;
  navigation?: CourtNavigation;
  swapButton?: ReactNode;
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
    if (shot) {
      const position = shot.positions[p.id]?.position;
      return {
        id: p.id,
        name: p.name,
        initials: initials.get(p.id) ?? "?",
        team: p.team,
        x: position?.value?.x ?? null,
        y: position?.value?.y ?? null,
        certainty: position?.certainty ?? "unknown",
        selected: p.id === selectedPlayerId,
        hitter: shot.hitter_id.value === p.id,
      };
    }
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
  const ghosts: CourtGhost[] = previousShot
    ? match.players.flatMap((p) => {
        const at = previousShot.positions[p.id]?.position.value;
        return at ? [{ id: p.id, team: p.team, x: at.x, y: at.y }] : [];
      })
    : [];
  const hitter = shot?.hitter_id.value ?? null;
  const landingPoint = shot?.landing.value ?? null;
  const landing: CourtLanding | null =
    shot && landingPoint
      ? {
          ...landingPoint,
          team: roster
            ? teamKey(roster, match.players.find((p) => p.id === hitter)?.team_id ?? null)
            : null,
          from: (hitter !== null && shot.positions[hitter]?.position.value) || null,
        }
      : null;

  return (
    <Panel
      id="court"
      focused={focused}
      className={`area-${slot}`}
      tabs={<PanelTitle>Court</PanelTitle>}
      tools={
        <>
          <span className={`court-mode ${shot ? "" : "live"}`} title="Near end = Main View camera">
            {shot ? (
              <>
                Shot {shot.shot_number.value ?? "?"} ·{" "}
                {shot.contact_frame.value === null ? (
                  "contact Unknown"
                ) : (
                  <>
                    contact <span className="mono">{formatTimecode(shot.contact_frame.value)}</span>
                  </>
                )}
              </>
            ) : (
              <>
                Live · <span className="mono">{formatTimecode(frame)}</span>
              </>
            )}
          </span>
          {shot && onDeselectShot && (
            <button
              type="button"
              className="icon-button court-live-button"
              data-court-control
              title="Deselect Shot to show live Player Tracking (Esc)"
              onClick={onDeselectShot}
            >
              Live
            </button>
          )}
          <span className="court-panel-actions">
            {navigation && <CourtViewControls navigation={navigation} />}
            {swapButton}
          </span>
        </>
      }
    >
      <div className="court-wrap">
        <CourtDiagram
          nearTeam={nearLabel}
          farTeam={farLabel}
          nearTeamKey={nearKey}
          players={dots}
          interactive={shot ? Boolean(onMoveShotPlayer) : Boolean(onMovePlayer)}
          selectedPlayerId={selectedPlayerId}
          onSelectPlayer={onSelectPlayer}
          onDeselectPlayer={onDeselectPlayer}
          onMovePlayer={shot ? onMoveShotPlayer : onMovePlayer}
          onPlaceOnCourt={shot ? undefined : onPlaceOnCourt}
          ghosts={ghosts}
          landing={landing}
          onClickCourt={shot ? onSetLanding : undefined}
          navigation={navigation}
          placementTarget={shot}
        />
        <div className="court-note">
          {shot
            ? "Click the court or Monitor to set the landing; drag a dot to fix this Shot's position"
            : anyKnown
              ? "Drag any Player dot to override position"
              : "Track and anchor Players in Calibrate → Players, or drag dots onto the court"}
        </div>
      </div>
    </Panel>
  );
}
