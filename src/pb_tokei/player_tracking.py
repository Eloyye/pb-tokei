"""Two-layer Player Tracking pipeline, disk cache, and `positions_at(frame)` lookup API.

Part of Tracking (ADR 0001, ADR 0006, ADR 0012): Event Processing never reads this.

Split into two rebuildable cache layers beside the Rally Log (`.pb-tokei-cache/player_tracking/`):

1. **Layer 1 (`SegmentDetections`)**: Calibration-free raw person detections, ViTPose ankle
   keypoints, and appearance embeddings sampled at `DEFAULT_DETECTION_STRIDE` (default 4 = 15 fps
   on 60 fps video, always including both Play Segment endpoints). Keyed by source video
   fingerprint, Play Segment bounds, stride, model IDs, and `METHOD_VERSION`. Tweaking Calibration
   Landmarks, re-running Camera Motion, or editing `player_anchors` / `team_ends` never re-runs
   GPU inference.
2. **Layer 2 (`MatchPlayerTracking`)**: Fast court solve projecting Layer 1 detections through
   `CourtMapping.at(frame)` (honouring ADR 0011 lens distortion), filtering non-players (referees,
   line judges, spectators), tracking within segments, propagating piecewise identities across
   anchors, live Camera View cuts, and replay gaps, applying occlusion & cropped-feet certainty
   rules, and computing `Settled` from trailing net-ward velocity.

Stacking constraint: Tracking never infers Player identity from serve/receive court boxes because
pros stack. Cross-gap narrowing uses only near/far Team ends (`y < 0` vs `y > 0`) plus appearance.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import tempfile
import threading
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from pb_tokei.calibration import CourtMapping, Homography
from pb_tokei.camera_motion import DEFAULT_CACHE_DIR_NAME, CameraMotion
from pb_tokei.player_vision import (
    APPEARANCE_DIM,
    BOTTOM_EDGE_CROP_MARGIN,
    DEFAULT_DETECTOR_MODEL_ID,
    DEFAULT_POSE_MODEL_ID,
    MIN_ANKLE_CONFIDENCE,
    DevicePreference,
    PlayerTrackingError,
    RawDetection,
    TorchVisionBackend,
    VisionBackend,
)
from pb_tokei.rally_log import (
    FRONTCOURT_MAX_Y_FT,
    UNKNOWN,
    AnchorKind,
    Calibration,
    CameraView,
    Certainty,
    CourtPoint,
    Fact,
    ImagePoint,
    MatchRoster,
    PlayerAnchor,
    PlayerId,
    PlayerPosition,
    PlaySegment,
    TeamEnd,
    TeamId,
    Zone,
    team_end_at,
    zone_for_point,
)

METHOD_VERSION = 1
"""Bump whenever Layer 1 or Layer 2 algorithms change so cached Player Tracking rebuilds."""

VIDEO_FPS = 60.0
DEFAULT_DETECTION_STRIDE = 4
"""Default detection stride on 60 fps footage (4 -> 15 fps, interpolated in between)."""

# Playing ROI and court-entry filter bounds (feet from net centre).
# `PLAYING_ROI_MAX_Y_FT` extends beyond the 22 ft baseline to 38 ft so Players standing deep
# behind the far baseline (with perspective foreshortening) are never clipped out; spectators
# behind the barriers are still rejected by `COURT_ENTRY_MAX_Y_FT` unless anchored.
PLAYING_ROI_MAX_X_FT = 16.0
PLAYING_ROI_MAX_Y_FT = 38.0
COURT_ENTRY_MAX_X_FT = 10.5
COURT_ENTRY_MAX_Y_FT = 24.0

# Occlusion and Settled velocity constants (named and ready to tune against the Gold Set, #23).
MAX_OCCLUSION_GAP_FRAMES = 30
"""Maximum mid-track occlusion gap (0.5 s at 60 fps) linearly interpolated as Inferred."""

SETTLED_WINDOW_FRAMES = 15
"""Trailing window (~0.25 s at 60 fps) over which net-ward approach velocity is measured."""

SETTLED_MIN_SPAN_FRAMES = 4
"""Minimum trailing history span required to compute a track velocity for Settled."""

SETTLED_MAX_APPROACH_SPEED_FT_S = 1.5
"""Maximum net-ward velocity `-d(|y|)/dt` (ft/s) for a Frontcourt Player to count as Settled."""

# Tracking and identity association parameters.
LIVE_CUT_MAX_GAP_FRAMES = 5
"""Maximum frame gap between Play Segments treated as a live cut (court-coordinate transfer)."""

LIVE_CUT_MAX_DIST_FT = 6.5
"""Maximum court distance (ft) accepted when transferring Player identity across a live cut."""

MANUAL_REATTACH_DIST_FT = 4.5
"""Maximum court distance (ft) for a manual `position` anchor to re-attach to a tracklet."""

_MAX_TRACK_LINK_GAP_FRAMES = MAX_OCCLUSION_GAP_FRAMES
_MAX_HUMAN_SPEED_FT_S = 22.0
_MIN_COURT_GATE_FT = 3.0
_MAX_ASSOC_COST = 1.15
_RELINK_MAX_APPEARANCE_DIST = 0.65
_SAME_PERSON_COURT_DIST_FT = 1.8
_NET_CROSS_MARGIN_FT = 1.5
_OPPOSITE_END_FLIP_Y_FT = 2.0
_DETECTOR_BATCH_SIZE = 16
_ANCHOR_BOX_MARGIN = 0.04
_CERT_UNKNOWN = 0
_CERT_OBSERVED = 1
_CERT_INFERRED = 2


class PlayerTrackingCancelledError(RuntimeError):
    """Raised when a Player Tracking job is cancelled."""


def default_player_cache_dir(db_path: Path) -> Path:
    """Where rebuildable Player Tracking caches live beside a Rally Log database (ADR 0012)."""
    return db_path.parent / DEFAULT_CACHE_DIR_NAME / "player_tracking"


def sample_frames_for_segment(
    start_frame: int, end_frame: int, stride: int = DEFAULT_DETECTION_STRIDE
) -> tuple[int, ...]:
    """Frames sampled in `[start_frame, end_frame]` at `stride`, always including both endpoints."""
    if start_frame < 0 or end_frame < start_frame:
        raise ValueError(f"Invalid segment range: {start_frame}-{end_frame}")
    if stride < 1:
        raise ValueError(f"Detection stride must be >= 1: {stride}")
    frames = list(range(start_frame, end_frame + 1, stride))
    if frames[-1] != end_frame:
        frames.append(end_frame)
    return tuple(frames)


# --- Public data models -------------------------------------------------------------------


@dataclass(frozen=True)
class SegmentDetections:
    """Layer 1 cache unit: calibration-free raw detections for one Play Segment."""

    start_frame: int
    end_frame: int
    stride: int
    detector_model: str
    pose_model: str
    sample_frames: tuple[int, ...]
    detections: Mapping[int, tuple[RawDetection, ...]]


@dataclass(frozen=True)
class FrameDetectionView:
    """One court-area person detection visible on a frame (for Monitor overlay & anchor clicks)."""

    x1: float
    y1: float
    x2: float
    y2: float
    foot_x: float
    foot_y: float
    score: float
    ankles_visible: bool
    feet_cropped: bool
    court_x: float | None = None
    court_y: float | None = None
    player_id: PlayerId | None = None


@dataclass(frozen=True)
class TrackedPlayerState:
    """One Player's resolved court position, Zone, and Settled fact on one frame."""

    player_id: PlayerId
    position: Fact[CourtPoint]
    zone: Zone | None
    settled: Fact[bool]
    image_point: ImagePoint | None = None
    bbox: tuple[float, float, float, float] | None = None
    anchor_kind: AnchorKind | None = None

    def to_player_position(self) -> PlayerPosition:
        return PlayerPosition(position=self.position, settled=self.settled)


@dataclass(frozen=True)
class FramePlayerState:
    """All four Players and visible court-area detections on one frame."""

    frame: int
    players: dict[PlayerId, TrackedPlayerState]
    detections: tuple[FrameDetectionView, ...]
    near_team_id: TeamId | None


@dataclass(frozen=True)
class _SolvedSegment:
    """Compact per-frame Layer 2 output for one Play Segment."""

    start_frame: int
    end_frame: int
    camera_view: CameraView
    stride: int
    # Per-frame player arrays, shape (N, 4), ordered by `roster.players`.
    pos_x: np.ndarray  # float32, NaN when Unknown
    pos_y: np.ndarray  # float32, NaN when Unknown
    pos_cert: np.ndarray  # uint8 (0=unknown, 1=observed, 2=inferred)
    settled_val: np.ndarray  # int8 (-1=unknown, 0=false, 1=true)
    settled_cert: np.ndarray  # uint8
    img_x: np.ndarray  # float32, NaN when unavailable
    img_y: np.ndarray  # float32, NaN when unavailable
    bbox: np.ndarray  # float32, shape (N, 4, 4), NaN when unavailable
    near_team_idx: np.ndarray  # int8, shape (N,) (-1=none, 0=team_a, 1=team_b)
    # Sampled-frame kept detections for overlay & hit testing on any frame in this segment.
    sample_frames: np.ndarray  # int32, shape (S,)
    det_offsets: np.ndarray  # int32, shape (S + 1,)
    det_boxes: np.ndarray  # float32, shape (M, 4)
    det_feet: np.ndarray  # float32, shape (M, 2)
    det_scores: np.ndarray  # float32, shape (M,)
    det_flags: np.ndarray  # uint8, shape (M,) bit0=ankles_visible, bit1=feet_cropped
    det_court: np.ndarray  # float32, shape (M, 2), NaN when unmapped
    det_track_id: np.ndarray  # int32, shape (M,)
    det_player_idx: np.ndarray  # int8, shape (M,) (-1=unassigned, 0..3=roster index)

    def contains(self, frame: int) -> bool:
        return self.start_frame <= frame <= self.end_frame


class MatchPlayerTracking:
    """Resolved per-frame Player positions, Zones, and Settled facts for a Match."""

    def __init__(
        self,
        roster: MatchRoster,
        segments: Sequence[_SolvedSegment],
        anchors: Sequence[PlayerAnchor] = (),
        effective_team_ends: Sequence[TeamEnd] = (),
    ) -> None:
        self._roster = roster
        self._players = roster.players
        self._segments = tuple(sorted(segments, key=lambda s: s.start_frame))
        self._anchors_by_key: dict[tuple[int, PlayerId], AnchorKind] = {
            (a.frame, a.player_id): a.kind for a in anchors
        }
        self._team_ends = tuple(sorted(effective_team_ends, key=lambda te: te.effective_from_frame))

    @property
    def roster(self) -> MatchRoster:
        return self._roster

    def _segment_at(self, frame: int) -> _SolvedSegment | None:
        for seg in self._segments:
            if seg.contains(frame):
                return seg
        return None

    def near_team_at(self, frame: int) -> TeamId | None:
        seg = self._segment_at(frame)
        if seg is not None:
            idx = int(seg.near_team_idx[frame - seg.start_frame])
            if idx == 0:
                return self._roster.team_a_id
            if idx == 1:
                return self._roster.team_b_id
        te = team_end_at(self._team_ends, frame)
        return None if te is None else te.near_team_id

    def positions_at(self, frame: int) -> dict[PlayerId, TrackedPlayerState]:
        """Returns all four Players' court positions, Zones, and Settled facts at `frame`."""
        seg = self._segment_at(frame)
        if seg is None:
            return {
                p.id: TrackedPlayerState(
                    player_id=p.id,
                    position=UNKNOWN,
                    zone=None,
                    settled=UNKNOWN,
                    anchor_kind=self._anchors_by_key.get((frame, p.id)),
                )
                for p in self._players
            }
        row = frame - seg.start_frame
        out: dict[PlayerId, TrackedPlayerState] = {}
        for p_idx, player in enumerate(self._players):
            pos_cert = _decode_certainty(int(seg.pos_cert[row, p_idx]))
            if pos_cert is Certainty.UNKNOWN:
                pos_fact: Fact[CourtPoint] = UNKNOWN
                zone: Zone | None = None
            else:
                pt = CourtPoint(float(seg.pos_x[row, p_idx]), float(seg.pos_y[row, p_idx]))
                pos_fact = Fact(pt, pos_cert)
                zone = zone_for_point(pt)

            set_cert = _decode_certainty(int(seg.settled_cert[row, p_idx]))
            set_raw = int(seg.settled_val[row, p_idx])
            if set_cert is Certainty.UNKNOWN or set_raw < 0:
                settled_fact: Fact[bool] = UNKNOWN
            else:
                settled_fact = Fact(bool(set_raw), set_cert)

            ix = float(seg.img_x[row, p_idx])
            iy = float(seg.img_y[row, p_idx])
            image_point = ImagePoint(ix, iy) if math.isfinite(ix) and math.isfinite(iy) else None

            bx = seg.bbox[row, p_idx]
            bbox = (
                (float(bx[0]), float(bx[1]), float(bx[2]), float(bx[3]))
                if np.all(np.isfinite(bx))
                else None
            )
            out[player.id] = TrackedPlayerState(
                player_id=player.id,
                position=pos_fact,
                zone=zone,
                settled=settled_fact,
                image_point=image_point,
                bbox=bbox,
                anchor_kind=self._anchors_by_key.get((frame, player.id)),
            )
        return out

    def detections_at(self, frame: int) -> tuple[FrameDetectionView, ...]:
        """Court-area person detections at `frame` (interpolated smoothly between stride frames)."""
        seg = self._segment_at(frame)
        if seg is None or len(seg.sample_frames) == 0:
            return ()
        samples = seg.sample_frames
        pos = int(np.searchsorted(samples, frame))
        if pos < len(samples) and int(samples[pos]) == frame:
            return _slice_detection_views(seg, pos, self._players)

        # Interpolate detections sharing a tracklet between adjacent sampled frames.
        if 0 < pos < len(samples):
            f_prev = int(samples[pos - 1])
            f_next = int(samples[pos])
            gap = f_next - f_prev
            if 0 < gap <= MAX_OCCLUSION_GAP_FRAMES:
                alpha = (frame - f_prev) / gap
                prev_map = _slice_dets_by_track(seg, pos - 1)
                next_map = _slice_dets_by_track(seg, pos)
                views: list[FrameDetectionView] = []
                for tid, d0 in prev_map.items():
                    d1 = next_map.get(tid)
                    if d1 is None:
                        continue
                    x1 = (1.0 - alpha) * d0[0] + alpha * d1[0]
                    y1 = (1.0 - alpha) * d0[1] + alpha * d1[1]
                    x2 = (1.0 - alpha) * d0[2] + alpha * d1[2]
                    y2 = (1.0 - alpha) * d0[3] + alpha * d1[3]
                    fx = (1.0 - alpha) * d0[4] + alpha * d1[4]
                    fy = (1.0 - alpha) * d0[5] + alpha * d1[5]
                    score = (1.0 - alpha) * d0[6] + alpha * d1[6]
                    ankles_vis = bool(d0[7] and d1[7])
                    cropped = bool(d0[8] or d1[8])
                    if math.isfinite(d0[9]) and math.isfinite(d1[9]):
                        cx: float | None = (1.0 - alpha) * d0[9] + alpha * d1[9]
                        cy: float | None = (1.0 - alpha) * d0[10] + alpha * d1[10]
                    else:
                        cx = cy = None
                    p_idx = d0[11] if d0[11] == d1[11] else -1
                    pid = self._players[p_idx].id if 0 <= p_idx < len(self._players) else None
                    views.append(
                        FrameDetectionView(
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                            foot_x=fx,
                            foot_y=fy,
                            score=score,
                            ankles_visible=ankles_vis,
                            feet_cropped=cropped,
                            court_x=cx,
                            court_y=cy,
                            player_id=pid,
                        )
                    )
                if views:
                    return tuple(views)

        # Fallback: nearest sampled frame within one stride.
        nearest_idx: int | None = None
        best_dist = seg.stride + 1
        for cand in (pos - 1, pos):
            if 0 <= cand < len(samples):
                dist = abs(int(samples[cand]) - frame)
                if dist < best_dist:
                    best_dist = dist
                    nearest_idx = cand
        if nearest_idx is not None:
            return _slice_detection_views(seg, nearest_idx, self._players)
        return ()

    def frame_state(self, frame: int) -> FramePlayerState:
        """All four Players, visible detections, and near Team at `frame`."""
        return FramePlayerState(
            frame=frame,
            players=self.positions_at(frame),
            detections=self.detections_at(frame),
            near_team_id=self.near_team_at(frame),
        )


