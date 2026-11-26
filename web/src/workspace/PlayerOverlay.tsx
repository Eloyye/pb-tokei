import { type PointerEvent, type RefObject, useMemo, useState } from "react";
import type { FrameDetectionOut, MatchPlayer, PlayerTrackingFrameOut } from "../api/client";
import type { Point } from "../lib/calibrations";
import { findDetectionAtPoint, playerInitialsMap } from "../lib/players";
import { usePictureRect } from "./usePictureRect";

/**
 * Interactive Player Tracking layer over the Monitor picture (shared by `Calibrate → Players` and
 * `Annotate`). Draws detected person boxes, foot dots, and Player labels.
 *
 * Unified 1-click / 1-drag correction:
 * - Click inside a detected person box -> assigns the selected Player (`kind = identity`).
 * - Drag any Player's foot dot -> saves a `kind = position` anchor directly.
 * - Click empty court when placing an undetected Player -> saves a `kind = position` anchor.
 */
export function PlayerOverlay({
  videoRef,
  players,
  frameData,
  selectedPlayerId,
  editable,
  clickEmptyPlaces,
  onSelectPlayer,
  onAssignDetection,
  onMovePlayer,
  onBackgroundClick,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  players: readonly MatchPlayer[];
  frameData: PlayerTrackingFrameOut | undefined;
  selectedPlayerId: string | null;
  editable: boolean;
  /** When true, clicking outside any person box places `selectedPlayerId` as a position anchor. */
  clickEmptyPlaces: boolean;
  onSelectPlayer: (playerId: string) => void;
  onAssignDetection: (playerId: string, point: Point, detection: FrameDetectionOut) => void;
  onMovePlayer: (playerId: string, point: Point) => void;
  onBackgroundClick?: () => void;
}) {
  const rect = usePictureRect(videoRef);
  const [drag, setDrag] = useState<{ playerId: string; from: Point; at: Point } | null>(null);
  const initials = useMemo(() => playerInitialsMap(players), [players]);
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);

  if (!rect) return null;

  const detections = frameData?.detections ?? [];
  const trackedPlayers = frameData?.players ?? [];
  const selectedTracked = trackedPlayers.find((p) => p.player_id === selectedPlayerId);
  // In Annotate (`clickEmptyPlaces === false`), only treat an empty-court click as placement when
  // tracking has loaded and the explicitly selected Player is Unknown on this frame; otherwise a
  // click on the picture plays/pauses the video instead of writing an accidental anchor.
  const selectedKnownUnknown = selectedTracked?.position_certainty === "unknown";
  const allowEmptyPlacement =
    editable && selectedPlayerId !== null && (clickEmptyPlaces || selectedKnownUnknown);

  return (
    <div
      className={`player-layer ${allowEmptyPlacement ? "placing" : ""}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerMove={(event) => {
        if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) {
          setDrag({ ...drag, at: fraction(event) });
        }
      }}
      onPointerDown={(event) => {
        const at = fraction(event);
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
        onBackgroundClick?.();
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (drag.at.x !== drag.from.x || drag.at.y !== drag.from.y) {
          onMovePlayer(drag.playerId, drag.at);
        }
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
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
              event.stopPropagation();
              onSelectPlayer(player.id);
              if (!editable) return;
              event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
              const from = { x: ix, y: iy };
              setDrag({ playerId: player.id, from, at: from });
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
