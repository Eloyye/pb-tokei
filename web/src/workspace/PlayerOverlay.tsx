import { type PointerEvent, type RefObject, useMemo, useState } from "react";
import type { FrameDetectionOut, MatchPlayer, PlayerTrackingFrameOut } from "../api/client";
import type { Point } from "../lib/calibrations";
import { findDetectionAtPoint, playerInitialsMap } from "../lib/players";
import { usePictureRect } from "./usePictureRect";

export interface MonitorLanding {
  /** Projected normalised image coordinates `[0, 1]^2` on the playhead frame. */
  at: Point;
  /** Hitter's Team colour, or null when the hitter is Unknown. */
  team: "a" | "b" | null;
}

/**
 * Interactive layer over the Monitor picture (shared by `Calibrate → Players` and `Annotate`).
 * Draws detected person boxes, foot dots, and Player labels (when `showPlayers` is true), plus
 * the selected Shot's projected landing ✕ in Annotate.
 *
 * Unified 1-click / 1-drag interaction:
 * - `Alt`+click (with a Shot selected) -> always sets the Shot's landing, even over a Player.
 * - Click inside a detected person box (with a Player selected) -> assigns (`kind = identity`).
 * - Drag any Player's foot dot -> saves a `kind = position` anchor directly.
 * - Click empty court when placing an undetected Player -> saves a `kind = position` anchor.
 * - Plain click elsewhere with a Shot selected -> sets the Shot's landing; otherwise plays/pauses.
 */