def positions_at(tracking: MatchPlayerTracking, frame: int) -> dict[PlayerId, TrackedPlayerState]:
    """Convenience lookup returning all four Players' positions, Zones, and Settled facts."""
    return tracking.positions_at(frame)


def _slice_detection_views(
    seg: _SolvedSegment, sample_idx: int, players: tuple[Any, ...]
) -> tuple[FrameDetectionView, ...]:
    start = int(seg.det_offsets[sample_idx])
    end = int(seg.det_offsets[sample_idx + 1])
    out: list[FrameDetectionView] = []
    for k in range(start, end):
        flags = int(seg.det_flags[k])
        cx = float(seg.det_court[k, 0])
        cy = float(seg.det_court[k, 1])
        p_idx = int(seg.det_player_idx[k])
        pid = players[p_idx].id if 0 <= p_idx < len(players) else None
        out.append(
            FrameDetectionView(
                x1=float(seg.det_boxes[k, 0]),
                y1=float(seg.det_boxes[k, 1]),
                x2=float(seg.det_boxes[k, 2]),
                y2=float(seg.det_boxes[k, 3]),
                foot_x=float(seg.det_feet[k, 0]),
                foot_y=float(seg.det_feet[k, 1]),
                score=float(seg.det_scores[k]),
                ankles_visible=bool(flags & 1),
                feet_cropped=bool(flags & 2),
                court_x=cx if math.isfinite(cx) else None,
                court_y=cy if math.isfinite(cy) else None,
                player_id=pid,
            )
        )
    return tuple(out)


def _slice_dets_by_track(
    seg: _SolvedSegment, sample_idx: int
) -> dict[
    int, tuple[float, float, float, float, float, float, float, bool, bool, float, float, int]
]:
    start = int(seg.det_offsets[sample_idx])
    end = int(seg.det_offsets[sample_idx + 1])
    out: dict[
        int, tuple[float, float, float, float, float, float, float, bool, bool, float, float, int]
    ] = {}
    for k in range(start, end):
        tid = int(seg.det_track_id[k])
        if tid < 0:
            continue
        flags = int(seg.det_flags[k])
        out[tid] = (
            float(seg.det_boxes[k, 0]),
            float(seg.det_boxes[k, 1]),
            float(seg.det_boxes[k, 2]),
            float(seg.det_boxes[k, 3]),
            float(seg.det_feet[k, 0]),
            float(seg.det_feet[k, 1]),
            float(seg.det_scores[k]),
            bool(flags & 1),
            bool(flags & 2),
            float(seg.det_court[k, 0]),
            float(seg.det_court[k, 1]),
            int(seg.det_player_idx[k]),
        )
    return out


# --- Layer 1 extraction & disk cache ------------------------------------------------------


