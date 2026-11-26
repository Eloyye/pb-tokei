import type {
  AnchorKind,
  Certainty,
  FrameDetectionOut,
  Lens,
  MatchDetail,
  MatchPlayer,
  PlayerAnchor,
  PlayerTrackingFrameOut,
  TeamEnd,
  TrackedPlayerOut,
  Zone,
} from "../api/client";
import { type Point, project } from "./calibrations";

/**
 * Pure helpers for Player Tracking anchors, `team_ends`, Partner/End swaps, and Court projection.
 * Mirrors `lib/calibrations.ts` and `lib/segments.ts` so every edit is deterministic and undoable.
 */

export interface PlayerEdit {
  anchors: PlayerAnchor[];
  teamEnds: TeamEnd[];
  message: string;
  /** Suggested next Player to select (e.g. auto-advancing through unanchored Players). */
  nextSelected?: string | null;
}

const OPPOSITE_END_FLIP_Y_FT = 2.0;

/** Effective `TeamEnd` at `frame`: latest starting at or before `frame`, or else the earliest. */
export function teamEndAt(teamEnds: readonly TeamEnd[], frame: number): TeamEnd | undefined {
  const ordered = teamEnds.toSorted((a, b) => a.effective_from_frame - b.effective_from_frame);
  return ordered.findLast((te) => te.effective_from_frame <= frame) ?? ordered[0];
}

/** Which Team (`"a"` or `"b"`) is currently drawn at the near end of the Court diagram. */
export function nearTeamKeyFor(
  match: Pick<MatchDetail, "team_a_id" | "team_b_id">,
  teamEnds: readonly TeamEnd[],
  frame: number,
  trackedNearTeamId?: string | null,
): "a" | "b" {
  const activeId = teamEndAt(teamEnds, frame)?.near_team_id ?? trackedNearTeamId ?? match.team_a_id;
  return activeId === match.team_b_id ? "b" : "a";
}

