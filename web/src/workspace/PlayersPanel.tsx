import { useMemo } from "react";
import type {
  MatchDetail,
  PlayerAnchor,
  PlayerTrackingFrameOut,
  PlayerTrackingOut,
  TeamEnd,
} from "../api/client";
import type { Point } from "../lib/calibrations";
import { nearTeamKeyFor, playerInitialsMap, settledLabel, zoneShortLabel } from "../lib/players";
import { VIEW_LABELS } from "../lib/segments";
import { CourtDiagram, type CourtPlayerDot } from "./CourtDiagram";

/**
 * `Calibrate → Players` tab: tracking trigger/cancel with active device badge & per-segment
 * status, 4-Player checklist (Zone, Settled, certainty, selection), 1-click Swap A / Swap B /
 * Swap ends controls, interactive Court diagram preview, and anchor / end-change lists.
 */
export function PlayersPanel({
  match,
  frame,
  tracking,
  frameData,
  anchors,
  teamEnds,
  selectedPlayerId,
  onSelectPlayer,
  onTrack,
  onCancelTrack,
  onSwapTeam,
  onSwapEnds,
  onMovePlayerOnCourt,
  onPlacePlayerOnCourt,
  onSeek,
  onDeleteAnchor,
  onDeleteTeamEnd,
}: {
  match: MatchDetail;
  frame: number;
  tracking: PlayerTrackingOut | null;
  frameData: PlayerTrackingFrameOut | undefined;
  anchors: readonly PlayerAnchor[];
  teamEnds: readonly TeamEnd[];
  selectedPlayerId: string | null;
  onSelectPlayer: (playerId: string) => void;
  onTrack: () => void;
  onCancelTrack: () => void;
  onSwapTeam: (team: "a" | "b") => void;
  onSwapEnds: () => void;
  onMovePlayerOnCourt: (playerId: string, courtPoint: Point) => void;
  onPlacePlayerOnCourt: (courtPoint: Point) => void;
  onSeek: (frame: number) => void;
  onDeleteAnchor: (frame: number, playerId: string) => void;
  onDeleteTeamEnd: (effectiveFromFrame: number) => void;
}) {
  const initials = useMemo(() => playerInitialsMap(match.players), [match.players]);
  const playerById = useMemo(() => new Map(match.players.map((p) => [p.id, p])), [match.players]);
  const trackedById = useMemo(
    () => new Map((frameData?.players ?? []).map((p) => [p.player_id, p])),
    [frameData],
  );

  const nearKey = nearTeamKeyFor(match, teamEnds, frame, frameData?.near_team_id);
  const nearLabel = nearKey === "a" ? match.team_a.join(" / ") : match.team_b.join(" / ");
  const farLabel = nearKey === "a" ? match.team_b.join(" / ") : match.team_a.join(" / ");

  const courtDots: CourtPlayerDot[] = match.players.map((p) => {
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

  const isTracking = tracking?.status === "tracking";
  const hasSegments = (tracking?.total_segments ?? 0) > 0;
  const videoReady = match.video_status === "ready";
  const deviceLabel = tracking?.device ? tracking.device.toUpperCase() : "CPU";

  return (
    <div className="panel-body players-panel">
      <section className="cal-view players-status">
        <h3>
          Player Tracking
          <span className="players-badges">
            <span className="device-badge" title="Active PyTorch compute device">
              {deviceLabel}
            </span>
            <span className={tracking?.status === "error" ? "flagged" : ""}>
              {statusSummary(tracking)}
            </span>
          </span>
        </h3>
        {isTracking && tracking && (
          <progress className="fetch-bar" value={tracking.progress} max={100} />
        )}
        {tracking?.status === "error" && tracking.error && (
          <p className="fit-summary flagged">{tracking.error}</p>
        )}
        <div className="players-actions">
          {isTracking ? (
            <button type="button" className="button" onClick={onCancelTrack}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="button primary"
              disabled={!videoReady || !hasSegments}
              title={
                !videoReady
                  ? "Download and convert footage first"
                  : !hasSegments
                    ? "Mark at least one Play Segment first"
                    : "Run person detection and pose estimation (prioritises the segment under the playhead)"
              }
              onClick={onTrack}
            >
              {tracking?.status === "ready" ? "Re-check Tracking" : "Track Players"}
            </button>
          )}
        </div>
        {tracking && tracking.spans.length > 0 && (
          <ul className="players-spans">
            {tracking.spans.map((span) => (
              <li key={`${span.start_frame}-${span.end_frame}`}>
                <button
                  type="button"
                  title={`Seek to ${VIEW_LABELS[span.camera_view]} frame ${span.start_frame}`}
                  onClick={() => onSeek(span.start_frame)}
                >
                  <span>
                    {VIEW_LABELS[span.camera_view]} · {span.start_frame}–{span.end_frame}
                  </span>
                  <span className={`span-status ${span.status}`}>{span.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="cal-view players-checklist">
        <h3>
          Players on frame {frame}
          <span>click a box on video to anchor</span>
        </h3>
        <div className="players-swap-bar">
          <button
            type="button"
            className="button"
            title="Swap Team A partners from the playhead forward"
            onClick={() => onSwapTeam("a")}
          >
            <span className="swatch team-a" /> Swap A
          </button>
          <button
            type="button"
            className="button"
            title="Swap Team B partners from the playhead forward"
            onClick={() => onSwapTeam("b")}
          >
            <span className="swatch team-b" /> Swap B
          </button>
          <button
            type="button"
            className="button"
            title="Flip which Team plays at the near end from the playhead forward"
            onClick={onSwapEnds}
          >
            Swap ends
          </button>
        </div>
        <ul className="players-rows">
          {match.players.map((p) => {
            const tp = trackedById.get(p.id);
            const certainty = tp?.position_certainty ?? "unknown";
            const settledCert = tp?.settled_certainty ?? "unknown";
            const settledText = settledLabel(tp?.settled ?? null, settledCert);
            const isSelected = p.id === selectedPlayerId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`player-row ${isSelected ? "selected" : ""}`}
                  aria-label={p.name}
                  aria-pressed={isSelected}
                  onClick={() => onSelectPlayer(p.id)}
                >
                  <span className="player-id-cell">
                    <span className={`swatch team-${p.team}`} />
                    <span className="mono player-initials">{initials.get(p.id)}</span>
                    <span className="player-name">{p.name}</span>
                  </span>
                  <span className="player-facts">
                    <span className={`fact-chip cert-${certainty}`}>
                      {certainty === "unknown" ? "Unknown" : zoneShortLabel(tp?.zone ?? null)}
                      {certainty === "inferred" && <span className="inf-tag">inf</span>}
                    </span>
                    <span className={`fact-chip cert-${settledCert}`}>
                      {settledText}
                      {settledCert === "inferred" && <span className="inf-tag">inf</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="cal-view players-court-preview">
        <h3>
          Court preview
          <span>drag dots to place</span>
        </h3>
        <div className="players-court-wrap">
          <CourtDiagram
            nearTeam={nearLabel}
            farTeam={farLabel}
            nearTeamKey={nearKey}
            players={courtDots}
            interactive
            selectedPlayerId={selectedPlayerId}
            onSelectPlayer={onSelectPlayer}
            onMovePlayer={onMovePlayerOnCourt}
            onPlaceOnCourt={onPlacePlayerOnCourt}
          />
        </div>
      </section>

      <section className="cal-view">
        <h3>
          Anchors <span>{anchors.length}</span>
        </h3>
        {anchors.length === 0 ? (
          <p className="empty">
            No anchors yet. Click a detected person box on the Monitor to bind the selected Player,
            or drag a Player dot onto the court.
          </p>
        ) : (
          <ul>
            {anchors.map((a) => {
              const player = playerById.get(a.player_id);
              return (
                <li key={`${a.frame}:${a.player_id}`}>
                  <button
                    type="button"
                    title={`Go to frame ${a.frame}`}
                    onClick={() => onSeek(a.frame)}
                  >
                    <span>
                      f{a.frame} · {player?.name ?? a.player_id.slice(0, 8)}
                    </span>
                    <span className="anchor-kind-tag">{a.kind}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${player?.name ?? "Player"} anchor on frame ${a.frame}`}
                    title="Delete this anchor"
                    onClick={() => onDeleteAnchor(a.frame, a.player_id)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="cal-view">
        <h3>
          End changes <span>{teamEnds.length}</span>
        </h3>
        {teamEnds.length === 0 ? (
          <p className="empty">
            Near end seeds automatically from your first anchor, or click Swap ends.
          </p>
        ) : (
          <ul>
            {teamEnds.map((te) => {
              const isA = te.near_team_id === match.team_a_id;
              const teamName = isA ? match.team_a.join(" / ") : match.team_b.join(" / ");
              return (
                <li key={te.effective_from_frame}>
                  <button
                    type="button"
                    title={`Go to frame ${te.effective_from_frame}`}
                    onClick={() => onSeek(te.effective_from_frame)}
                  >
                    <span>from frame {te.effective_from_frame}</span>
                    <span className={isA ? "team-a-text" : "team-b-text"}>near: {teamName}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete end change from frame ${te.effective_from_frame}`}
                    title="Delete this end change"
                    onClick={() => onDeleteTeamEnd(te.effective_from_frame)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function statusSummary(tracking: PlayerTrackingOut | null): string {
  if (!tracking) return "loading…";
  switch (tracking.status) {
    case "no_video":
      return "no video";
    case "tracking":
      return `tracking ${tracking.progress.toFixed(0)}%`;
    case "ready":
      return `${tracking.tracked_segments}/${tracking.total_segments} ready`;
    case "error":
      return "failed";
    default:
      return tracking.total_segments > 0
        ? `${tracking.tracked_segments}/${tracking.total_segments} tracked`
        : "no segments";
  }
}
