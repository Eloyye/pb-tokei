import { type PointerEvent, useRef, useState } from "react";
import type { Certainty } from "../api/client";
import type { Point } from "../lib/calibrations";

/**
 * A top-down court in feet, 10 SVG units to the foot. The near end (negative `y`, the Main View
 * camera's end) is at the bottom so it lines up with the video. Zone bands are shaded:
 * Frontcourt 0–9 ft, Midcourt 9–18 ft, Backcourt 18 ft and beyond; ticks mark 12 ft, where an
 * Established Team stops being Established.
 */
/** Feet from the net to SVG `y`: the far end is up. */
function Y(feet: number): number {
  return -feet * 10;
}

function X(feet: number): number {
  return feet * 10;
}

export interface CourtPlayerDot {
  id: string;
  name: string;
  initials: string;
  team: "a" | "b";
  x: number | null;
  y: number | null;
  certainty: Certainty;
  selected?: boolean;
  /** The selected Shot's hitter: drawn with a white ring. */
  hitter?: boolean;
}

/** A faint dot: where a Player stood at the previous Shot. */
export interface CourtGhost {
  id: string;
  team: "a" | "b";
  x: number;
  y: number;
}

/** A Shot's landing, drawn as a ✕ in the hitter's Team colour with a dashed arc from them. */
export interface CourtLanding {
  x: number;
  y: number;
  team: "a" | "b" | null;
  from: Point | null;
}

/** Parking slots outside the right sideline for Players whose position is Unknown. */
const UNKNOWN_SLOTS: readonly Point[] = [
  { x: 12.2, y: -15.5 },
  { x: 12.2, y: -9.5 },
  { x: 12.2, y: 9.5 },
  { x: 12.2, y: 15.5 },
];

const VIEW_X = -140;
const VIEW_Y = -250;
const VIEW_W = 280;
const VIEW_H = 500;

/**
 * Keeps a point inside the drawn area (a dot's radius in from the edge). A Player standing
 * further back than the diagram shows, such as a returner well behind the baseline, is drawn at
 * its edge rather than off it; their title still gives the real position.
 */
function inView(point: Point): Point {
  const maxX = (VIEW_X + VIEW_W) / 10 - 1.2;
  const maxY = (VIEW_Y + VIEW_H) / 10 - 1.2;
  return {
    x: Math.max(-maxX, Math.min(maxX, point.x)),
    y: Math.max(-maxY, Math.min(maxY, point.y)),
  };
}