/** Short 2–3 character initials for each Player in a Match, disambiguating collisions. */
export function playerInitialsMap(players: readonly MatchPlayer[]): Map<string, string> {
  const raw = players.map((p) => {
    const tokens = p.name.trim().split(/[\s]+/).filter(Boolean);
    const first = tokens[0] ?? "?";
    const last = tokens.length > 1 ? tokens[tokens.length - 1]! : "";
    const base = last
      ? `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase()
      : first.slice(0, 2).toUpperCase();
    return { id: p.id, first, last, base };
  });

  const counts = new Map<string, number>();
  for (const item of raw) counts.set(item.base, (counts.get(item.base) ?? 0) + 1);

  const result = new Map<string, string>();
  for (const item of raw) {
    if ((counts.get(item.base) ?? 0) <= 1) {
      result.set(item.id, item.base);
      continue;
    }
    const extra = item.last.slice(0, 2).toUpperCase();
    result.set(item.id, `${item.first[0]?.toUpperCase() ?? ""}${extra}`.slice(0, 3));
  }
  return result;
}

export function zoneShortLabel(zone: Zone | null): string {
  switch (zone) {
    case "frontcourt":
      return "FC";
    case "midcourt":
      return "MC";
    case "backcourt":
      return "BC";
    default:
      return "—";
  }
}

export function settledLabel(settled: boolean | null, certainty: Certainty): string {
  if (certainty === "unknown" || settled === null) return "Unknown";
  return settled ? "Settled" : "Moving";
}

/** Finds the smallest detected person box containing `point`, or null if none contains it. */
export function findDetectionAtPoint(
  detections: readonly FrameDetectionOut[],
  point: Point,
): FrameDetectionOut | null {
  let best: FrameDetectionOut | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const det of detections) {
    if (point.x >= det.x1 && point.x <= det.x2 && point.y >= det.y1 && point.y <= det.y2) {
      const area = Math.max(1e-9, (det.x2 - det.x1) * (det.y2 - det.y1));
      if (area < bestArea) {
        bestArea = area;
        best = det;
      }
    }
  }
  return best;
}

/**
 * Next Player to select after anchoring `currentId` on `frame`: prefers a Player not yet anchored
 * on `frame`, falling back to any Player not yet anchored anywhere, or `currentId` if all are done.
 */
export function nextUnanchoredPlayer(
  players: readonly MatchPlayer[],
  anchors: readonly PlayerAnchor[],
  currentId: string | null,
  frame: number,
): string | null {
  if (players.length === 0) return null;
  const anchoredOnFrame = new Set(anchors.filter((a) => a.frame === frame).map((a) => a.player_id));
  const start = currentId ? players.findIndex((p) => p.id === currentId) + 1 : 0;
  for (let i = 0; i < players.length; i++) {
    const candidate = players[(start + i) % players.length]!;
    if (!anchoredOnFrame.has(candidate.id)) return candidate.id;
  }
  return currentId ?? players[0]!.id;
}

/**
 * Saves an anchor for `playerId` on `frame`, seeding `teamEnds` if empty or flipping `teamEnds`
 * from `frame` onward if `courtY` is clearly on the opposite end.
 */
export function setPlayerAnchor(
  anchors: PlayerAnchor[],
  teamEnds: TeamEnd[],
  match: Pick<MatchDetail, "team_a_id" | "team_b_id" | "players">,
  frame: number,
  playerId: string,
  kind: AnchorKind,
  point: Point,
  courtY?: number | null,
): PlayerEdit {
  const player = match.players.find((p) => p.id === playerId);
  if (!player) return { anchors, teamEnds, message: "Select a Player first" };

  const clamped = { x: clamp01(point.x), y: clamp01(point.y) };
  const updated: PlayerAnchor = {
    frame,
    player_id: playerId,
    kind,
    image_x: clamped.x,
    image_y: clamped.y,
  };
  const nextAnchors = [
    ...anchors.filter((a) => !(a.frame === frame && a.player_id === playerId)),
    updated,
  ].toSorted((a, b) => a.frame - b.frame || a.player_id.localeCompare(b.player_id));

  let nextTeamEnds = teamEnds;
  if (courtY !== null && courtY !== undefined && Number.isFinite(courtY)) {
    const otherTeamId = player.team_id === match.team_a_id ? match.team_b_id : match.team_a_id;
    const impliedNear = courtY < 0 ? player.team_id : otherTeamId;
    if (teamEnds.length === 0 && Math.abs(courtY) >= 0.5) {
      nextTeamEnds = [{ effective_from_frame: 0, near_team_id: impliedNear }];
    } else if (Math.abs(courtY) >= OPPOSITE_END_FLIP_Y_FT) {
      const active = teamEndAt(teamEnds, frame);
      if (!active || active.near_team_id !== impliedNear) {
        nextTeamEnds = [
          ...teamEnds.filter((te) => te.effective_from_frame !== frame),
          { effective_from_frame: frame, near_team_id: impliedNear },
        ].toSorted((a, b) => a.effective_from_frame - b.effective_from_frame);
      }
    }
  }

  const nextSelected =
    kind === "identity"
      ? nextUnanchoredPlayer(match.players, nextAnchors, playerId, frame)
      : playerId;
  const verb = kind === "identity" ? "anchored" : "positioned";
  return {
    anchors: nextAnchors,
    teamEnds: nextTeamEnds,
    message: `${player.name} ${verb} on frame ${frame}`,
    nextSelected,
  };
}

export function deletePlayerAnchor(
  anchors: PlayerAnchor[],
  teamEnds: TeamEnd[],
  frame: number,
  playerId: string,
  playerName?: string,
): PlayerEdit {
  const nextAnchors = anchors.filter((a) => !(a.frame === frame && a.player_id === playerId));
  if (nextAnchors.length === anchors.length) {
    return { anchors, teamEnds, message: "Anchor already removed" };
  }
  return {
    anchors: nextAnchors,
    teamEnds,
    message: `Removed ${playerName ?? "Player"} anchor on frame ${frame}`,
  };
}

/**
 * 1-click Swap A / Swap B acting from `frame` forward: writes coordinate anchors swapping the two
 * partners' current image positions on `frame` (preserving `identity` kind inside detection boxes).
 */
export function swapTeamPartners(
  anchors: PlayerAnchor[],
  teamEnds: TeamEnd[],
  match: Pick<MatchDetail, "players">,
  team: "a" | "b",
  frame: number,
  frameData: PlayerTrackingFrameOut | undefined,
): PlayerEdit {
  const teammates = match.players.filter((p) => p.team === team);
  if (teammates.length !== 2) {
    return { anchors, teamEnds, message: `Team ${team.toUpperCase()} needs two Players to swap` };
  }
  const [p1, p2] = teammates as [MatchPlayer, MatchPlayer];
  const pt1 = currentImagePointFor(p1.id, frame, anchors, frameData);
  const pt2 = currentImagePointFor(p2.id, frame, anchors, frameData);
  if (!pt1 || !pt2) {
    return {
      anchors,
      teamEnds,
      message: `Both Team ${team.toUpperCase()} Players need positions on frame ${frame} to swap`,
    };
  }
  const detections = frameData?.detections ?? [];
  const kindFor1: AnchorKind = findDetectionAtPoint(detections, pt2) ? "identity" : "position";
  const kindFor2: AnchorKind = findDetectionAtPoint(detections, pt1) ? "identity" : "position";

  const nextAnchors = [
    ...anchors.filter(
      (a) => !(a.frame === frame && (a.player_id === p1.id || a.player_id === p2.id)),
    ),
    { frame, player_id: p1.id, kind: kindFor1, image_x: pt2.x, image_y: pt2.y },
    { frame, player_id: p2.id, kind: kindFor2, image_x: pt1.x, image_y: pt1.y },
  ].toSorted((a, b) => a.frame - b.frame || a.player_id.localeCompare(b.player_id));

  return {
    anchors: nextAnchors,
    teamEnds,
    message: `Swapped Team ${team.toUpperCase()} (${p1.name} ↔ ${p2.name}) from frame ${frame}`,
  };
}

/**
 * 1-click Swap ends acting from `frame` forward: writes a `team_ends` record flipping which Team
 * plays at the near end (works even on frames with missing detections).
 */
export function swapTeamEnds(
  anchors: PlayerAnchor[],
  teamEnds: TeamEnd[],
  match: Pick<MatchDetail, "team_a_id" | "team_b_id" | "team_a" | "team_b">,
  frame: number,
  trackedNearTeamId?: string | null,
): PlayerEdit {
  const currentNear =
    teamEndAt(teamEnds, frame)?.near_team_id ?? trackedNearTeamId ?? match.team_a_id;
  const nextNear = currentNear === match.team_a_id ? match.team_b_id : match.team_a_id;
  const nextEnds = [
    ...teamEnds.filter((te) => te.effective_from_frame !== frame),
    { effective_from_frame: frame, near_team_id: nextNear },
  ].toSorted((a, b) => a.effective_from_frame - b.effective_from_frame);
  const label = nextNear === match.team_a_id ? match.team_a.join(" / ") : match.team_b.join(" / ");
  return {
    anchors,
    teamEnds: nextEnds,
    message: `Near end set to ${label} from frame ${frame}`,
  };
}

export function deleteTeamEnd(
  anchors: PlayerAnchor[],
  teamEnds: TeamEnd[],
  effectiveFromFrame: number,
): PlayerEdit {
  const nextEnds = teamEnds.filter((te) => te.effective_from_frame !== effectiveFromFrame);
  if (nextEnds.length === teamEnds.length) {
    return { anchors, teamEnds, message: "End change already removed" };
  }
  return {
    anchors,
    teamEnds: nextEnds,
    message: `Removed end change at frame ${effectiveFromFrame}`,
  };
}

/** Projects a court point `(x, y)` in feet into normalised image coordinates `[0, 1]^2`. */
export function courtPointToImage(
  courtPt: Point,
  courtToImage: number[][] | null | undefined,
  lens?: Lens | null,
): Point | null {
  if (!courtToImage) return null;
  const mapped = project(courtToImage, courtPt, lens);
  if (!mapped || !Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)) return null;
  if (mapped.x < 0 || mapped.x > 1 || mapped.y < 0 || mapped.y > 1) return null;
  return mapped;
}

/** Inverts a `3x3` court-to-image matrix (with optional lens undistortion) to estimate court `y`. */
export function imagePointToCourt(
  imagePt: Point,
  courtToImage: number[][] | null | undefined,
  lens?: Lens | null,
): Point | null {
  if (!courtToImage) return null;
  const inv = invert3x3(courtToImage);
  if (!inv) return null;
  let ux = imagePt.x;
  let uy = imagePt.y;
  if (lens && lens.k1 !== 0) {
    const dx = ux - 0.5;
    const dy = uy - 0.5;
    const a2 = lens.aspect * lens.aspect;
    const r2 = (4 * (dx * dx * a2 + dy * dy)) / (a2 + 1);
    const scale = 1 + lens.k1 * r2;
    ux = 0.5 + dx * scale;
    uy = 0.5 + dy * scale;
  }
  const [r0, r1, r2] = inv as [number[], number[], number[]];
  const w = r2[0]! * ux + r2[1]! * uy + r2[2]!;
  if (Math.abs(w) < 1e-9) return null;
  const x = (r0[0]! * ux + r0[1]! * uy + r0[2]!) / w;
  const y = (r1[0]! * ux + r1[1]! * uy + r1[2]!) / w;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function currentImagePointFor(
  playerId: string,
  frame: number,
  anchors: readonly PlayerAnchor[],
  frameData: PlayerTrackingFrameOut | undefined,
): Point | null {
  const tracked: TrackedPlayerOut | undefined = frameData?.players.find(
    (p) => p.player_id === playerId,
  );
  if (tracked && tracked.image_x !== null && tracked.image_y !== null) {
    return { x: tracked.image_x, y: tracked.image_y };
  }
  const anchor = anchors.find((a) => a.frame === frame && a.player_id === playerId);
  if (anchor) return { x: anchor.image_x, y: anchor.image_y };
  return null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function invert3x3(m: number[][]): number[][] | null {
  const a = m[0]?.[0] ?? 0;
  const b = m[0]?.[1] ?? 0;
  const c = m[0]?.[2] ?? 0;
  const d = m[1]?.[0] ?? 0;
  const e = m[1]?.[1] ?? 0;
  const f = m[1]?.[2] ?? 0;
  const g = m[2]?.[0] ?? 0;
  const h = m[2]?.[1] ?? 0;
  const i = m[2]?.[2] ?? 0;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  return [
    [A / det, D / det, G / det],
    [B / det, E / det, H / det],
    [C / det, F / det, I / det],
  ];
}
