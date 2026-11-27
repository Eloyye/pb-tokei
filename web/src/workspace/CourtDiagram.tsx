import {
  type Dispatch,
  type PointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import type { Certainty } from "../api/client";
import type { Point } from "../lib/calibrations";
import {
  clampCourtPoint,
  COURT_BOUNDS,
  COURT_UNITS_PER_FT,
  type CourtOrientation,
  courtSvgPoint,
  courtTransform,
  type CourtView,
  courtViewBox,
  FIT_COURT,
  panCourtView,
  TEAM_LABEL_STRIP,
  zoomCourtView,
} from "../lib/courtView";
import { wheelPixels, wheelZoomFactor } from "../lib/wheel";

/** Feet from the net to SVG `y`: the far end is up. */
function Y(feet: number): number {
  return -feet * COURT_UNITS_PER_FT;
}

function X(feet: number): number {
  return feet * COURT_UNITS_PER_FT;
}

export interface CourtNavigation {
  orientation: CourtOrientation;
  view: CourtView;
  setView: Dispatch<SetStateAction<CourtView>>;
  consumeSpaceForPan: () => boolean;
  toggleOrientation: () => void;
}

type CourtDrag =
  | { kind: "pan"; pointerId: number; last: Point }
  | {
      kind: "player";
      pointerId: number;
      playerId: string;
      start: Point;
      from: Point;
      alreadySelected: boolean;
    };

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

/** How far in from the playing area's edge a pinned dot is drawn: a little over its radius. */
const DOT_INSET_FT = 1.2;
const DOUBLE_CLICK_MS = 500;
const SIDES = [-1, 1] as const;

/**
 * A top-down Court with run-off out to the barriers. The Main View camera's end (negative y)
 * is at the bottom in vertical orientation and on the right in horizontal orientation.
 * Shaded bands show Frontcourt (0–9 ft), Midcourt (9–18 ft), and Backcourt (18 ft and beyond).
 * The 12 ft ticks mark where an Established Team stops being Established.
 */
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
  navigation,
  placementTarget,
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
  navigation?: CourtNavigation;
  /** Changing Shots invalidates a pending landing click. Live clicks capture their own frame. */
  placementTarget?: object;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const surroundRef = useRef<SVGRectElement>(null);
  const dragRef = useRef<CourtDrag | null>(null);
  const pendingClick = useRef<{
    timer: number;
    target: typeof placementTarget;
    playerId: typeof selectedPlayerId;
    orientation: CourtOrientation;
  } | null>(null);
  const [playerDrag, setPlayerDrag] = useState<{ id: string; at: Point } | null>(null);
  const [panning, setPanning] = useState(false);
  const orientation = navigation?.orientation ?? "vertical";
  const view = navigation?.view ?? FIT_COURT;
  const setView = navigation?.setView;
  const horizontal = orientation === "horizontal";
  const box = courtViewBox(orientation);
  const transform = courtTransform(orientation, view);

  const selectedPlayer = players.find((p) => p.id === selectedPlayerId);
  const canClickToPlace =
    interactive &&
    Boolean(onPlaceOnCourt) &&
    selectedPlayer !== undefined &&
    selectedPlayer.certainty === "unknown";

  const clearPendingClick = useCallback(() => {
    if (pendingClick.current === null) return;
    window.clearTimeout(pendingClick.current.timer);
    pendingClick.current = null;
  }, []);
  useEffect(() => {
    const pending = pendingClick.current;
    if (
      pending &&
      (pending.target !== placementTarget ||
        pending.playerId !== selectedPlayerId ||
        pending.orientation !== orientation)
    ) {
      clearPendingClick();
    }
  }, [clearPendingClick, placementTarget, selectedPlayerId, orientation]);
  useEffect(() => clearPendingClick, [clearPendingClick]);

  const onWheel = useEffectEvent((event: WheelEvent, svg: SVGSVGElement) => {
    if (!setView) return;
    event.preventDefault();
    if (dragRef.current) return;
    const rect = svg.getBoundingClientRect();
    const anchor = courtSvgPoint(orientation, rect, { x: event.clientX, y: event.clientY });
    if (!anchor) return;
    const { y } = wheelPixels(event, rect.width, rect.height);
    const factor = wheelZoomFactor(y, event.ctrlKey);
    setView((current) => zoomCourtView(orientation, current, factor, anchor));
  });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const listener = (event: WheelEvent) => onWheel(event, svg);
    svg.addEventListener("wheel", listener, { passive: false });
    return () => svg.removeEventListener("wheel", listener);
  }, []);

  function pointerPoint(event: PointerEvent<SVGSVGElement>) {
    return courtSvgPoint(orientation, event.currentTarget.getBoundingClientRect(), {
      x: event.clientX,
      y: event.clientY,
    });
  }

  function endDrag(event: PointerEvent<SVGSVGElement>, commit: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.kind === "pan") {
      setPanning(false);
      return;
    }
    setPlayerDrag(null);
    if (!commit) return;
    if (event.clientX === drag.start.x && event.clientY === drag.start.y) {
      if (drag.alreadySelected) onSelectPlayer?.(drag.playerId);
      return;
    }
    const at = pointerPoint(event);
    if (!at) return;
    const point = transform.toCourt(at);
    if (point.x !== drag.from.x || point.y !== drag.from.y) onMovePlayer?.(drag.playerId, point);
  }

  const dots = players.map((player, index) => {
    const active = playerDrag?.id === player.id ? playerDrag : null;
    const unknown =
      !active && (player.certainty === "unknown" || player.x === null || player.y === null);
    const at = active
      ? active.at
      : unknown
        ? UNKNOWN_SLOTS[index % UNKNOWN_SLOTS.length]!
        : clampCourtPoint({ x: player.x!, y: player.y! }, DOT_INSET_FT);
    return { player, at, unknown, dragging: active !== null };
  });

  const guide = (x: number, y: number, text: string, className = "label") => (
    <text
      className={className}
      {...transform.toSvg({ x, y })}
      textAnchor={horizontal ? "middle" : "start"}
      dominantBaseline="central"
    >
      {text}
    </text>
  );
  const teamName = (name: string, team: string, end: -1 | 1) => {
    const at = transform.toSvg({ x: 0, y: end * COURT_BOUNDS.y });
    const offset = (-end * TEAM_LABEL_STRIP[orientation]) / 2;
    const x = at.x + (horizontal ? offset : 0);
    const y = at.y + (horizontal ? 0 : offset);
    const names = horizontal ? name.split(" / ") : [name];
    return (
      <text className={`label team-${team}`} textAnchor="middle" dominantBaseline="central">
        {names.map((player, i) => (
          <tspan key={i} x={x} y={y + (i - (names.length - 1) / 2) * 11}>
            {player}
          </tspan>
        ))}
      </text>
    );
  };

  return (
    <svg
      ref={svgRef}
      className={`court ${canClickToPlace ? "placing" : ""} ${onClickCourt ? "landing-click" : ""} ${panning ? "panning" : ""}`}
      viewBox={`${-box.width / 2} ${-box.height / 2} ${box.width} ${box.height}`}
      data-orientation={orientation}
      role="img"
      aria-label="Court diagram"
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const pt = pointerPoint(event);
        if (!pt) return;
        if (drag.kind === "pan") {
          const delta = { x: pt.x - drag.last.x, y: pt.y - drag.last.y };
          drag.last = pt;
          setView?.((current) => panCourtView(orientation, current, delta));
        } else {
          setPlayerDrag({ id: drag.playerId, at: transform.toCourt(pt) });
        }
      }}
      onPointerDown={(event) => {
        if (dragRef.current || (event.button !== 0 && event.button !== 1)) return;
        clearPendingClick();
        const pt = pointerPoint(event);
        if (!pt) return;
        if (setView && (navigation?.consumeSpaceForPan() || event.button === 1)) {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { kind: "pan", pointerId: event.pointerId, last: pt };
          setPanning(true);
          return;
        }
        if (event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        const playerId = target?.closest("[data-player-id]")?.getAttribute("data-player-id");
        const dot = playerId ? dots.find(({ player }) => player.id === playerId) : undefined;
        if (dot) {
          const alreadySelected = dot.player.id === selectedPlayerId;
          if (!alreadySelected) onSelectPlayer?.(dot.player.id);
          if (interactive && onMovePlayer) {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            dragRef.current = {
              kind: "player",
              pointerId: event.pointerId,
              playerId: dot.player.id,
              start: { x: event.clientX, y: event.clientY },
              from: dot.at,
              alreadySelected,
            };
          } else if (alreadySelected) {
            onSelectPlayer?.(dot.player.id);
          }
          return;
        }
        const place = onClickCourt ?? (canClickToPlace ? onPlaceOnCourt : undefined);
        if (!place) return;
        const at = transform.toCourt(pt);
        if (setView && target === surroundRef.current) {
          // A second click on the surround may be Fit. Keep the callback for the clicked frame.
          pendingClick.current = {
            target: placementTarget,
            playerId: selectedPlayerId,
            orientation,
            timer: window.setTimeout(() => {
              pendingClick.current = null;
              place(at);
            }, DOUBLE_CLICK_MS),
          };
        } else {
          place(at);
        }
      }}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => {
        clearPendingClick();
        endDrag(event, false);
      }}
      onLostPointerCapture={(event) => endDrag(event, false)}
    >
      <g transform={transform.svg}>
        <rect
          ref={surroundRef}
          className="surround"
          x={X(-COURT_BOUNDS.x)}
          y={Y(COURT_BOUNDS.y)}
          width={X(2 * COURT_BOUNDS.x)}
          height={X(2 * COURT_BOUNDS.y)}
          onDoubleClick={() => {
            clearPendingClick();
            setView?.(FIT_COURT);
          }}
        />
        {SIDES.map((s) => (
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
          </g>
        ))}
        <rect className="line" x={-100} y={-220} width={200} height={440} />
        <line className="line" x1={-100} y1={-70} x2={100} y2={-70} />
        <line className="line" x1={-100} y1={70} x2={100} y2={70} />
        <line className="line" x1={0} y1={-220} x2={0} y2={-70} />
        <line className="line" x1={0} y1={70} x2={0} y2={220} />
        <line className="net" x1={-110} y1={0} x2={110} y2={0} />
        {landing && landing.from && (
          <path
            className="traj"
            d={`M ${X(landing.from.x)} ${Y(landing.from.y)} Q ${(X(landing.from.x) + X(landing.x)) / 2} ${Math.min(Y(landing.from.y), Y(landing.y)) - 30} ${X(landing.x)} ${Y(landing.y)}`}
          />
        )}
      </g>
      {SIDES.map((s) => (
        <g key={s}>
          {guide(10.8, s * 12, "12")}
          {guide(-13.4, s * 9, "9")}
          {guide(-13.8, s * 18, "18")}
          {guide(-9.4, s * 4.5, "FC", "zone-label")}
          {guide(-9.4, s * 13.5, "MC", "zone-label")}
          {guide(-9.4, s * 20, "BC", "zone-label")}
        </g>
      ))}
      {teamName(nearTeam, nearTeamKey, -1)}
      {teamName(farTeam, nearTeamKey === "a" ? "b" : "a", 1)}
      {ghosts.map((g) => {
        const { x, y } = transform.toSvg(clampCourtPoint(g, DOT_INSET_FT));
        return (
          <circle
            key={`ghost-${g.id}`}
            className="ghost"
            cx={x}
            cy={y}
            r={9}
            style={{ fill: `var(--team-${g.team})` }}
          />
        );
      })}
      {landing && (
        <g
          className={`landing team-${landing.team ?? "none"}`}
          transform={translate(transform.toSvg(landing))}
          aria-label="Landing"
        >
          <line x1={-5} y1={-5} x2={5} y2={5} />
          <line x1={-5} y1={5} x2={5} y2={-5} />
        </g>
      )}
      {dots.map(({ player: p, at, unknown, dragging }) => {
        const inferred = !dragging && p.certainty === "inferred";
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
            transform={translate(transform.toSvg(at))}
            data-player-id={p.id}
            data-certainty={p.certainty}
          >
            <title>
              {p.name}
              {unknown
                ? " (Unknown — drag onto court to place)"
                : ` (${(dragging ? at.x : p.x!).toFixed(1)}, ${(dragging ? at.y : p.y!).toFixed(1)} ft, ${p.certainty})`}
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

function translate({ x, y }: Point): string {
  return `translate(${x}, ${y})`;
}