def _check_cancelled(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise PlayerTrackingCancelledError("Player Tracking job was cancelled")


def layer1_cache_key(
    video_path: Path,
    start_frame: int,
    end_frame: int,
    *,
    stride: int = DEFAULT_DETECTION_STRIDE,
    detector_model: str = DEFAULT_DETECTOR_MODEL_ID,
    pose_model: str = DEFAULT_POSE_MODEL_ID,
    method_version: int = METHOD_VERSION,
) -> str:
    """Stable hash keying Layer 1 calibration-free raw inference for one Play Segment."""
    stat = video_path.stat()
    payload = {
        "layer": 1,
        "method_version": method_version,
        "video": {
            "name": video_path.name,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        },
        "start_frame": start_frame,
        "end_frame": end_frame,
        "stride": stride,
        "detector_model": detector_model,
        "pose_model": pose_model,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def layer2_cache_key(
    roster: MatchRoster,
    segments: Sequence[PlaySegment],
    layer1_keys: Mapping[tuple[int, int], str],
    calibrations: Sequence[Calibration],
    camera_motion: CameraMotion | None,
    player_anchors: Sequence[PlayerAnchor],
    team_ends: Sequence[TeamEnd],
    *,
    method_version: int = METHOD_VERSION,
) -> str:
    """Stable hash keying Layer 2 court solve to Layer 1, Calibrations, Camera Motion & anchors."""
    motion_sig: list[dict[str, Any]] = []
    if camera_motion is not None:
        for span in camera_motion.spans:
            h = hashlib.sha256()
            h.update(span.mapped.tobytes())
            h.update(span.matrices.tobytes())
            motion_sig.append(
                {
                    "start": span.start_frame,
                    "end": span.end_frame,
                    "view": span.camera_view.value,
                    "lens": None
                    if span.lens is None
                    else [round(span.lens.k1, 6), round(span.lens.aspect, 6)],
                    "digest": h.hexdigest()[:16],
                }
            )
    payload = {
        "layer": 2,
        "method_version": method_version,
        "roster": {
            "match_id": str(roster.match_id),
            "team_a_id": str(roster.team_a_id),
            "team_b_id": str(roster.team_b_id),
            "players": [str(p.id) for p in roster.players],
        },
        "segments": [
            {
                "start": s.start_frame,
                "end": s.end_frame,
                "view": s.camera_view.value,
                "l1": layer1_keys.get((s.start_frame, s.end_frame)),
            }
            for s in sorted(segments, key=lambda seg: seg.start_frame)
        ],
        "calibrations": [
            {
                "view": c.camera_view.value,
                "from": c.effective_from_frame,
                "ref": c.reference_frame,
                "landmarks": {
                    lm.value: [c.landmarks[lm].x, c.landmarks[lm].y, c.landmarks[lm].frame]
                    for lm in sorted(c.landmarks, key=lambda item: item.value)
                },
                "not_visible": sorted(lm.value for lm in c.not_visible),
            }
            for c in sorted(
                calibrations, key=lambda cal: (cal.camera_view.value, cal.effective_from_frame)
            )
        ],
        "camera_motion": motion_sig,
        "anchors": [
            [a.frame, str(a.player_id), a.kind.value, a.image_x, a.image_y]
            for a in sorted(player_anchors, key=lambda x: (x.frame, str(x.player_id)))
        ],
        "team_ends": [
            [te.effective_from_frame, str(te.near_team_id)]
            for te in sorted(team_ends, key=lambda x: x.effective_from_frame)
        ],
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def extract_segment_detections(
    video_path: Path,
    segment: PlaySegment,
    backend: VisionBackend,
    *,
    stride: int = DEFAULT_DETECTION_STRIDE,
    batch_size: int = _DETECTOR_BATCH_SIZE,
    on_progress: Callable[[int, int], None] | None = None,
    cancel: threading.Event | None = None,
) -> SegmentDetections:
    """Runs Layer 1 person detection + ankle pose + appearance on one Play Segment."""
    _check_cancelled(cancel)
    if not video_path.is_file():
        raise PlayerTrackingError(f"Source video not found: {video_path}")

    samples = sample_frames_for_segment(segment.start_frame, segment.end_frame, stride)
    sample_set = set(samples)
    total = len(samples)

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        cap.release()
        raise PlayerTrackingError(f"Could not open video for Player Tracking: {video_path}")

    detections_by_frame: dict[int, tuple[RawDetection, ...]] = {}
    batch_frames: list[int] = []
    batch_imgs: list[np.ndarray] = []
    done = 0

    def flush_batch() -> None:
        nonlocal done
        if not batch_imgs:
            return
        _check_cancelled(cancel)
        batch_out = backend.detect_batch(batch_imgs)
        for f_num, dets in zip(batch_frames, batch_out, strict=True):
            detections_by_frame[f_num] = dets
        done += len(batch_frames)
        batch_frames.clear()
        batch_imgs.clear()
        if on_progress is not None:
            on_progress(done, total)

    try:
        cap.set(cv2.CAP_PROP_POS_FRAMES, segment.start_frame)
        read_any = False
        for frame_num in range(segment.start_frame, segment.end_frame + 1):
            _check_cancelled(cancel)
            if frame_num in sample_set:
                ok, frame_bgr = cap.read()
                if not ok or frame_bgr is None:
                    if not read_any:
                        raise PlayerTrackingError(
                            f"Could not decode frame {frame_num} from {video_path}"
                        )
                    break
                read_any = True
                batch_frames.append(frame_num)
                batch_imgs.append(frame_bgr)
                if len(batch_imgs) >= batch_size:
                    flush_batch()
            else:
                if not cap.grab():
                    break
        flush_batch()
    finally:
        cap.release()

    actual_samples = tuple(f for f in samples if f in detections_by_frame)
    return SegmentDetections(
        start_frame=segment.start_frame,
        end_frame=segment.end_frame,
        stride=stride,
        detector_model=backend.detector_model,
        pose_model=backend.pose_model,
        sample_frames=actual_samples,
        detections=detections_by_frame,
    )


class PlayerTrackingCache:
    """Two-layer disk cache for Player Tracking beside the Rally Log (ADR 0012)."""

    def __init__(
        self,
        cache_dir: Path,
        *,
        method_version: int = METHOD_VERSION,
        stride: int = DEFAULT_DETECTION_STRIDE,
        detector_model: str = DEFAULT_DETECTOR_MODEL_ID,
        pose_model: str = DEFAULT_POSE_MODEL_ID,
    ) -> None:
        self._dir = cache_dir
        self._method_version = method_version
        self._stride = stride
        self._detector_model = detector_model
        self._pose_model = pose_model

    @property
    def cache_dir(self) -> Path:
        return self._dir

    @property
    def stride(self) -> int:
        return self._stride

    @property
    def detector_model(self) -> str:
        return self._detector_model

    @property
    def pose_model(self) -> str:
        return self._pose_model

    def layer1_key(self, video_path: Path, segment: PlaySegment) -> str:
        return layer1_cache_key(
            video_path,
            segment.start_frame,
            segment.end_frame,
            stride=self._stride,
            detector_model=self._detector_model,
            pose_model=self._pose_model,
            method_version=self._method_version,
        )

    def _layer1_path(self, key: str) -> Path:
        return self._dir / f"l1_{key}.npz"

    def _layer2_path(self, key: str) -> Path:
        return self._dir / f"l2_{key}.npz"

    def has_layer1(self, video_path: Path, segment: PlaySegment) -> bool:
        if not video_path.is_file():
            return False
        return self._layer1_path(self.layer1_key(video_path, segment)).is_file()

    def get_layer1(self, video_path: Path, segment: PlaySegment) -> SegmentDetections | None:
        """Loads cached Layer 1 detections for `segment`, or None if missing/invalid."""
        if not video_path.is_file():
            return None
        path = self._layer1_path(self.layer1_key(video_path, segment))
        if not path.is_file():
            return None
        try:
            with np.load(path, allow_pickle=False) as data:
                meta = json.loads(bytes(data["meta"].tolist()).decode("utf-8"))
                if (
                    meta.get("method_version") != self._method_version
                    or meta.get("start_frame") != segment.start_frame
                    or meta.get("end_frame") != segment.end_frame
                    or meta.get("stride") != self._stride
                    or meta.get("detector_model") != self._detector_model
                    or meta.get("pose_model") != self._pose_model
                ):
                    return None
                sample_frames = tuple(int(f) for f in data["sample_frames"].tolist())
                offsets = data["offsets"]
                boxes = data["boxes"]
                ankles = data["ankles"]
                embeddings = data["embeddings"]
        except OSError, ValueError, KeyError, UnicodeDecodeError, json.JSONDecodeError:
            return None

        if len(offsets) != len(sample_frames) + 1:
            return None
        dets_by_frame: dict[int, tuple[RawDetection, ...]] = {}
        for idx, frame_num in enumerate(sample_frames):
            lo = int(offsets[idx])
            hi = int(offsets[idx + 1])
            frame_list: list[RawDetection] = []
            for k in range(lo, hi):
                la_c = float(ankles[k, 2])
                ra_c = float(ankles[k, 5])
                left_ankle = (
                    (float(ankles[k, 0]), float(ankles[k, 1]), la_c)
                    if la_c >= 0.0 and np.isfinite(ankles[k, 0]) and np.isfinite(ankles[k, 1])
                    else None
                )
                right_ankle = (
                    (float(ankles[k, 3]), float(ankles[k, 4]), ra_c)
                    if ra_c >= 0.0 and np.isfinite(ankles[k, 3]) and np.isfinite(ankles[k, 4])
                    else None
                )
                emb = np.array(embeddings[k], dtype=np.float32)
                frame_list.append(
                    RawDetection(
                        x1=float(boxes[k, 0]),
                        y1=float(boxes[k, 1]),
                        x2=float(boxes[k, 2]),
                        y2=float(boxes[k, 3]),
                        score=float(boxes[k, 4]),
                        left_ankle=left_ankle,
                        right_ankle=right_ankle,
                        appearance=emb,
                    )
                )
            dets_by_frame[frame_num] = tuple(frame_list)

        return SegmentDetections(
            start_frame=segment.start_frame,
            end_frame=segment.end_frame,
            stride=self._stride,
            detector_model=self._detector_model,
            pose_model=self._pose_model,
            sample_frames=sample_frames,
            detections=dets_by_frame,
        )

    def put_layer1(
        self, video_path: Path, segment: PlaySegment, seg_dets: SegmentDetections
    ) -> None:
        """Atomically stores Layer 1 detections for `segment`."""
        self._dir.mkdir(parents=True, exist_ok=True)
        target = self._layer1_path(self.layer1_key(video_path, segment))
        sample_frames = np.array(seg_dets.sample_frames, dtype=np.int32)
        offsets = np.zeros(len(seg_dets.sample_frames) + 1, dtype=np.int32)
        all_boxes: list[list[float]] = []
        all_ankles: list[list[float]] = []
        all_embs: list[np.ndarray] = []

        for idx, frame_num in enumerate(seg_dets.sample_frames):
            frame_dets = seg_dets.detections.get(frame_num, ())
            for d in frame_dets:
                all_boxes.append([d.x1, d.y1, d.x2, d.y2, d.score])
                la = d.left_ankle if d.left_ankle is not None else (np.nan, np.nan, -1.0)
                ra = d.right_ankle if d.right_ankle is not None else (np.nan, np.nan, -1.0)
                all_ankles.append([la[0], la[1], la[2], ra[0], ra[1], ra[2]])
                emb = (
                    d.appearance.astype(np.float32)
                    if d.appearance is not None and len(d.appearance) == APPEARANCE_DIM
                    else np.zeros(APPEARANCE_DIM, dtype=np.float32)
                )
                all_embs.append(emb)
            offsets[idx + 1] = len(all_boxes)

        boxes_arr = (
            np.array(all_boxes, dtype=np.float32)
            if all_boxes
            else np.zeros((0, 5), dtype=np.float32)
        )
        ankles_arr = (
            np.array(all_ankles, dtype=np.float32)
            if all_ankles
            else np.zeros((0, 6), dtype=np.float32)
        )
        embs_arr = (
            np.stack(all_embs).astype(np.float16)
            if all_embs
            else np.zeros((0, APPEARANCE_DIM), dtype=np.float16)
        )
        meta_bytes = json.dumps(
            {
                "method_version": self._method_version,
                "start_frame": segment.start_frame,
                "end_frame": segment.end_frame,
                "stride": self._stride,
                "detector_model": self._detector_model,
                "pose_model": self._pose_model,
            },
            sort_keys=True,
        ).encode("utf-8")
        meta_arr = np.frombuffer(meta_bytes, dtype=np.uint8)
        _atomic_savez(
            self._dir,
            target,
            prefix=".l1-",
            meta=meta_arr,
            sample_frames=sample_frames,
            offsets=offsets,
            boxes=boxes_arr,
            ankles=ankles_arr,
            embeddings=embs_arr,
        )

    def get_or_extract_layer1(
        self,
        video_path: Path,
        segment: PlaySegment,
        backend: VisionBackend,
        *,
        on_progress: Callable[[int, int], None] | None = None,
        cancel: threading.Event | None = None,
    ) -> SegmentDetections:
        """Returns cached Layer 1 detections for `segment`, or runs inference and caches them."""
        _check_cancelled(cancel)
        cached = self.get_layer1(video_path, segment)
        if cached is not None:
            if on_progress is not None:
                n = len(cached.sample_frames)
                on_progress(n, max(1, n))
            return cached
        extracted = extract_segment_detections(
            video_path,
            segment,
            backend,
            stride=self._stride,
            on_progress=on_progress,
            cancel=cancel,
        )
        _check_cancelled(cancel)
        self.put_layer1(video_path, segment, extracted)
        return extracted

    def get_layer2(
        self,
        key: str,
        roster: MatchRoster,
        anchors: Sequence[PlayerAnchor],
    ) -> MatchPlayerTracking | None:
        """Loads a cached Layer 2 `MatchPlayerTracking` if present and valid."""
        path = self._layer2_path(key)
        if not path.is_file():
            return None
        try:
            with np.load(path, allow_pickle=False) as data:
                meta = json.loads(bytes(data["meta"].tolist()).decode("utf-8"))
                if meta.get("method_version") != self._method_version:
                    return None
                seg_metas = meta["segments"]
                solved: list[_SolvedSegment] = []
                for idx, sm in enumerate(seg_metas):
                    p = f"s{idx}_"
                    solved.append(
                        _SolvedSegment(
                            start_frame=int(sm["start_frame"]),
                            end_frame=int(sm["end_frame"]),
                            camera_view=CameraView(sm["camera_view"]),
                            stride=int(sm["stride"]),
                            pos_x=np.array(data[f"{p}pos_x"], dtype=np.float32),
                            pos_y=np.array(data[f"{p}pos_y"], dtype=np.float32),
                            pos_cert=np.array(data[f"{p}pos_cert"], dtype=np.uint8),
                            settled_val=np.array(data[f"{p}settled_val"], dtype=np.int8),
                            settled_cert=np.array(data[f"{p}settled_cert"], dtype=np.uint8),
                            img_x=np.array(data[f"{p}img_x"], dtype=np.float32),
                            img_y=np.array(data[f"{p}img_y"], dtype=np.float32),
                            bbox=np.array(data[f"{p}bbox"], dtype=np.float32),
                            near_team_idx=np.array(data[f"{p}near_team_idx"], dtype=np.int8),
                            sample_frames=np.array(data[f"{p}sample_frames"], dtype=np.int32),
                            det_offsets=np.array(data[f"{p}det_offsets"], dtype=np.int32),
                            det_boxes=np.array(data[f"{p}det_boxes"], dtype=np.float32),
                            det_feet=np.array(data[f"{p}det_feet"], dtype=np.float32),
                            det_scores=np.array(data[f"{p}det_scores"], dtype=np.float32),
                            det_flags=np.array(data[f"{p}det_flags"], dtype=np.uint8),
                            det_court=np.array(data[f"{p}det_court"], dtype=np.float32),
                            det_track_id=np.array(data[f"{p}det_track_id"], dtype=np.int32),
                            det_player_idx=np.array(data[f"{p}det_player_idx"], dtype=np.int8),
                        )
                    )
                ends = [
                    TeamEnd(
                        effective_from_frame=int(item[0]),
                        near_team_id=roster.team_a_id if int(item[1]) == 0 else roster.team_b_id,
                    )
                    for item in meta.get("effective_team_ends", [])
                ]
        except OSError, ValueError, KeyError, UnicodeDecodeError, json.JSONDecodeError:
            return None
        return MatchPlayerTracking(roster, solved, anchors=anchors, effective_team_ends=ends)

    def put_layer2(self, key: str, tracking: MatchPlayerTracking) -> None:
        """Atomically writes a Layer 2 `MatchPlayerTracking` to disk."""
        self._dir.mkdir(parents=True, exist_ok=True)
        target = self._layer2_path(key)
        arrays: dict[str, np.ndarray] = {}
        seg_metas: list[dict[str, Any]] = []
        for idx, seg in enumerate(tracking._segments):
            p = f"s{idx}_"
            seg_metas.append(
                {
                    "start_frame": seg.start_frame,
                    "end_frame": seg.end_frame,
                    "camera_view": seg.camera_view.value,
                    "stride": seg.stride,
                }
            )
            arrays[f"{p}pos_x"] = seg.pos_x
            arrays[f"{p}pos_y"] = seg.pos_y
            arrays[f"{p}pos_cert"] = seg.pos_cert
            arrays[f"{p}settled_val"] = seg.settled_val
            arrays[f"{p}settled_cert"] = seg.settled_cert
            arrays[f"{p}img_x"] = seg.img_x
            arrays[f"{p}img_y"] = seg.img_y
            arrays[f"{p}bbox"] = seg.bbox
            arrays[f"{p}near_team_idx"] = seg.near_team_idx
            arrays[f"{p}sample_frames"] = seg.sample_frames
            arrays[f"{p}det_offsets"] = seg.det_offsets
            arrays[f"{p}det_boxes"] = seg.det_boxes
            arrays[f"{p}det_feet"] = seg.det_feet
            arrays[f"{p}det_scores"] = seg.det_scores
            arrays[f"{p}det_flags"] = seg.det_flags
            arrays[f"{p}det_court"] = seg.det_court
            arrays[f"{p}det_track_id"] = seg.det_track_id
            arrays[f"{p}det_player_idx"] = seg.det_player_idx

        ends_encoded = [
            [te.effective_from_frame, 0 if te.near_team_id == tracking.roster.team_a_id else 1]
            for te in tracking._team_ends
        ]
        meta_bytes = json.dumps(
            {
                "method_version": self._method_version,
                "segments": seg_metas,
                "effective_team_ends": ends_encoded,
            },
            sort_keys=True,
        ).encode("utf-8")
        arrays["meta"] = np.frombuffer(meta_bytes, dtype=np.uint8)
        _atomic_savez(self._dir, target, prefix=".l2-", **arrays)

    def load_or_solve(
        self,
        video_path: Path | None,
        roster: MatchRoster,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        court_mapping: CourtMapping,
        camera_motion: CameraMotion | None,
        player_anchors: Sequence[PlayerAnchor],
        team_ends: Sequence[TeamEnd],
    ) -> MatchPlayerTracking:
        """Loads cached Layer 2 tracking, or solves it fast from cached Layer 1 detections."""
        layer1_by_seg: dict[tuple[int, int], SegmentDetections] = {}
        layer1_keys: dict[tuple[int, int], str] = {}
        if video_path is not None and video_path.is_file():
            for seg in segments:
                hit = self.get_layer1(video_path, seg)
                if hit is not None:
                    bounds = (seg.start_frame, seg.end_frame)
                    layer1_by_seg[bounds] = hit
                    layer1_keys[bounds] = self.layer1_key(video_path, seg)

        key = layer2_cache_key(
            roster,
            segments,
            layer1_keys,
            calibrations,
            camera_motion,
            player_anchors,
            team_ends,
            method_version=self._method_version,
        )
        cached = self.get_layer2(key, roster, player_anchors)
        if cached is not None:
            return cached

        solved = solve_match_tracking(
            roster=roster,
            segments=segments,
            layer1_by_segment=layer1_by_seg,
            court_mapping=court_mapping,
            player_anchors=player_anchors,
            team_ends=team_ends,
            default_stride=self._stride,
        )
        self.put_layer2(key, solved)
        return solved

    def track_match(
        self,
        video_path: Path,
        roster: MatchRoster,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        court_mapping: CourtMapping,
        camera_motion: CameraMotion | None,
        player_anchors: Sequence[PlayerAnchor],
        team_ends: Sequence[TeamEnd],
        *,
        backend: VisionBackend | None = None,
        device: DevicePreference = "auto",
        priority_frame: int | None = None,
        on_progress: Callable[[int, int, PlaySegment], None] | None = None,
        cancel: threading.Event | None = None,
    ) -> MatchPlayerTracking:
        """Ensures Layer 1 is cached for all Play Segments (prioritising `priority_frame`),
        then runs Layer 2 court solve and caches it."""
        ordered = _prioritise_segments(segments, priority_frame)
        missing = [seg for seg in ordered if not self.has_layer1(video_path, seg)]
        if missing:
            active_backend = (
                backend
                if backend is not None
                else TorchVisionBackend(
                    device=device,
                    detector_model=self._detector_model,
                    pose_model=self._pose_model,
                )
            )
            total_samples = sum(
                len(sample_frames_for_segment(s.start_frame, s.end_frame, self._stride))
                for s in ordered
            )
            completed_before = sum(
                len(sample_frames_for_segment(s.start_frame, s.end_frame, self._stride))
                for s in ordered
                if s not in missing
            )
            for seg in missing:
                _check_cancelled(cancel)
                seg_total = len(
                    sample_frames_for_segment(seg.start_frame, seg.end_frame, self._stride)
                )

                def report(
                    done_in_seg: int,
                    _seg_n: int,
                    _seg: PlaySegment = seg,
                    _base: int = completed_before,
                ) -> None:
                    if on_progress is not None:
                        on_progress(
                            min(total_samples, _base + done_in_seg),
                            max(1, total_samples),
                            _seg,
                        )

                self.get_or_extract_layer1(
                    video_path, seg, active_backend, on_progress=report, cancel=cancel
                )
                completed_before += seg_total

        return self.load_or_solve(
            video_path,
            roster,
            segments,
            calibrations,
            court_mapping,
            camera_motion,
            player_anchors,
            team_ends,
        )


def _prioritise_segments(
    segments: Sequence[PlaySegment], priority_frame: int | None
) -> list[PlaySegment]:
    ordered = sorted(segments, key=lambda s: s.start_frame)
    if priority_frame is None:
        return ordered
    first = [s for s in ordered if s.contains(priority_frame)]
    rest = [s for s in ordered if not s.contains(priority_frame)]
    return [*first, *rest]


def _atomic_savez(cache_dir: Path, target: Path, *, prefix: str, **arrays: Any) -> None:
    fd, raw_tmp = tempfile.mkstemp(dir=cache_dir, prefix=prefix, suffix=".tmp.npz")
    os.close(fd)
    tmp = Path(raw_tmp)
    try:
        np.savez_compressed(tmp, allow_pickle=False, **arrays)
        tmp.replace(target)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise


# --- Layer 2 court solve ------------------------------------------------------------------


@dataclass
class _ProjectedDet:
    frame: int
    x1: float
    y1: float
    x2: float
    y2: float
    score: float
    foot_image: ImagePoint
    ankles_visible: bool
    feet_cropped: bool
    court_pt: CourtPoint | None
    appearance: np.ndarray
    anchor_override: bool = False
    tracklet_id: int = -1


@dataclass
class _Tracklet:
    tracklet_id: int
    observations: dict[int, _ProjectedDet]  # frame -> detection
    frames: list[int]
    ema_appearance: np.ndarray
    last_velocity: tuple[float, float] = (0.0, 0.0)
    anchored: bool = False

    @property
    def first_frame(self) -> int:
        return self.frames[0]

    @property
    def last_frame(self) -> int:
        return self.frames[-1]

    def court_at(self, frame: int) -> CourtPoint | None:
        det = self.observations.get(frame)
        return None if det is None else det.court_pt

    def median_y(self) -> float | None:
        ys = [
            d.court_pt.y
            for d in self.observations.values()
            if d.court_pt is not None and not d.feet_cropped
        ]
        if not ys:
            ys = [d.court_pt.y for d in self.observations.values() if d.court_pt is not None]
        return float(np.median(ys)) if ys else None

    def enters_court_lines(self) -> bool:
        return any(
            not d.feet_cropped
            and d.court_pt is not None
            and abs(d.court_pt.x) <= COURT_ENTRY_MAX_X_FT
            and abs(d.court_pt.y) <= COURT_ENTRY_MAX_Y_FT
            for d in self.observations.values()
        )


@dataclass(frozen=True)
class _BoundAnchor:
    anchor: PlayerAnchor
    tracklet_id: int | None
    court_pt: CourtPoint | None


@dataclass
class _SegmentWork:
    segment: PlaySegment
    stride: int
    sample_frames: tuple[int, ...]
    dets_by_frame: dict[int, list[_ProjectedDet]]
    tracklets: dict[int, _Tracklet]
    anchors: list[_BoundAnchor]
    assignments: dict[int, dict[PlayerId, int]]  # sample_frame -> {player_id: tracklet_id}


def solve_match_tracking(
    *,
    roster: MatchRoster,
    segments: Sequence[PlaySegment],
    layer1_by_segment: Mapping[tuple[int, int], SegmentDetections],
    court_mapping: CourtMapping,
    player_anchors: Sequence[PlayerAnchor] = (),
    team_ends: Sequence[TeamEnd] = (),
    default_stride: int = DEFAULT_DETECTION_STRIDE,
) -> MatchPlayerTracking:
    """Runs the Layer 2 court solve across all Play Segments of a Match."""
    ordered_segments = sorted(segments, key=lambda s: s.start_frame)
    anchors_by_seg: dict[tuple[int, int], list[PlayerAnchor]] = defaultdict(list)
    for anchor in sorted(player_anchors, key=lambda a: (a.frame, str(a.player_id))):
        for seg in ordered_segments:
            if seg.contains(anchor.frame):
                anchors_by_seg[(seg.start_frame, seg.end_frame)].append(anchor)
                break

    # Step 1 & 2: Project detections through CourtMapping.at(frame) and build filtered tracklets.
    works: list[_SegmentWork] = []
    for seg in ordered_segments:
        bounds = (seg.start_frame, seg.end_frame)
        raw_seg = layer1_by_segment.get(bounds)
        seg_anchors = anchors_by_seg.get(bounds, [])
        work = _prepare_segment(seg, raw_seg, seg_anchors, court_mapping, default_stride)
        works.append(work)

    # Step 3: Build effective TeamEnds (explicit + seeded from anchors + opposite-end flips).
    effective_ends = _resolve_effective_team_ends(roster, team_ends, works)

    # Step 4: Harvest appearance prototypes and track which Players have been anchored/identified.
    prototypes, anchored_players = _harvest_player_prototypes(works)

    # Step 5: Forward identity propagation across segments, live cuts, and replay gaps.
    prev_work: _SegmentWork | None = None
    for work in works:
        initial = _propagate_into_segment(
            prev_work, work, roster, effective_ends, prototypes, anchored_players
        )
        _assign_segment_identities(
            work,
            roster=roster,
            initial_bindings=initial,
            effective_ends=effective_ends,
            prototypes=prototypes,
            known_players=anchored_players,
        )
        # Update prototypes with newly tracked frames in this segment if still missing.
        _enrich_prototypes_from_work(work, prototypes)
        prev_work = work

    # Step 5b: Backward cross-segment propagation for earlier segments before the first anchor.
    for idx in range(len(works) - 2, -1, -1):
        earlier = works[idx]
        later = works[idx + 1]
        if any(earlier.assignments.values()):
            continue
        if not any(later.assignments.values()):
            continue
        back_initial = _propagate_backward_into_segment(
            later, earlier, roster, effective_ends, prototypes, anchored_players
        )
        if back_initial:
            _assign_segment_identities(
                earlier,
                roster=roster,
                initial_bindings=back_initial,
                effective_ends=effective_ends,
                prototypes=prototypes,
                known_players=anchored_players,
                from_end=True,
            )

    # Step 6: Interpolate per-frame positions, enforce occlusion/cropped-feet certainty & Settled.
    solved_segments = [
        _materialize_segment(work, roster, court_mapping, effective_ends) for work in works
    ]
    return MatchPlayerTracking(
        roster=roster,
        segments=solved_segments,
        anchors=player_anchors,
        effective_team_ends=effective_ends,
    )


def _prepare_segment(
    seg: PlaySegment,
    raw_seg: SegmentDetections | None,
    seg_anchors: list[PlayerAnchor],
    court_mapping: CourtMapping,
    default_stride: int,
) -> _SegmentWork:
    stride = default_stride if raw_seg is None else raw_seg.stride
    sample_frames = () if raw_seg is None else raw_seg.sample_frames

    # Index identity anchors near each sampled frame so anchors always bypass ROI/filtering.
    id_anchors = [a for a in seg_anchors if a.kind is AnchorKind.IDENTITY]

    dets_by_frame: dict[int, list[_ProjectedDet]] = {}
    for f in sample_frames:
        homography = court_mapping.at(f)
        if homography is None or raw_seg is None:
            dets_by_frame[f] = []
            continue
        near_id_anchors = [a for a in id_anchors if abs(a.frame - f) <= stride]
        kept: list[_ProjectedDet] = []
        for raw in raw_seg.detections.get(f, ()):
            foot_img, ankles_vis, cropped = raw.foot_point(
                min_ankle_conf=MIN_ANKLE_CONFIDENCE,
                bottom_crop_margin=BOTTOM_EDGE_CROP_MARGIN,
            )
            court_pt = homography.to_court(foot_img)
            in_roi = (
                court_pt is not None
                and abs(court_pt.x) <= PLAYING_ROI_MAX_X_FT
                and abs(court_pt.y) <= PLAYING_ROI_MAX_Y_FT
            )
            hit_by_anchor = any(_box_contains_or_near(raw, a) for a in near_id_anchors)
            if not in_roi and not hit_by_anchor:
                continue
            emb = (
                raw.appearance.astype(np.float32)
                if raw.appearance is not None and len(raw.appearance) == APPEARANCE_DIM
                else np.zeros(APPEARANCE_DIM, dtype=np.float32)
            )
            kept.append(
                _ProjectedDet(
                    frame=f,
                    x1=raw.x1,
                    y1=raw.y1,
                    x2=raw.x2,
                    y2=raw.y2,
                    score=raw.score,
                    foot_image=foot_img,
                    ankles_visible=ankles_vis,
                    feet_cropped=cropped,
                    court_pt=court_pt,
                    appearance=emb,
                    anchor_override=hit_by_anchor,
                )
            )
        dets_by_frame[f] = _suppress_court_duplicates(kept)

    tracklets = _build_segment_tracklets(sample_frames, dets_by_frame)
    bound_anchors = _bind_segment_anchors(
        seg_anchors, sample_frames, tracklets, court_mapping, stride
    )

    # Mark tracklets targeted by operator anchors so non-player filtering never drops them.
    for ba in bound_anchors:
        if ba.tracklet_id is not None and ba.tracklet_id in tracklets:
            tracklets[ba.tracklet_id].anchored = True

    # Non-player filtering: reject tracklets that never enter the court lines (unless anchored).
    kept_tracklets = {
        tid: tr for tid, tr in tracklets.items() if tr.anchored or tr.enters_court_lines()
    }
    kept_ids = set(kept_tracklets)
    for f in sample_frames:
        dets_by_frame[f] = [d for d in dets_by_frame[f] if d.tracklet_id in kept_ids]

    # Re-check bound anchors in case a position anchor pointed at a rejected non-player tracklet.
    cleaned_anchors = [
        _BoundAnchor(
            anchor=ba.anchor,
            tracklet_id=ba.tracklet_id if ba.tracklet_id in kept_ids else None,
            court_pt=ba.court_pt,
        )
        for ba in bound_anchors
    ]

    return _SegmentWork(
        segment=seg,
        stride=stride,
        sample_frames=sample_frames,
        dets_by_frame=dets_by_frame,
        tracklets=kept_tracklets,
        anchors=cleaned_anchors,
        assignments={},
    )


def _box_contains_or_near(det: RawDetection, anchor: PlayerAnchor) -> bool:
    return (
        det.x1 - _ANCHOR_BOX_MARGIN <= anchor.image_x <= det.x2 + _ANCHOR_BOX_MARGIN
        and det.y1 - _ANCHOR_BOX_MARGIN <= anchor.image_y <= det.y2 + _ANCHOR_BOX_MARGIN
    )


def _suppress_court_duplicates(dets: list[_ProjectedDet]) -> list[_ProjectedDet]:
    """Removes overlapping duplicate boxes emitted for the same person on one frame.

    When a Player stands behind the net tape, person detectors occasionally emit both a full-body
    box and a lower-scoring partial box with IoU below Layer 1's 0.75 threshold. Because both boxes
    project to nearly the same court foot point (`< _SAME_PERSON_COURT_DIST_FT`) and overlap in
    image space, keeping only the higher-scoring (preferring confident ankles) detection avoids
    spawning twin tracklets that later break identity continuity.
    """
    if len(dets) <= 1:
        return dets
    ordered = sorted(
        dets,
        key=lambda d: (1 if d.ankles_visible else 0, d.score),
        reverse=True,
    )
    kept: list[_ProjectedDet] = []
    for cand in ordered:
        cand_box = (cand.x1, cand.y1, cand.x2, cand.y2)
        cand_area = max(1e-9, (cand.x2 - cand.x1) * (cand.y2 - cand.y1))
        duplicate = False
        for ref in kept:
            if cand.court_pt is None or ref.court_pt is None:
                continue
            d_court = math.hypot(cand.court_pt.x - ref.court_pt.x, cand.court_pt.y - ref.court_pt.y)
            ref_box = (ref.x1, ref.y1, ref.x2, ref.y2)
            iou = _iou_boxes(cand_box, ref_box)
            ix1 = max(cand.x1, ref.x1)
            iy1 = max(cand.y1, ref.y1)
            ix2 = min(cand.x2, ref.x2)
            iy2 = min(cand.y2, ref.y2)
            inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
            containment = inter / cand_area
            same_person = (
                d_court <= _SAME_PERSON_COURT_DIST_FT and (iou > 0.25 or containment > 0.65)
            ) or (
                # A partial upper-body duplicate (missing ankles) projects a few feet off in y
                # because its bbox bottom sits above the floor, while strongly overlapping `ref`.
                ref.ankles_visible
                and not cand.ankles_visible
                and d_court <= 5.0
                and (iou > 0.45 or containment > 0.75)
            )
            if same_person:
                if cand.anchor_override:
                    ref.anchor_override = True
                duplicate = True
                break
        if not duplicate:
            kept.append(cand)
    return kept


def _build_segment_tracklets(
    sample_frames: tuple[int, ...],
    dets_by_frame: dict[int, list[_ProjectedDet]],
) -> dict[int, _Tracklet]:
    """Associates court-ROI detections across frames using court motion, IoU, and appearance."""
    tracklets: dict[int, _Tracklet] = {}
    active_ids: list[int] = []
    next_id = 0

    for f in sample_frames:
        # Expire stale tracklets beyond the linking horizon.
        active_ids = [
            tid for tid in active_ids if f - tracklets[tid].last_frame <= _MAX_TRACK_LINK_GAP_FRAMES
        ]
        dets = dets_by_frame.get(f, [])
        if not dets:
            continue

        matched_det_indices: set[int] = set()
        if active_ids:
            n_tr = len(active_ids)
            n_det = len(dets)
            big = 1e6
            cost = np.full((n_tr, n_det), big, dtype=np.float64)
            for ti, tid in enumerate(active_ids):
                tr = tracklets[tid]
                prev_det = tr.observations[tr.last_frame]
                dt_frames = f - tr.last_frame
                dt_sec = dt_frames / VIDEO_FPS
                court_gate = max(_MIN_COURT_GATE_FT, _MAX_HUMAN_SPEED_FT_S * dt_sec + 2.0)
                vel_damp = 1.0 if dt_frames <= 8 else 0.4
                pred_c = (
                    CourtPoint(
                        prev_det.court_pt.x + tr.last_velocity[0] * dt_sec * vel_damp,
                        prev_det.court_pt.y + tr.last_velocity[1] * dt_sec * vel_damp,
                    )
                    if prev_det.court_pt is not None
                    else None
                )
                prev_box = (prev_det.x1, prev_det.y1, prev_det.x2, prev_det.y2)

                for di, det in enumerate(dets):
                    # Disallow crossing the net mid-rally.
                    if (
                        prev_det.court_pt is not None
                        and det.court_pt is not None
                        and (
                            (
                                prev_det.court_pt.y < -_NET_CROSS_MARGIN_FT
                                and det.court_pt.y > _NET_CROSS_MARGIN_FT
                            )
                            or (
                                prev_det.court_pt.y > _NET_CROSS_MARGIN_FT
                                and det.court_pt.y < -_NET_CROSS_MARGIN_FT
                            )
                        )
                    ):
                        continue

                    iou = _iou_boxes(prev_box, (det.x1, det.y1, det.x2, det.y2))
                    app_dist = _appearance_distance(tr.ema_appearance, det.appearance)
                    if pred_c is not None and det.court_pt is not None:
                        d_court = math.hypot(pred_c.x - det.court_pt.x, pred_c.y - det.court_pt.y)
                        if d_court > court_gate:
                            continue
                        if dt_frames <= 8:
                            c_val = (
                                0.55 * (d_court / court_gate) + 0.25 * (1.0 - iou) + 0.20 * app_dist
                            )
                        else:
                            c_val = (
                                0.55 * (d_court / court_gate) + 0.10 * (1.0 - iou) + 0.35 * app_dist
                            )
                    else:
                        if iou < 0.25:
                            continue
                        c_val = 0.70 * (1.0 - iou) + 0.30 * app_dist

                    if c_val <= _MAX_ASSOC_COST:
                        cost[ti, di] = c_val

            row_ind, col_ind = linear_sum_assignment(cost)
            for r, c in zip(row_ind.tolist(), col_ind.tolist(), strict=True):
                if cost[r, c] >= big * 0.5:
                    continue
                tid = active_ids[r]
                det = dets[c]
                tr = tracklets[tid]
                prev_f = tr.last_frame
                prev_det = tr.observations[prev_f]
                dt_sec = max(1e-6, (f - prev_f) / VIDEO_FPS)
                if (
                    prev_det.court_pt is not None
                    and det.court_pt is not None
                    and not prev_det.feet_cropped
                    and not det.feet_cropped
                ):
                    vx = (det.court_pt.x - prev_det.court_pt.x) / dt_sec
                    vy = (det.court_pt.y - prev_det.court_pt.y) / dt_sec
                    tr.last_velocity = (
                        0.5 * tr.last_velocity[0] + 0.5 * vx,
                        0.5 * tr.last_velocity[1] + 0.5 * vy,
                    )
                det.tracklet_id = tid
                tr.observations[f] = det
                tr.frames.append(f)
                tr.ema_appearance = _blend_appearance(tr.ema_appearance, det.appearance, alpha=0.2)
                matched_det_indices.add(c)

        for di, det in enumerate(dets):
            if di in matched_det_indices:
                continue
            tid = next_id
            next_id += 1
            det.tracklet_id = tid
            tracklets[tid] = _Tracklet(
                tracklet_id=tid,
                observations={f: det},
                frames=[f],
                ema_appearance=det.appearance.copy(),
            )
            active_ids.append(tid)

    return tracklets


def _bind_segment_anchors(
    seg_anchors: Sequence[PlayerAnchor],
    sample_frames: tuple[int, ...],
    tracklets: Mapping[int, _Tracklet],
    court_mapping: CourtMapping,
    stride: int,
) -> list[_BoundAnchor]:
    """Resolves each operator anchor in a segment to its bound tracklet and/or court point."""
    bound: list[_BoundAnchor] = []
    for anchor in seg_anchors:
        homography = court_mapping.at(anchor.frame)
        if anchor.kind is AnchorKind.IDENTITY:
            tid = _hit_test_tracklet(anchor, sample_frames, tracklets, stride)
            court_pt: CourtPoint | None = None
            if tid is not None:
                court_pt = _tracklet_court_near(tracklets[tid], anchor.frame)
            if court_pt is None and homography is not None:
                court_pt = homography.to_court(anchor.point)
            bound.append(_BoundAnchor(anchor=anchor, tracklet_id=tid, court_pt=court_pt))
        else:
            # `position` anchor overrides the foot position directly and re-attaches nearby track.
            court_pt = None if homography is None else homography.to_court(anchor.point)
            tid = (
                _nearest_tracklet_to_court(court_pt, anchor.frame, tracklets, stride)
                if court_pt is not None
                else None
            )
            bound.append(_BoundAnchor(anchor=anchor, tracklet_id=tid, court_pt=court_pt))
    return bound


def _hit_test_tracklet(
    anchor: PlayerAnchor,
    sample_frames: tuple[int, ...],
    tracklets: Mapping[int, _Tracklet],
    stride: int,
) -> int | None:
    """Finds the tracklet whose box contains the anchor click at `anchor.frame`."""
    if not tracklets or not sample_frames:
        return None
    ax, ay = anchor.image_x, anchor.image_y
    candidates: list[tuple[int, tuple[float, float, float, float]]] = []
    for tid, tr in tracklets.items():
        box = _tracklet_box_at(tr, anchor.frame, max_gap=max(stride, MAX_OCCLUSION_GAP_FRAMES))
        if box is not None:
            candidates.append((tid, box))

    containing: list[tuple[float, float, int]] = []
    for tid, (x1, y1, x2, y2) in candidates:
        if x1 <= ax <= x2 and y1 <= ay <= y2:
            area = max(1e-9, (x2 - x1) * (y2 - y1))
            cx, cy = 0.5 * (x1 + x2), 0.5 * (y1 + y2)
            containing.append((area, math.hypot(ax - cx, ay - cy), tid))
    if containing:
        containing.sort()
        return containing[0][2]

    # Small tolerance fallback when clicking just outside a moving box on a non-stride frame.
    best_tid: int | None = None
    best_dist = _ANCHOR_BOX_MARGIN
    for tid, (x1, y1, x2, y2) in candidates:
        dx = max(x1 - ax, 0.0, ax - x2)
        dy = max(y1 - ay, 0.0, ay - y2)
        dist = math.hypot(dx, dy)
        if dist <= best_dist:
            best_dist = dist
            best_tid = tid
    return best_tid


def _nearest_tracklet_to_court(
    court_pt: CourtPoint,
    frame: int,
    tracklets: Mapping[int, _Tracklet],
    stride: int,
) -> int | None:
    """Finds the closest tracklet to `court_pt` around `frame` for `position` anchor re-attach."""
    best_tid: int | None = None
    best_score = float("inf")
    for tid, tr in tracklets.items():
        # Prefer tracklets active at or starting right after `frame`.
        if tr.last_frame < frame - stride or tr.first_frame > frame + MAX_OCCLUSION_GAP_FRAMES:
            continue
        pt = _tracklet_court_near(tr, frame)
        if pt is None:
            continue
        # Respect net boundary.
        if (court_pt.y < -_NET_CROSS_MARGIN_FT and pt.y > _NET_CROSS_MARGIN_FT) or (
            court_pt.y > _NET_CROSS_MARGIN_FT and pt.y < -_NET_CROSS_MARGIN_FT
        ):
            continue
        dist = math.hypot(pt.x - court_pt.x, pt.y - court_pt.y)
        if dist > MANUAL_REATTACH_DIST_FT:
            continue
        # Slight preference for tracklets actually present at `frame`.
        time_penalty = 0.0 if tr.first_frame <= frame <= tr.last_frame else 0.5
        score = dist + time_penalty
        if score < best_score:
            best_score = score
            best_tid = tid
    return best_tid


def _tracklet_box_at(
    tr: _Tracklet, frame: int, *, max_gap: int
) -> tuple[float, float, float, float] | None:
    if frame in tr.observations:
        d = tr.observations[frame]
        return (d.x1, d.y1, d.x2, d.y2)
    frames = tr.frames
    idx = int(np.searchsorted(frames, frame))
    if 0 < idx < len(frames):
        f0, f1 = frames[idx - 1], frames[idx]
        if f1 - f0 <= max_gap:
            a = (frame - f0) / (f1 - f0)
            d0, d1 = tr.observations[f0], tr.observations[f1]
            return (
                (1.0 - a) * d0.x1 + a * d1.x1,
                (1.0 - a) * d0.y1 + a * d1.y1,
                (1.0 - a) * d0.x2 + a * d1.x2,
                (1.0 - a) * d0.y2 + a * d1.y2,
            )
    # Within one stride of tracklet endpoint.
    for cand in (idx - 1, idx):
        if 0 <= cand < len(frames) and abs(frames[cand] - frame) <= DEFAULT_DETECTION_STRIDE:
            d = tr.observations[frames[cand]]
            return (d.x1, d.y1, d.x2, d.y2)
    return None


def _tracklet_court_near(tr: _Tracklet, frame: int) -> CourtPoint | None:
    if frame in tr.observations and tr.observations[frame].court_pt is not None:
        return tr.observations[frame].court_pt
    frames = tr.frames
    idx = int(np.searchsorted(frames, frame))
    if 0 < idx < len(frames):
        f0, f1 = frames[idx - 1], frames[idx]
        d0, d1 = tr.observations[f0], tr.observations[f1]
        if (
            d0.court_pt is not None
            and d1.court_pt is not None
            and f1 - f0 <= MAX_OCCLUSION_GAP_FRAMES
        ):
            a = (frame - f0) / (f1 - f0)
            return CourtPoint(
                (1.0 - a) * d0.court_pt.x + a * d1.court_pt.x,
                (1.0 - a) * d0.court_pt.y + a * d1.court_pt.y,
            )
    best_pt: CourtPoint | None = None
    best_dt = MAX_OCCLUSION_GAP_FRAMES + 1
    for cand in (idx - 1, idx):
        if 0 <= cand < len(frames):
            f_c = frames[cand]
            dt = abs(f_c - frame)
            pt = tr.observations[f_c].court_pt
            if pt is not None and dt < best_dt:
                best_dt = dt
                best_pt = pt
    return best_pt


def _resolve_effective_team_ends(
    roster: MatchRoster,
    explicit_team_ends: Sequence[TeamEnd],
    works: Sequence[_SegmentWork],
) -> tuple[TeamEnd, ...]:
    """Resolves active `TeamEnd`s: explicit records, seeded from anchors if empty, and updated
    when a later anchor places a Player clearly on the opposite end."""
    ends: dict[int, TeamId] = {
        te.effective_from_frame: te.near_team_id for te in explicit_team_ends
    }
    all_anchors = sorted(
        (ba for w in works for ba in w.anchors),
        key=lambda ba: (ba.anchor.frame, str(ba.anchor.player_id)),
    )

    # Seed `team_ends` when none is set yet, using the earliest anchor with clear side of net.
    if not ends:
        for ba in all_anchors:
            if ba.court_pt is None or abs(ba.court_pt.y) < 0.5:
                continue
            p_team = roster.team_id_for(ba.anchor.player_id)
            near_team = p_team if ba.court_pt.y < 0.0 else roster.other_team_id(p_team)
            ends[0] = near_team
            break

    # Check if an anchor clearly places a Player on the opposite end from the active TeamEnd.
    explicit_frames = {te.effective_from_frame for te in explicit_team_ends}
    for ba in all_anchors:
        if ba.court_pt is None or abs(ba.court_pt.y) < _OPPOSITE_END_FLIP_Y_FT:
            continue
        frame = ba.anchor.frame
        if frame in explicit_frames:
            continue
        p_team = roster.team_id_for(ba.anchor.player_id)
        implied_near = p_team if ba.court_pt.y < 0.0 else roster.other_team_id(p_team)
        current_list = [TeamEnd(ef, tid) for ef, tid in sorted(ends.items())]
        active = team_end_at(current_list, frame)
        if active is None or active.near_team_id != implied_near:
            ends[frame] = implied_near

    return tuple(TeamEnd(ef, tid) for ef, tid in sorted(ends.items()))


def _harvest_player_prototypes(
    works: Sequence[_SegmentWork],
) -> tuple[dict[PlayerId, np.ndarray], set[PlayerId]]:
    """Harvests L2-normalised appearance prototypes from operator-anchored tracklets."""
    accum: dict[PlayerId, list[np.ndarray]] = defaultdict(list)
    anchored_players: set[PlayerId] = set()
    for work in works:
        for ba in work.anchors:
            pid = ba.anchor.player_id
            anchored_players.add(pid)
            if ba.tracklet_id is None or ba.tracklet_id not in work.tracklets:
                continue
            tr = work.tracklets[ba.tracklet_id]
            for f in tr.frames:
                if abs(f - ba.anchor.frame) <= 30:
                    emb = tr.observations[f].appearance
                    if float(np.linalg.norm(emb)) > 1e-6:
                        weight = 3.0 if abs(f - ba.anchor.frame) <= work.stride else 1.0
                        accum[pid].append(emb * weight)
    prototypes: dict[PlayerId, np.ndarray] = {}
    for pid, vecs in accum.items():
        mean = np.mean(np.stack(vecs), axis=0).astype(np.float32)
        norm = float(np.linalg.norm(mean))
        if norm > 1e-6:
            prototypes[pid] = mean / norm
    return prototypes, anchored_players


def _enrich_prototypes_from_work(
    work: _SegmentWork, prototypes: dict[PlayerId, np.ndarray]
) -> None:
    """Enriches appearance prototypes with evenly-spaced tracked frames from `work`.

    Anchoring on a single frame can catch a Player bent over or far behind the baseline; blending
    up to 32 tracked samples across the Play Segment makes cross-gap matching much more stable.
    """
    vecs_by_player: dict[PlayerId, list[np.ndarray]] = defaultdict(list)
    for f in work.sample_frames:
        for pid, tid in work.assignments.get(f, {}).items():
            tr = work.tracklets.get(tid)
            if tr is None or f not in tr.observations:
                continue
            det = tr.observations[f]
            if not det.ankles_visible or det.feet_cropped:
                continue
            emb = det.appearance
            if float(np.linalg.norm(emb)) > 1e-6:
                vecs_by_player[pid].append(emb)

    for pid, vecs in vecs_by_player.items():
        step = max(1, len(vecs) // 32)
        sampled = vecs[::step][:32]
        seg_mean = np.mean(np.stack(sampled), axis=0).astype(np.float32)
        norm = float(np.linalg.norm(seg_mean))
        if norm <= 1e-6:
            continue
        seg_unit = seg_mean / norm
        if pid not in prototypes:
            prototypes[pid] = seg_unit
        else:
            blended = 0.4 * prototypes[pid] + 0.6 * seg_unit
            b_norm = float(np.linalg.norm(blended))
            if b_norm > 1e-6:
                prototypes[pid] = (blended / b_norm).astype(np.float32)


def _propagate_into_segment(
    prev_work: _SegmentWork | None,
    work: _SegmentWork,
    roster: MatchRoster,
    effective_ends: Sequence[TeamEnd],
    prototypes: Mapping[PlayerId, np.ndarray],
    known_players: set[PlayerId],
) -> dict[PlayerId, int]:
    """Transfers identities into `work`'s start via live cut (court coords) or replay gap
    (near/far Team ends + partner appearance embeddings)."""
    if not work.sample_frames or not known_players:
        return {}
    start_f = work.sample_frames[0]

    # Case 1: Live Camera View cut (adjacent Play Segments, e.g. 3388 main -> 3389 sideline).
    if (
        prev_work is not None
        and prev_work.sample_frames
        and 0 < work.segment.start_frame - prev_work.segment.end_frame <= LIVE_CUT_MAX_GAP_FRAMES
    ):
        prev_positions = _terminal_court_positions(prev_work, from_start=False)
        if prev_positions:
            return _match_cross_cut(
                prev_positions, work, start_f, roster, effective_ends, prototypes, from_start=True
            )

    # Case 2: Replay / dead-time gap (or first segment): use Team ends + appearance prototypes.
    return _match_by_team_ends_and_appearance(
        work, start_f, roster, effective_ends, prototypes, known_players, from_start=True
    )


def _propagate_backward_into_segment(
    later_work: _SegmentWork,
    earlier_work: _SegmentWork,
    roster: MatchRoster,
    effective_ends: Sequence[TeamEnd],
    prototypes: Mapping[PlayerId, np.ndarray],
    known_players: set[PlayerId],
) -> dict[PlayerId, int]:
    """Propagates identities backward from `later_work` into an unanchored `earlier_work`."""
    if not earlier_work.sample_frames or not known_players:
        return {}
    end_f = earlier_work.sample_frames[-1]
    if (
        0
        < later_work.segment.start_frame - earlier_work.segment.end_frame
        <= LIVE_CUT_MAX_GAP_FRAMES
    ):
        later_positions = _terminal_court_positions(later_work, from_start=True)
        if later_positions:
            return _match_cross_cut(
                later_positions,
                earlier_work,
                end_f,
                roster,
                effective_ends,
                prototypes,
                from_start=False,
            )
    return _match_by_team_ends_and_appearance(
        earlier_work, end_f, roster, effective_ends, prototypes, known_players, from_start=False
    )


def _terminal_court_positions(
    work: _SegmentWork, *, from_start: bool
) -> dict[PlayerId, CourtPoint]:
    """Latest (or earliest) valid court position of each assigned Player near a segment edge."""
    frames = work.sample_frames if from_start else tuple(reversed(work.sample_frames))
    edge = frames[0]
    found: dict[PlayerId, CourtPoint] = {}
    for f in frames:
        if abs(f - edge) > 20:
            break
        for pid, tid in work.assignments.get(f, {}).items():
            if pid in found:
                continue
            tr = work.tracklets.get(tid)
            if tr is None:
                continue
            det = tr.observations.get(f)
            if det is not None and det.court_pt is not None and not det.feet_cropped:
                found[pid] = det.court_pt
    return found


def _match_cross_cut(
    ref_positions: Mapping[PlayerId, CourtPoint],
    target_work: _SegmentWork,
    edge_frame: int,
    roster: MatchRoster,
    effective_ends: Sequence[TeamEnd],
    prototypes: Mapping[PlayerId, np.ndarray],
    *,
    from_start: bool,
) -> dict[PlayerId, int]:
    """Matches active tracklets at a live cut to `ref_positions` via shared court (x, y)."""
    cand_tids, cand_pts, cand_dts = _edge_tracklet_positions(
        target_work, edge_frame, from_start=from_start
    )
    if not cand_tids:
        return {}

    ref_pids = list(ref_positions)
    near_te = team_end_at(effective_ends, edge_frame)
    near_team_id = None if near_te is None else near_te.near_team_id
    prefer_persistent = len(target_work.sample_frames) >= 5

    big = 1e6
    cost = np.full((len(ref_pids), len(cand_tids)), big, dtype=np.float64)
    for pi, pid in enumerate(ref_pids):
        p_pt = ref_positions[pid]
        p_team = roster.team_id_for(pid)
        for ci, (tid, c_pt, dt_frames) in enumerate(
            zip(cand_tids, cand_pts, cand_dts, strict=True)
        ):
            # Respect Team end side if known.
            if near_team_id is not None:
                if p_team == near_team_id and c_pt.y > _NET_CROSS_MARGIN_FT:
                    continue
                if p_team != near_team_id and c_pt.y < -_NET_CROSS_MARGIN_FT:
                    continue
            dist = math.hypot(p_pt.x - c_pt.x, p_pt.y - c_pt.y)
            if dist > LIVE_CUT_MAX_DIST_FT:
                continue
            tr = target_work.tracklets[tid]
            app_d = _appearance_distance(prototypes.get(pid), tr.ema_appearance)
            # Strongly prefer tracklets actually present on the cut frame and non-transient tracks
            # over 1-frame noise blips appearing several frames after the cut.
            time_penalty = 0.30 * dt_frames
            blip_penalty = 3.0 if prefer_persistent and len(tr.frames) == 1 else 0.0
            cost[pi, ci] = dist + 0.6 * app_d + time_penalty + blip_penalty

    row_ind, col_ind = linear_sum_assignment(cost)
    out: dict[PlayerId, int] = {}
    for r, c in zip(row_ind.tolist(), col_ind.tolist(), strict=True):
        if cost[r, c] < big * 0.5:
            out[ref_pids[r]] = cand_tids[c]
    return out


def _edge_tracklet_positions(
    work: _SegmentWork, edge_frame: int, *, from_start: bool
) -> tuple[list[int], list[CourtPoint], list[int]]:
    """Tracklets active near `edge_frame`, their closest court position, and frame offset."""
    tids: list[int] = []
    pts: list[CourtPoint] = []
    dts: list[int] = []
    for tid, tr in work.tracklets.items():
        if from_start:
            if tr.first_frame - edge_frame > 20:
                continue
            search_frames = tr.frames
        else:
            if edge_frame - tr.last_frame > 20:
                continue
            search_frames = list(reversed(tr.frames))
        chosen: CourtPoint | None = None
        chosen_dt = 0
        for f in search_frames:
            dt = abs(f - edge_frame)
            if dt > 20:
                break
            det = tr.observations[f]
            if det.court_pt is not None and not det.feet_cropped:
                chosen = det.court_pt
                chosen_dt = dt
                break
        if chosen is not None:
            tids.append(tid)
            pts.append(chosen)
            dts.append(chosen_dt)
    return tids, pts, dts


def _match_by_team_ends_and_appearance(
    work: _SegmentWork,
    ref_frame: int,
    roster: MatchRoster,
    effective_ends: Sequence[TeamEnd],
    prototypes: Mapping[PlayerId, np.ndarray],
    known_players: set[PlayerId],
    *,
    from_start: bool,
) -> dict[PlayerId, int]:
    """Narrows each court half (`y < 0` / `y > 0`) to its Team's 2 partners via `team_ends`,
    then matches partners using appearance embeddings harvested from anchored frames."""
    te = team_end_at(effective_ends, ref_frame)
    if te is None:
        return {}
    near_team_id = te.near_team_id
    far_team_id = roster.other_team_id(near_team_id)

    cand_tids, cand_pts, _ = _edge_tracklet_positions(work, ref_frame, from_start=from_start)
    if not cand_tids:
        return {}

    near_tids: list[int] = []
    far_tids: list[int] = []
    for tid, pt in zip(cand_tids, cand_pts, strict=True):
        if pt.y < 0.0:
            near_tids.append(tid)
        else:
            far_tids.append(tid)

    # Prefer the 2 longest tracklets on each half when more than 2 exist.
    near_tids.sort(key=lambda t: len(work.tracklets[t].frames), reverse=True)
    far_tids.sort(key=lambda t: len(work.tracklets[t].frames), reverse=True)

    out: dict[PlayerId, int] = {}
    for team_id, half_tids in ((near_team_id, near_tids[:2]), (far_team_id, far_tids[:2])):
        if not half_tids:
            continue
        partners = [p.id for p in roster.team_players(team_id) if p.id in known_players]
        if not partners:
            continue
        # Only match if at least one partner on this half has an appearance prototype,
        # or if only one partner is known and one tracklet is present.
        if not any(p in prototypes for p in partners) and len(partners) > 1:
            continue
        cost = np.zeros((len(partners), len(half_tids)), dtype=np.float64)
        for pi, pid in enumerate(partners):
            proto = prototypes.get(pid)
            for ci, tid in enumerate(half_tids):
                cost[pi, ci] = _appearance_distance(proto, work.tracklets[tid].ema_appearance)
        row_ind, col_ind = linear_sum_assignment(cost)
        for r, c in zip(row_ind.tolist(), col_ind.tolist(), strict=True):
            out[partners[r]] = half_tids[c]
    return out


def _assign_segment_identities(
    work: _SegmentWork,
    *,
    roster: MatchRoster,
    initial_bindings: Mapping[PlayerId, int],
    effective_ends: Sequence[TeamEnd],
    prototypes: Mapping[PlayerId, np.ndarray],
    known_players: set[PlayerId],
    from_end: bool = False,
) -> None:
    """Solves piecewise Player -> tracklet assignments across `work.sample_frames`.

    Rules:
    - A Player's first explicit anchor in the segment propagates backward to the segment start
      and forward.
    - Adding a later anchor (or partner swap) overrides from that frame forward without disturbing
      earlier frames.
    - An explicit `team_ends` flip mid-segment re-matches halves from that frame forward.
    """
    if not work.sample_frames:
        return

    # Group bound anchors by player; determine each player's first anchor for backward propagation.
    anchors_by_player: dict[PlayerId, list[_BoundAnchor]] = defaultdict(list)
    for ba in sorted(work.anchors, key=lambda b: b.anchor.frame):
        if ba.tracklet_id is not None:
            anchors_by_player[ba.anchor.player_id].append(ba)

    # First-anchor backward seed: for each player anchored in this segment, trace their FIRST
    # anchor backward to segment start so `[seg.start, first_anchor]` follows that anchor.
    current: dict[PlayerId, int] = dict(initial_bindings)
    first_anchor_overrides: dict[int, dict[PlayerId, int]] = defaultdict(dict)
    for pid, ba_list in anchors_by_player.items():
        first_ba = ba_list[0]
        assert first_ba.tracklet_id is not None
        # Backward walk from first_ba.anchor.frame to segment start along tracklet chain.
        tr_id = first_ba.tracklet_id
        current[pid] = tr_id
        _trace_backward_into_table(
            work,
            pid=pid,
            start_frame=first_ba.anchor.frame,
            tracklet_id=tr_id,
            roster=roster,
            effective_ends=effective_ends,
            prototypes=prototypes,
            table=first_anchor_overrides,
        )

    # Resolve any conflicts in backward overrides (closest explicit anchor wins).
    ordered_frames = tuple(reversed(work.sample_frames)) if from_end else work.sample_frames

    # Prepare forward anchor events sorted by frame.
    forward_events = sorted(
        (ba for ba in work.anchors if ba.tracklet_id is not None),
        key=lambda ba: (ba.anchor.frame, str(ba.anchor.player_id)),
    )
    event_idx = 0
    last_near_team: TeamId | None = None
    last_seen_court: dict[PlayerId, CourtPoint] = {}
    last_seen_frame: dict[PlayerId, int] = {}
    seen_frames: dict[PlayerId, set[int]] = defaultdict(set)
    explicitly_anchored: set[PlayerId] = set()

    for f in ordered_frames:
        # 1. Check mid-segment TeamEnd flip (only during forward pass).
        te = team_end_at(effective_ends, f)
        near_team_id = None if te is None else te.near_team_id
        if not from_end and last_near_team is not None and near_team_id != last_near_team:
            # Explicit end swap mid-segment: re-match active tracklets on new halves.
            current = _match_by_team_ends_and_appearance(
                work, f, roster, effective_ends, prototypes, known_players, from_start=True
            )
            last_seen_court.clear()
            last_seen_frame.clear()
            seen_frames.clear()
        last_near_team = near_team_id

        # 2. Apply explicit forward anchor events up to frame `f`.
        if not from_end:
            applied_here: dict[PlayerId, int] = {}
            while event_idx < len(forward_events) and forward_events[event_idx].anchor.frame <= f:
                ba = forward_events[event_idx]
                event_idx += 1
                if ba.tracklet_id is not None:
                    applied_here[ba.anchor.player_id] = ba.tracklet_id
            if applied_here:
                _apply_anchor_overrides(current, applied_here, work, f, roster)
                explicitly_anchored.update(applied_here)

        frame_map: dict[PlayerId, int] = {}
        used_tids: set[int] = set()

        # 3a. Players already explicitly anchored earlier in this segment claim their tracklets
        # first so a later anchor for another Player never steals an earlier interval.
        if not from_end:
            for pid in list(explicitly_anchored):
                tid = current.get(pid)
                if tid is None:
                    continue
                tr = work.tracklets.get(tid)
                if tr is None:
                    del current[pid]
                    continue
                if tid in used_tids:
                    continue
                if f in tr.observations:
                    frame_map[pid] = tid
                    used_tids.add(tid)
                elif tr.last_frame < f:
                    del current[pid]

        # 3b. Backward-traced first-anchor bindings for frames before each Player's first anchor,
        # ordered by nearest first-anchor frame so closer anchors win any tracklet conflict.
        if not from_end and f in first_anchor_overrides:
            for pid, tid in sorted(
                first_anchor_overrides[f].items(),
                key=lambda item: (anchors_by_player[item[0]][0].anchor.frame, str(item[0])),
            ):
                if pid in frame_map:
                    continue
                first_f = anchors_by_player[pid][0].anchor.frame
                if f <= first_f and tid not in used_tids and f in work.tracklets[tid].observations:
                    frame_map[pid] = tid
                    used_tids.add(tid)
                    current[pid] = tid

        # 4. Carry forward active bindings for remaining Players (e.g. cross-cut / gap transfers).
        for pid, tid in list(current.items()):
            if pid in frame_map:
                continue
            tr = work.tracklets.get(tid)
            if tr is None:
                del current[pid]
                continue
            if tid in used_tids:
                continue
            if f in tr.observations:
                frame_map[pid] = tid
                used_tids.add(tid)
            elif (not from_end and tr.last_frame < f) or (from_end and tr.first_frame > f):
                # Tracklet has ended; release so re-linking can pick up a continuation tracklet.
                del current[pid]

        # 5. Re-link unassigned known Players if unclaimed tracklets are active on their Team half.
        active_unclaimed = [
            tid
            for tid, tr in work.tracklets.items()
            if tid not in used_tids and f in tr.observations
        ]
        if active_unclaimed and near_team_id is not None:
            _relink_unassigned_on_frame(
                frame_map=frame_map,
                current=current,
                used_tids=used_tids,
                active_unclaimed=active_unclaimed,
                work=work,
                frame=f,
                roster=roster,
                near_team_id=near_team_id,
                prototypes=prototypes,
                known_players=known_players,
                last_seen_court=last_seen_court,
                last_seen_frame=last_seen_frame,
                seen_frames=seen_frames,
            )

        # Record frame assignments and update last-seen positions.
        work.assignments[f] = frame_map
        for pid, tid in frame_map.items():
            last_seen_frame[pid] = f
            seen_frames[pid].add(f)
            det = work.tracklets[tid].observations.get(f)
            if det is not None and det.court_pt is not None and not det.feet_cropped:
                last_seen_court[pid] = det.court_pt


def _apply_anchor_overrides(
    current: dict[PlayerId, int],
    applied: Mapping[PlayerId, int],
    work: _SegmentWork,
    frame: int,
    roster: MatchRoster,
) -> None:
    """Applies explicit anchors at `frame`, swapping displaced teammates on 1-click fixes."""
    prev_snapshot = dict(current)
    for pid, tid in applied.items():
        # Find if another Player currently holds `tid`.
        displaced = [other for other, otid in current.items() if other != pid and otid == tid]
        for other in displaced:
            if other in applied:
                continue
            # If `other` is `pid`'s teammate and `pid`'s previous tracklet is free & active, swap.
            old_tid = prev_snapshot.get(pid)
            if (
                old_tid is not None
                and old_tid != tid
                and old_tid not in applied.values()
                and roster.team_id_for(other) == roster.team_id_for(pid)
                and old_tid in work.tracklets
                and work.tracklets[old_tid].last_frame >= frame
            ):
                current[other] = old_tid
            else:
                del current[other]
        current[pid] = tid


def _trace_backward_into_table(
    work: _SegmentWork,
    *,
    pid: PlayerId,
    start_frame: int,
    tracklet_id: int,
    roster: MatchRoster,
    effective_ends: Sequence[TeamEnd],
    prototypes: Mapping[PlayerId, np.ndarray],
    table: dict[int, dict[PlayerId, int]],
) -> None:
    """Traces a Player's first explicit anchor in a segment backward to the segment start."""
    cur_tid = tracklet_id
    cur_tr = work.tracklets[cur_tid]
    last_pt = _tracklet_court_near(cur_tr, start_frame)
    p_team = roster.team_id_for(pid)

    for f in reversed(work.sample_frames):
        if f > start_frame:
            continue
        if f in cur_tr.observations:
            table[f][pid] = cur_tid
            det = cur_tr.observations[f]
            if det.court_pt is not None and not det.feet_cropped:
                last_pt = det.court_pt
            continue
        if f < cur_tr.first_frame:
            # Look for an earlier tracklet on the same half ending just before cur_tr started.
            te = team_end_at(effective_ends, f)
            near_team_id = None if te is None else te.near_team_id
            best_tid: int | None = None
            best_score = float("inf")
            for cand_id, cand_tr in work.tracklets.items():
                if cand_id == cur_tid or f not in cand_tr.observations:
                    continue
                if cand_tr.last_frame >= cur_tr.first_frame:
                    continue
                if cur_tr.first_frame - cand_tr.last_frame > 180:
                    continue
                det = cand_tr.observations[f]
                if det.court_pt is None:
                    continue
                if near_team_id is not None:
                    if p_team == near_team_id and det.court_pt.y > _NET_CROSS_MARGIN_FT:
                        continue
                    if p_team != near_team_id and det.court_pt.y < -_NET_CROSS_MARGIN_FT:
                        continue
                dist = (
                    math.hypot(det.court_pt.x - last_pt.x, det.court_pt.y - last_pt.y)
                    if last_pt is not None
                    else 5.0
                )
                dt_sec = max(1e-6, (cur_tr.first_frame - cand_tr.last_frame) / VIDEO_FPS)
                if last_pt is not None and dist > _MAX_HUMAN_SPEED_FT_S * dt_sec + 4.0:
                    continue
                proto = prototypes.get(pid)
                app_d = _appearance_distance(proto, cand_tr.ema_appearance)
                if (
                    proto is not None
                    and float(np.linalg.norm(cand_tr.ema_appearance)) > 1e-6
                    and app_d > _RELINK_MAX_APPEARANCE_DIST
                ):
                    continue
                score = dist * 0.15 + app_d
                if score < best_score:
                    best_score = score
                    best_tid = cand_id
            if best_tid is not None:
                cur_tid = best_tid
                cur_tr = work.tracklets[cur_tid]
                table[f][pid] = cur_tid
                det = cur_tr.observations[f]
                if det.court_pt is not None and not det.feet_cropped:
                    last_pt = det.court_pt


def _relink_unassigned_on_frame(
    *,
    frame_map: dict[PlayerId, int],
    current: dict[PlayerId, int],
    used_tids: set[int],
    active_unclaimed: list[int],
    work: _SegmentWork,
    frame: int,
    roster: MatchRoster,
    near_team_id: TeamId,
    prototypes: Mapping[PlayerId, np.ndarray],
    known_players: set[PlayerId],
    last_seen_court: Mapping[PlayerId, CourtPoint],
    last_seen_frame: Mapping[PlayerId, int],
    seen_frames: Mapping[PlayerId, set[int]],
) -> None:
    """Re-links unassigned known Players to unclaimed active tracklets on their Team half."""
    far_team_id = roster.other_team_id(near_team_id)
    big = 1e6
    for team_id, is_near in ((near_team_id, True), (far_team_id, False)):
        unassigned = [
            p.id
            for p in roster.team_players(team_id)
            if p.id in known_players and p.id not in frame_map and p.id not in current
        ]
        if not unassigned:
            continue
        half_tids: list[int] = []
        for tid in active_unclaimed:
            det = work.tracklets[tid].observations[frame]
            if det.court_pt is None:
                continue
            if (
                is_near
                and det.court_pt.y < _NET_CROSS_MARGIN_FT
                or not is_near
                and det.court_pt.y > -_NET_CROSS_MARGIN_FT
            ):
                half_tids.append(tid)
        if not half_tids:
            continue

        cost = np.full((len(unassigned), len(half_tids)), big, dtype=np.float64)
        for pi, pid in enumerate(unassigned):
            last_pt = last_seen_court.get(pid)
            last_f = last_seen_frame.get(pid)
            pid_frames = seen_frames.get(pid)
            proto = prototypes.get(pid)
            for ci, tid in enumerate(half_tids):
                tr = work.tracklets[tid]
                # A tracklet that co-existed concurrently with `pid` on >= 2 sample frames
                # belongs to a different person (allowing 1-frame flicker handoffs).
                if pid_frames and sum(1 for tf in tr.frames if tf in pid_frames) >= 2:
                    continue
                det = tr.observations[frame]
                app_d = _appearance_distance(proto, tr.ema_appearance)
                if (
                    proto is not None
                    and float(np.linalg.norm(tr.ema_appearance)) > 1e-6
                    and app_d > _RELINK_MAX_APPEARANCE_DIST
                ):
                    continue
                if last_pt is not None and det.court_pt is not None:
                    d_court = math.hypot(det.court_pt.x - last_pt.x, det.court_pt.y - last_pt.y)
                    if last_f is not None:
                        dt_sec = max(1e-6, abs(frame - last_f) / VIDEO_FPS)
                        if d_court > _MAX_HUMAN_SPEED_FT_S * dt_sec + 4.0:
                            continue
                    d_norm = min(2.0, d_court / 10.0)
                    cost[pi, ci] = 0.45 * d_norm + 0.55 * app_d
                else:
                    cost[pi, ci] = app_d

        row_ind, col_ind = linear_sum_assignment(cost)
        for r, c in zip(row_ind.tolist(), col_ind.tolist(), strict=True):
            if cost[r, c] >= big * 0.5:
                continue
            pid = unassigned[r]
            tid = half_tids[c]
            frame_map[pid] = tid
            current[pid] = tid
            used_tids.add(tid)


def _materialize_segment(
    work: _SegmentWork,
    roster: MatchRoster,
    court_mapping: CourtMapping,
    effective_ends: Sequence[TeamEnd],
) -> _SolvedSegment:
    """Produces dense per-frame positions, certainty, Zones, and Settled for one Play Segment."""
    seg = work.segment
    n_frames = seg.end_frame - seg.start_frame + 1
    players = roster.players
    player_index = {p.id: idx for idx, p in enumerate(players)}

    pos_x = np.full((n_frames, 4), np.nan, dtype=np.float32)
    pos_y = np.full((n_frames, 4), np.nan, dtype=np.float32)
    pos_cert = np.full((n_frames, 4), _CERT_UNKNOWN, dtype=np.uint8)
    settled_val = np.full((n_frames, 4), -1, dtype=np.int8)
    settled_cert = np.full((n_frames, 4), _CERT_UNKNOWN, dtype=np.uint8)
    img_x = np.full((n_frames, 4), np.nan, dtype=np.float32)
    img_y = np.full((n_frames, 4), np.nan, dtype=np.float32)
    bbox = np.full((n_frames, 4, 4), np.nan, dtype=np.float32)
    near_team_idx = np.full((n_frames,), -1, dtype=np.int8)

    # Pre-check per-frame homographies and near-team assignments.
    homographies: list[Homography | None] = []
    for row in range(n_frames):
        f = seg.start_frame + row
        homographies.append(court_mapping.at(f))
        te = team_end_at(effective_ends, f)
        if te is not None:
            near_team_idx[row] = 0 if te.near_team_id == roster.team_a_id else 1

    # Map explicit `position` anchors by `(player_id, frame)`.
    pos_anchors_by_player: dict[PlayerId, dict[int, PlayerAnchor]] = defaultdict(dict)
    for ba in work.anchors:
        if ba.anchor.kind is AnchorKind.POSITION:
            pos_anchors_by_player[ba.anchor.player_id][ba.anchor.frame] = ba.anchor

    # Build sparse direct observations per Player: frame -> (court_pt, img_pt, bbox_or_none).
    for p_idx, player in enumerate(players):
        pid = player.id
        direct: dict[
            int, tuple[CourtPoint, ImagePoint, tuple[float, float, float, float] | None]
        ] = {}

        # Sampled detections assigned to this Player.
        for f in work.sample_frames:
            tid = work.assignments.get(f, {}).get(pid)
            if tid is None:
                continue
            det = work.tracklets[tid].observations.get(f)
            if det is None:
                continue
            row = f - seg.start_frame
            bbox[row, p_idx] = (det.x1, det.y1, det.x2, det.y2)
            # Bottom-edge cropped feet without visible ankles -> Unknown position.
            if det.feet_cropped or det.court_pt is None or homographies[row] is None:
                continue
            direct[f] = (det.court_pt, det.foot_image, (det.x1, det.y1, det.x2, det.y2))

        # Manual `position` anchors override detection directly without snapping back.
        for f, anchor in pos_anchors_by_player.get(pid, {}).items():
            row = f - seg.start_frame
            if not (0 <= row < n_frames):
                continue
            h = homographies[row]
            if h is None:
                # Unmapped frame always yields Unknown.
                direct.pop(f, None)
                continue
            pt = h.to_court(anchor.point)
            if pt is None:
                direct.pop(f, None)
                continue
            bx_row = bbox[row, p_idx]
            existing_box: tuple[float, float, float, float] | None = (
                (float(bx_row[0]), float(bx_row[1]), float(bx_row[2]), float(bx_row[3]))
                if np.all(np.isfinite(bx_row))
                else None
            )
            direct[f] = (pt, anchor.point, existing_box)

        obs_frames = sorted(direct)
        if not obs_frames:
            continue

        # Write direct observations (`Observed`).
        for f in obs_frames:
            row = f - seg.start_frame
            pt, im_pt, bx = direct[f]
            pos_x[row, p_idx] = pt.x
            pos_y[row, p_idx] = pt.y
            pos_cert[row, p_idx] = _CERT_OBSERVED
            img_x[row, p_idx] = im_pt.x
            img_y[row, p_idx] = im_pt.y
            if bx is not None:
                bbox[row, p_idx] = bx

        # Interpolate between direct observations (stride -> Observed; <=0.5 s -> Inferred).
        for idx in range(len(obs_frames) - 1):
            f0 = obs_frames[idx]
            f1 = obs_frames[idx + 1]
            gap = f1 - f0
            if gap <= 1 or gap > MAX_OCCLUSION_GAP_FRAMES:
                continue
            cert_code = _CERT_OBSERVED if gap <= work.stride else _CERT_INFERRED
            pt0, im0, bx0 = direct[f0]
            pt1, im1, bx1 = direct[f1]
            for f in range(f0 + 1, f1):
                row = f - seg.start_frame
                h = homographies[row]
                if h is None:
                    # Unmapped Camera Motion frame -> Unknown.
                    continue
                alpha = (f - f0) / gap
                cx = (1.0 - alpha) * pt0.x + alpha * pt1.x
                cy = (1.0 - alpha) * pt0.y + alpha * pt1.y
                pos_x[row, p_idx] = cx
                pos_y[row, p_idx] = cy
                pos_cert[row, p_idx] = cert_code
                projected_im = h.to_image(CourtPoint(cx, cy))
                if projected_im is not None:
                    img_x[row, p_idx] = projected_im.x
                    img_y[row, p_idx] = projected_im.y
                else:
                    img_x[row, p_idx] = (1.0 - alpha) * im0.x + alpha * im1.x
                    img_y[row, p_idx] = (1.0 - alpha) * im0.y + alpha * im1.y
                if bx0 is not None and bx1 is not None:
                    bbox[row, p_idx] = (
                        (1.0 - alpha) * bx0[0] + alpha * bx1[0],
                        (1.0 - alpha) * bx0[1] + alpha * bx1[1],
                        (1.0 - alpha) * bx0[2] + alpha * bx1[2],
                        (1.0 - alpha) * bx0[3] + alpha * bx1[3],
                    )

        # Compute Settled across this segment for `player`.
        _compute_settled_series(
            pos_y=pos_y[:, p_idx],
            pos_cert=pos_cert[:, p_idx],
            out_val=settled_val[:, p_idx],
            out_cert=settled_cert[:, p_idx],
        )

    # Pack kept detections at sampled frames for fast overlay & hit-testing queries.
    sample_arr = np.array(work.sample_frames, dtype=np.int32)
    det_offsets = np.zeros(len(work.sample_frames) + 1, dtype=np.int32)
    det_boxes_list: list[list[float]] = []
    det_feet_list: list[list[float]] = []
    det_scores_list: list[float] = []
    det_flags_list: list[int] = []
    det_court_list: list[list[float]] = []
    det_track_list: list[int] = []
    det_player_list: list[int] = []

    for s_idx, f in enumerate(work.sample_frames):
        tid_to_pidx = {tid: player_index[pid] for pid, tid in work.assignments.get(f, {}).items()}
        for det in work.dets_by_frame.get(f, ()):
            det_boxes_list.append([det.x1, det.y1, det.x2, det.y2])
            det_feet_list.append([det.foot_image.x, det.foot_image.y])
            det_scores_list.append(det.score)
            flags = (1 if det.ankles_visible else 0) | (2 if det.feet_cropped else 0)
            det_flags_list.append(flags)
            if det.court_pt is not None:
                det_court_list.append([det.court_pt.x, det.court_pt.y])
            else:
                det_court_list.append([np.nan, np.nan])
            det_track_list.append(det.tracklet_id)
            det_player_list.append(tid_to_pidx.get(det.tracklet_id, -1))
        det_offsets[s_idx + 1] = len(det_boxes_list)

    n_det = len(det_boxes_list)
    return _SolvedSegment(
        start_frame=seg.start_frame,
        end_frame=seg.end_frame,
        camera_view=seg.camera_view,
        stride=work.stride,
        pos_x=pos_x,
        pos_y=pos_y,
        pos_cert=pos_cert,
        settled_val=settled_val,
        settled_cert=settled_cert,
        img_x=img_x,
        img_y=img_y,
        bbox=bbox,
        near_team_idx=near_team_idx,
        sample_frames=sample_arr,
        det_offsets=det_offsets,
        det_boxes=(
            np.array(det_boxes_list, dtype=np.float32)
            if n_det
            else np.zeros((0, 4), dtype=np.float32)
        ),
        det_feet=(
            np.array(det_feet_list, dtype=np.float32)
            if n_det
            else np.zeros((0, 2), dtype=np.float32)
        ),
        det_scores=np.array(det_scores_list, dtype=np.float32),
        det_flags=np.array(det_flags_list, dtype=np.uint8),
        det_court=(
            np.array(det_court_list, dtype=np.float32)
            if n_det
            else np.zeros((0, 2), dtype=np.float32)
        ),
        det_track_id=np.array(det_track_list, dtype=np.int32),
        det_player_idx=np.array(det_player_list, dtype=np.int8),
    )


def _compute_settled_series(
    *,
    pos_y: np.ndarray,
    pos_cert: np.ndarray,
    out_val: np.ndarray,
    out_cert: np.ndarray,
) -> None:
    """Computes `Settled` (value + certainty) for one Player across a segment.

    Rules:
    - Unknown position -> Unknown.
    - Outside Frontcourt (`|y| > 9.0 ft`) -> `False` with the same certainty as `position`.
    - Inside Frontcourt (`|y| <= 9.0 ft`) -> velocity-derived `True`/`False` using trailing window
      `SETTLED_WINDOW_FRAMES` (~0.25 s): `v_toward = -d(|y|)/dt <= SETTLED_MAX_APPROACH_SPEED_FT_S`.
    - Inside Frontcourt without at least `SETTLED_MIN_SPAN_FRAMES` of trailing track history ->
      Unknown.
    """
    n = len(pos_y)
    for row in range(n):
        cert = int(pos_cert[row])
        if cert == _CERT_UNKNOWN or not math.isfinite(float(pos_y[row])):
            continue
        dist = abs(float(pos_y[row]))
        if dist > FRONTCOURT_MAX_Y_FT:
            out_val[row] = 0
            out_cert[row] = cert
            continue

        lo = max(0, row - SETTLED_WINDOW_FRAMES)
        window_rows = [
            r
            for r in range(lo, row + 1)
            if int(pos_cert[r]) != _CERT_UNKNOWN and math.isfinite(float(pos_y[r]))
        ]
        if len(window_rows) < 2 or (window_rows[-1] - window_rows[0]) < SETTLED_MIN_SPAN_FRAMES:
            # Insufficient trailing track velocity (e.g. isolated manual anchor or segment start).
            continue

        ts = np.array(window_rows, dtype=np.float64) / VIDEO_FPS
        ds = np.abs(pos_y[window_rows].astype(np.float64))
        t_mean = float(ts.mean())
        d_mean = float(ds.mean())
        dt = ts - t_mean
        denom = float(np.dot(dt, dt))
        if denom <= 1e-12:
            continue
        slope = float(np.dot(dt, ds - d_mean) / denom)
        v_toward = -slope
        out_val[row] = 1 if v_toward <= SETTLED_MAX_APPROACH_SPEED_FT_S else 0
        observed_count = sum(1 for r in window_rows if int(pos_cert[r]) == _CERT_OBSERVED)
        out_cert[row] = (
            _CERT_OBSERVED if cert == _CERT_OBSERVED and observed_count >= 2 else _CERT_INFERRED
        )


def _decode_certainty(code: int) -> Certainty:
    if code == _CERT_OBSERVED:
        return Certainty.OBSERVED
    if code == _CERT_INFERRED:
        return Certainty.INFERRED
    return Certainty.UNKNOWN


def _iou_boxes(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0.0:
        return 0.0
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    denom = area_a + area_b - inter
    return inter / denom if denom > 0.0 else 0.0


def _appearance_distance(a: np.ndarray | None, b: np.ndarray | None) -> float:
    """Cosine distance in [0, 1] between two L2-normalised embeddings (0.5 if missing)."""
    if a is None or b is None:
        return 0.5
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na <= 1e-6 or nb <= 1e-6:
        return 0.5
    sim = float(np.dot(a, b) / (na * nb))
    return float(max(0.0, min(1.0, 1.0 - sim)))


def _blend_appearance(ema: np.ndarray, obs: np.ndarray, *, alpha: float) -> np.ndarray:
    if float(np.linalg.norm(obs)) <= 1e-6:
        return ema
    if float(np.linalg.norm(ema)) <= 1e-6:
        return obs.copy()
    blended = (1.0 - alpha) * ema + alpha * obs
    norm = float(np.linalg.norm(blended))
    return (blended / norm).astype(np.float32) if norm > 1e-6 else ema