export function CourtDiagram({
  nearTeam,
  farTeam,
  nearTeamKey = "a",
  players = [],
  interactive = false,
  selectedPlayerId = null,
  onSelectPlayer,
  onMovePlayer,
  onPlaceOnCourt,
  ghosts = [],
  landing = null,
  onClickCourt,
}: {
  nearTeam: string;
  farTeam: string;
  /** Which Team (`"a"` or `"b"`) is currently at the near end, colouring the end labels. */
  nearTeamKey?: "a" | "b";
  players?: readonly CourtPlayerDot[];
  interactive?: boolean;
  selectedPlayerId?: string | null;
  onSelectPlayer?: (playerId: string) => void;
  /** Fired when a Player dot is dragged to a new court position (in feet). */
  onMovePlayer?: (playerId: string, courtPoint: Point) => void;
  /** Fired when empty court is clicked while placing an undetected Player. */
  onPlaceOnCourt?: (courtPoint: Point) => void;
  ghosts?: readonly CourtGhost[];
  landing?: CourtLanding | null;
  /** Fired when the court (not a dot) is clicked, e.g. to set a Shot's landing. */
  onClickCourt?: (courtPoint: Point) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ playerId: string; from: Point; at: Point } | null>(null);
  const sides = [-1, 1] as const;
  const nearClass = nearTeamKey === "a" ? "team-a" : "team-b";
  const farClass = nearTeamKey === "a" ? "team-b" : "team-a";

  const selectedPlayer = players.find((p) => p.id === selectedPlayerId);
  const canClickToPlace =
    interactive &&
    Boolean(onPlaceOnCourt) &&
    selectedPlayer !== undefined &&
    selectedPlayer.certainty === "unknown";

  const clientToCourt = (event: PointerEvent<SVGSVGElement>): Point | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    // Account for default SVG preserveAspectRatio="xMidYMid meet".
    const scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
    const drawnW = VIEW_W * scale;
    const drawnH = VIEW_H * scale;
    const offsetX = rect.left + (rect.width - drawnW) / 2;
    const offsetY = rect.top + (rect.height - drawnH) / 2;
    const svgX = VIEW_X + (event.clientX - offsetX) / scale;
    const svgY = VIEW_Y + (event.clientY - offsetY) / scale;
    return {
      x: Math.max(-16, Math.min(16, svgX / 10)),
      y: Math.max(-32, Math.min(32, -svgY / 10)),
    };
  };

  return (
    <svg
      ref={svgRef}
      className={`court ${interactive ? "interactive" : ""} ${canClickToPlace ? "placing" : ""} ${onClickCourt ? "landing-click" : ""}`}
      viewBox={`${VIEW_X} ${VIEW_Y} ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label="Court diagram"
      onPointerMove={(event) => {
        if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const pt = clientToCourt(event);
        if (pt) setDrag({ ...drag, at: pt });
      }}
      onPointerDown={(event) => {
        const pt = clientToCourt(event);
        if (!pt) return;
        if (onClickCourt) return onClickCourt(pt);
        if (canClickToPlace && onPlaceOnCourt) onPlaceOnCourt(pt);
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (drag.at.x !== drag.from.x || drag.at.y !== drag.from.y) {
          onMovePlayer?.(drag.playerId, drag.at);
        }
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      <rect className="surround" x={VIEW_X} y={VIEW_Y} width={VIEW_W} height={VIEW_H} />
      {sides.map((s) => (
        <g key={s}>
          <rect
            className="zone-bc"
            x={-100}
            y={Math.min(Y(s * 18), Y(s * 22))}
            width={200}
            height={40}
          />
          <rect
            className="zone-mc"
            x={-100}
            y={Math.min(Y(s * 9), Y(s * 18))}
            width={200}
            height={90}
          />
          <rect className="zone-fc" x={-100} y={Math.min(0, Y(s * 9))} width={200} height={90} />
          {[9, 18].map((d) => (
            <line key={d} className="band" x1={-100} y1={Y(s * d)} x2={100} y2={Y(s * d)} />
          ))}
          <line className="line" x1={-106} y1={Y(s * 12)} x2={-100} y2={Y(s * 12)} />
          <line className="line" x1={100} y1={Y(s * 12)} x2={106} y2={Y(s * 12)} />
          <text className="label" x={108} y={Y(s * 12) + 3}>
            12
          </text>
          <text className="label" x={-134} y={Y(s * 9) + 3}>
            9
          </text>
          <text className="label" x={-138} y={Y(s * 18) + 3}>
            18
          </text>
          <text className="zone-label" x={-94} y={Y(s * 4.5) + 3}>
            FC
          </text>
          <text className="zone-label" x={-94} y={Y(s * 13.5) + 3}>
            MC
          </text>
          <text className="zone-label" x={-94} y={Y(s * 20) + 3}>
            BC
          </text>
        </g>
      ))}
      <rect className="line" x={-100} y={-220} width={200} height={440} />
      <line className="line" x1={-100} y1={-70} x2={100} y2={-70} />
      <line className="line" x1={-100} y1={70} x2={100} y2={70} />
      <line className="line" x1={0} y1={-220} x2={0} y2={-70} />
      <line className="line" x1={0} y1={70} x2={0} y2={220} />
      <line className="net" x1={-110} y1={0} x2={110} y2={0} />
      <text className={`label ${nearClass}`} x={0} y={Y(-23.6) + 4} textAnchor="middle">
        {nearTeam}
      </text>
      <text className={`label ${farClass}`} x={0} y={Y(23.6) + 4} textAnchor="middle">
        {farTeam}
      </text>
      {ghosts.map((g) => (
        <circle
          key={`ghost-${g.id}`}
          className="ghost"
          cx={X(inView(g).x)}
          cy={Y(inView(g).y)}
          r={9}
          style={{ fill: `var(--team-${g.team})` }}
        />
      ))}
      {landing && landing.from && (
        <path
          className="traj"
          d={`M ${X(landing.from.x)} ${Y(landing.from.y)} Q ${(X(landing.from.x) + X(landing.x)) / 2} ${Math.min(Y(landing.from.y), Y(landing.y)) - 30} ${X(landing.x)} ${Y(landing.y)}`}
        />
      )}
      {landing && (
        <g
          className={`landing team-${landing.team ?? "none"}`}
          transform={`translate(${X(landing.x)}, ${Y(landing.y)})`}
          aria-label="Landing"
        >
          <line x1={-5} y1={-5} x2={5} y2={5} />
          <line x1={-5} y1={5} x2={5} y2={-5} />
        </g>
      )}
      {players.map((p, idx) => {
        const activeDrag = drag?.playerId === p.id ? drag : null;
        const unknown = !activeDrag && (p.certainty === "unknown" || p.x === null || p.y === null);
        const inferred = !activeDrag && p.certainty === "inferred";
        const slot = UNKNOWN_SLOTS[idx % UNKNOWN_SLOTS.length]!;
        const shown = activeDrag ? activeDrag.at : unknown ? slot : inView({ x: p.x!, y: p.y! });
        const cx = shown.x;
        const cy = shown.y;
        const isSelected = Boolean(p.selected || p.id === selectedPlayerId);
        const classes = [
          "court-player",
          `team-${p.team}`,
          unknown ? "unknown" : inferred ? "inferred" : "observed",
          isSelected ? "selected" : "",
          p.hitter ? "hitter" : "",
          interactive ? "draggable" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <g
            key={p.id}
            className={classes}
            transform={`translate(${X(cx)}, ${Y(cy)})`}
            data-player-id={p.id}
            data-certainty={p.certainty}
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelectPlayer?.(p.id);
              if (!interactive || !onMovePlayer) return;
              svgRef.current?.setPointerCapture(event.pointerId);
              const from = { x: cx, y: cy };
              setDrag({ playerId: p.id, from, at: from });
            }}
          >
            <title>
              {p.name}
              {unknown
                ? " (Unknown — drag onto court to place)"
                : ` (${(activeDrag ? cx : p.x!).toFixed(1)}, ${(activeDrag ? cy : p.y!).toFixed(1)} ft, ${p.certainty})`}
            </title>
            <circle r={11} />
            <text y={3.5} textAnchor="middle">
              {p.initials}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