export function PlayerOverlay({
  videoRef,
  players,
  frameData,
  selectedPlayerId,
  editable,
  showPlayers = true,
  clickEmptyPlaces,
  landing = null,
  landingMapped = false,
  onSetLanding,
  onSelectPlayer,
  onDeselectPlayer,
  onAssignDetection,
  onMovePlayer,
  onBackgroundClick,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  players: readonly MatchPlayer[];
  frameData: PlayerTrackingFrameOut | undefined;
  selectedPlayerId: string | null;
  editable: boolean;
  /** Whether Player detection boxes and foot dots are visible and interactive. */
  showPlayers?: boolean;
  /** When true, clicking outside any person box places `selectedPlayerId` as a position anchor. */
  clickEmptyPlaces: boolean;
  /** The selected Shot's landing projected onto the playhead frame, if mapped and in-frame. */
  landing?: MonitorLanding | null;
  /** Whether the playhead frame has a court mapping (shows the landing crosshair cursor). */
  landingMapped?: boolean;
  /** Fired when a click or `Alt`+click on the Monitor sets the selected Shot's landing. */
  onSetLanding?: (imagePoint: Point) => void;
  onSelectPlayer: (playerId: string) => void;
  /** When set, clicking the already-selected Player dot without dragging deselects them. */
  onDeselectPlayer?: () => void;
  onAssignDetection: (playerId: string, point: Point, detection: FrameDetectionOut) => void;
  onMovePlayer: (playerId: string, point: Point) => void;
  onBackgroundClick?: () => void;
}) {
  const rect = usePictureRect(videoRef);
  const [drag, setDrag] = useState<{
    pointerId: number;
    playerId: string;
    from: Point;
    at: Point;
    moved: boolean;
    alreadySelected: boolean;
  } | null>(null);
  const initials = useMemo(() => playerInitialsMap(players), [players]);
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  if (!rect) return null;

  const detections = showPlayers ? (frameData?.detections ?? []) : [];
  const trackedPlayers = showPlayers ? (frameData?.players ?? []) : [];
  const selectedTracked = trackedPlayers.find((p) => p.player_id === selectedPlayerId);
  // In Annotate (`clickEmptyPlaces === false`), only treat an empty-court click as placement when
  // tracking has loaded and the explicitly selected Player is Unknown on this frame; otherwise a
  // click sets the landing (with a Shot selected) or plays/pauses the video.
  const selectedKnownUnknown = selectedTracked?.position_certainty === "unknown";
  const allowEmptyPlacement =
    showPlayers &&
    editable &&
    selectedPlayerId !== null &&
    (clickEmptyPlaces || selectedKnownUnknown);

  return (
    <div
      className={`player-layer ${allowEmptyPlacement ? "placing" : onSetLanding && landingMapped ? "landing-click" : ""}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerMove={(event) => {
        if (
          drag &&
          drag.pointerId === event.pointerId &&
          event.currentTarget.hasPointerCapture?.(event.pointerId)
        ) {
          setDrag({ ...drag, at: fraction(event), moved: true });
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const at = fraction(event);
        if (event.altKey && onSetLanding) {
          event.stopPropagation();
          onSetLanding(at);
          return;
        }
        if (showPlayers) {
          // Detection boxes only have a Player action when a Player is selected for binding;
          // otherwise clicks inside a box fall through to landing/background (foot dots handle
          // their own selection and dragging above).
          const hit = findDetectionAtPoint(detections, at);
          if (hit && editable && selectedPlayerId) {
            event.stopPropagation();
            onAssignDetection(selectedPlayerId, at, hit);
            return;
          }
          if (allowEmptyPlacement && selectedPlayerId) {
            event.stopPropagation();
            onMovePlayer(selectedPlayerId, at);
            return;
          }
        }
        if (onSetLanding) {
          event.stopPropagation();
          onSetLanding(at);
          return;
        }
        onBackgroundClick?.();
      }}
      onPointerUp={(event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        if (drag.moved && (drag.at.x !== drag.from.x || drag.at.y !== drag.from.y)) {
          onMovePlayer(drag.playerId, drag.at);
        } else if (drag.alreadySelected) {
          onDeselectPlayer?.();
        }
        setDrag(null);
      }}
      onPointerCancel={(event) => {
        if (drag?.pointerId === event.pointerId) setDrag(null);
      }}
      onLostPointerCapture={(event) => {
        if (drag?.pointerId === event.pointerId) setDrag(null);
      }}
    >
      {detections.map((det, idx) => {
        const assigned = det.player_id ? playerById.get(det.player_id) : undefined;
        const teamClass = assigned ? `team-${assigned.team}` : "unassigned";
        const isSelected = assigned?.id === selectedPlayerId;
        return (
          <div
            key={`${idx}-${det.x1.toFixed(3)}-${det.y1.toFixed(3)}`}
            className={`player-box ${teamClass} ${isSelected ? "selected" : ""} ${det.feet_cropped ? "cropped" : ""}`}
            style={{
              left: `${det.x1 * 100}%`,
              top: `${det.y1 * 100}%`,
              width: `${(det.x2 - det.x1) * 100}%`,
              height: `${(det.y2 - det.y1) * 100}%`,
            }}
            title={
              assigned
                ? `${assigned.name} (${Math.round(det.score * 100)}%) — click to assign selected Player`
                : `Detected person (${Math.round(det.score * 100)}%) — click to assign selected Player`
            }
          >
            <span
              className="player-box-foot"
              style={{
                left: `${((det.foot_x - det.x1) / Math.max(1e-4, det.x2 - det.x1)) * 100}%`,
                top: `${((det.foot_y - det.y1) / Math.max(1e-4, det.y2 - det.y1)) * 100}%`,
              }}
            />
          </div>
        );
      })}
      {landing && (
        <svg
          className={`monitor-landing team-${landing.team ?? "none"}`}
          style={{ left: `${landing.at.x * 100}%`, top: `${landing.at.y * 100}%` }}
          viewBox="-9 -9 18 18"
          role="img"
          aria-label="Landing"
        >
          <g className="halo">
            <line x1={-6} y1={-6} x2={6} y2={6} />
            <line x1={-6} y1={6} x2={6} y2={-6} />
          </g>
          <g className="mark">
            <line x1={-6} y1={-6} x2={6} y2={6} />
            <line x1={-6} y1={6} x2={6} y2={-6} />
          </g>
        </svg>
      )}
      {trackedPlayers.map((tp) => {
        const player = playerById.get(tp.player_id);
        if (!player) return null;
        const activeDrag = drag?.playerId === player.id ? drag : null;
        const ix = activeDrag ? activeDrag.at.x : tp.image_x;
        const iy = activeDrag ? activeDrag.at.y : tp.image_y;
        if (ix === null || iy === null) return null;
        const label = initials.get(player.id) ?? "?";
        const inferred = tp.position_certainty === "inferred";
        const isSelected = player.id === selectedPlayerId;
        return (
          <button
            key={player.id}
            type="button"
            className={`player-dot team-${player.team} ${inferred ? "inferred" : ""} ${isSelected ? "selected" : ""} ${tp.anchor_kind ? "anchored" : ""}`}
            style={{ left: `${ix * 100}%`, top: `${iy * 100}%` }}
            aria-label={`${player.name} foot position`}
            title={`${player.name} (${tp.position_certainty}${tp.anchor_kind ? `, ${tp.anchor_kind} anchor` : ""}) — drag to move`}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (event.altKey && onSetLanding) return;
              event.stopPropagation();
              if (!isSelected) onSelectPlayer(player.id);
              if (!editable) {
                if (isSelected) onDeselectPlayer?.();
                return;
              }
              event.currentTarget.parentElement?.setPointerCapture?.(event.pointerId);
              const from = { x: ix, y: iy };
              setDrag({
                pointerId: event.pointerId,
                playerId: player.id,
                from,
                at: from,
                moved: false,
                alreadySelected: isSelected,
              });
            }}
          >
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function fraction(event: PointerEvent<HTMLElement>): Point {
  const box = event.currentTarget.closest(".player-layer")!.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
  };
}
