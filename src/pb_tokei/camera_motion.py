"""Camera Motion: frame-to-frame homography tracking from each Calibration's reference frame.

Part of Tracking (ADR 0001, ADR 0006): Event Processing never reads this. Broadcast cameras
(especially the Sideline View) pan and zoom during a Play Segment, so a single Calibration only
lines up near its `reference_frame`. This module tracks how each frame in a Play Segment moves
relative to its Calibration's `reference_frame` by chaining ORB + RANSAC homographies across
keyframes and registering each frame against the visible white court lines.

Registration searches jointly (`_register_to_court_lines`): several ridge candidates per line
sample, straight-line hypotheses per court line, and homographies from two lines across the court
and two along it scored on all eight, so a logo edge or lettering beside a line cannot capture
it. The reference frame is registered too, so clicked Landmarks only seed the search. Lines are
matched through a one-coefficient lens model estimated on the reference frame (`_Lens`); each
span stores that `Lens` with its per-frame homographies of the undistorted image (ADR 0011).

Per-frame results are cached on disk outside the Rally Log as derived, rebuildable data keyed by
the Calibration, Play Segment bounds, source video fingerprint, and `METHOD_VERSION` (ADR 0006).
Frames that fail registration (cuts, whip pans, severe motion blur, wrong angle) map to nothing
so downstream positions become Unknown rather than wrong.
"""

from __future__ import annotations

import contextlib
import hashlib
import itertools
import json
import math
import os
import tempfile
import threading
from collections.abc import Callable, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple, TypeGuard

import cv2
import numpy as np

from pb_tokei.calibration import Lens
from pb_tokei.rally_log import Calibration, CameraView, Landmark, PlaySegment

if TYPE_CHECKING:
    from pb_tokei.calibration import Homography, Matrix

METHOD_VERSION = 3
"""Bump whenever the tracking algorithm changes so cached Camera Motion rebuilds everywhere."""

DEFAULT_CACHE_DIR_NAME = ".pb-tokei-cache"

# Tracking parameters.
_WORK_MAX_WIDTH = 960
_KEYFRAME_STRIDE = 15
_ORB_FEATURES = 2000
_LOWE_RATIO = 0.75
_RANSAC_REPROJ_PX = 2.5
_MIN_STEP_INLIERS = 35
_MIN_RELOC_INLIERS = 45
_MIN_RELOC_SPREAD_X = 0.25
_MIN_RELOC_SPREAD_Y = 0.20
_MAX_IMPLICIT_CHAIN_FRAMES = 1500
_MAX_CHAIN_SPAN_FRAMES = 3000
_MAX_HOMOGRAPHY_COND = 1e10

# Court-line ridge detection & verification parameters.
_SAMPLES_PER_LINE = 32
_RIDGE_THRESHOLD = 28.0
_LINE_INLIER_PX = 2.2
_MIN_VISIBLE_LINE_SAMPLES = 20
_MIN_LINE_INLIERS = 24
_MIN_LINE_INLIER_RATIO = 0.32
_MAX_MEDIAN_LINE_ERROR_FT = 0.30
_MAX_P90_LINE_ERROR_FT = 0.50
_MIN_FALLBACK_INLIERS = 100

# A court line counts as matched when this many of its visible samples (and at least
# `_MIN_LINE_SUPPORT`) sit on a detected ridge. A frame is verified only when at least
# `_MIN_LINES_PER_FAMILY` distinct lines of each family are matched (see `_LINE_FAMILY`).
_MIN_LINE_SUPPORT = 6
_MIN_LINE_SUPPORT_RATIO = 0.30
_MIN_LINES_PER_FAMILY = 2

# Court-line registration (joint, multi-hypothesis) parameters, in work-resolution pixels at
# `_WORK_MAX_WIDTH`. The anchor radius bounds how far clicked Landmarks may be from the painted
# lines on the reference frame and still be corrected.
_ANCHOR_SEARCH_PX = 40
_MAX_PEAKS_PER_SAMPLE = 3
_HYPOTHESES_PER_LINE = 3
_HYPOTHESIS_INLIER_PX = 1.5
_HYPOTHESIS_MAX_POINTS = 160
_HYPOTHESIS_MAX_ANGLE_DEG = 12.0
_SUPPORT_PX = 2.0
_NEIGHBOUR_SEARCH_FRACTION = 0.45

# Gauss-Newton line fit: Huber threshold (px) and the power of feet-per-pixel each residual is
# weighted by (2 minimises squared feet).
_GN_HUBER_PX = 1.5
_FT_WEIGHT_POWER = 2.0


class _CourtLine(NamedTuple):
    """A painted white court line: endpoints and unit normal equation `a*x + b*y + c = 0`."""

    x1: float
    y1: float
    x2: float
    y2: float
    a: float
    b: float
    c: float


def _court_line(start: Landmark, end: Landmark) -> _CourtLine:
    p1 = start.court_point
    p2 = end.court_point
    dx = p2.x - p1.x
    dy = p2.y - p1.y
    length = math.hypot(dx, dy)
    a = -dy / length
    b = dx / length
    c = -(a * p1.x + b * p1.y)
    return _CourtLine(p1.x, p1.y, p2.x, p2.y, a, b, c)


# The 8 painted white court lines, derived from `Landmark.court_point`.
_COURT_LINES: tuple[_CourtLine, ...] = (
    _court_line(Landmark.NEAR_BASELINE_LEFT, Landmark.NEAR_BASELINE_RIGHT),
    _court_line(Landmark.NEAR_KITCHEN_LEFT, Landmark.NEAR_KITCHEN_RIGHT),
    _court_line(Landmark.FAR_KITCHEN_LEFT, Landmark.FAR_KITCHEN_RIGHT),
    _court_line(Landmark.FAR_BASELINE_LEFT, Landmark.FAR_BASELINE_RIGHT),
    _court_line(Landmark.NEAR_BASELINE_LEFT, Landmark.FAR_BASELINE_LEFT),
    _court_line(Landmark.NEAR_BASELINE_RIGHT, Landmark.FAR_BASELINE_RIGHT),
    _court_line(Landmark.NEAR_BASELINE_CENTRE, Landmark.NEAR_KITCHEN_CENTRE),
    _court_line(Landmark.FAR_KITCHEN_CENTRE, Landmark.FAR_BASELINE_CENTRE),
)

# Each line is probed densely to find the stretch of it inside the frame, and its samples are spread
# over that stretch (up to `_SAMPLES_PER_LINE`, no closer than `_MIN_SAMPLE_SPACING_PX`), so a line
# mostly out of shot, like the far baseline in a corner of the Sideline View, is still sampled
# densely enough to be found. The ends are inset so samples avoid the crossing lines.
_PROBE_TS = np.linspace(0.06, 0.94, 129, dtype=np.float64)
_MIN_SAMPLE_SPACING_PX = 4.0
_LINE_STARTS = np.array([[line.x1, line.y1] for line in _COURT_LINES], dtype=np.float64)
_LINE_ENDS = np.array([[line.x2, line.y2] for line in _COURT_LINES], dtype=np.float64)
_PROBE_COURT_PTS = np.concatenate(
    [
        _LINE_STARTS[:, None, :]
        + (_LINE_ENDS - _LINE_STARTS)[:, None, :] * _PROBE_TS[None, :, None],
        np.ones((len(_COURT_LINES), len(_PROBE_TS), 1)),
    ],
    axis=2,
)
_LINE_EQS = np.array([[line.a, line.b, line.c] for line in _COURT_LINES], dtype=np.float64)


# Lines across the court (baselines, kitchen lines) fix where a point is along the court's length;
# lines along it (sidelines, centreline) fix where it is across. A frame matched only to one family
# can slide along the other unnoticed, so verification needs both. The two centreline halves lie on
# one straight line and count once (`_LINE_KEY`).
_ACROSS, _ALONG = 0, 1
_LINE_FAMILY = np.array([_ACROSS] * 4 + [_ALONG] * 4, dtype=np.int32)
_LINE_KEY = np.array([0, 1, 2, 3, 4, 5, 6, 6], dtype=np.int32)
_N_LINE_KEYS = 7
_KEY_FAMILY = np.array([_ACROSS] * 4 + [_ALONG] * 3, dtype=np.int32)
# Each key's court line as `a*x + b*y + c = 0` (feet), and the court coordinate it pins.
# Line `k` is the first line with key `k`, so the first seven lines give each key's equation.
_KEY_EQS = _LINE_EQS[:_N_LINE_KEYS]
_KEY_COORD = np.array([-22.0, -7.0, 7.0, 22.0, -10.0, 10.0, 0.0])


class CameraMotionError(RuntimeError):
    """Raised when source footage cannot be opened for Camera Motion tracking."""


class TrackingCancelledError(RuntimeError):
    """Raised internally when a superseded Camera Motion tracking job is cancelled."""


@dataclass(frozen=True)
class FrameRange:
    """An inclusive range of frames, such as a run of unmapped frames inside a Play Segment."""

    start_frame: int
    end_frame: int
    camera_view: CameraView

    @property
    def frame_count(self) -> int:
        return self.end_frame - self.start_frame + 1


@dataclass(frozen=True)
class CalibrationSpan:
    """A contiguous slice of a Play Segment governed by one Calibration."""

    start_frame: int
    end_frame: int
    camera_view: CameraView
    calibration: Calibration

    @property
    def frame_count(self) -> int:
        return self.end_frame - self.start_frame + 1


@dataclass(frozen=True)
class SpanMotion:
    """Tracked Camera Motion for one CalibrationSpan: per-frame `frame_to_ref` homographies.

    Each matrix at index `i` (frame `start_frame + i`) maps normalised image coordinates `[0, 1]^2`
    of that frame, undistorted by `lens` when there is one, to normalised image coordinates of
    `calibration_reference_frame` as the Calibration's Landmark fit sees them: composed with the
    fit (`Homography.compose(..., lens=lens)`), it gives the frame's court mapping. The reference
    frame itself maps to the identity only when its court-line registration failed and the
    clicked fit stands; otherwise its matrix corrects the clicks onto the painted lines (ADR 0010).
    When `mapped[i]` is False, the frame could not be registered and has no court mapping.
    `line_error_ft[i]` is the median court-line residual of the frame's registration.

    `lens` is the span's lens, estimated on the reference frame (ADR 0011), or None when it was
    not estimated (the reference frame did not register) or is negligible.
    """

    start_frame: int
    end_frame: int
    camera_view: CameraView
    calibration_effective_from: int
    calibration_reference_frame: int
    mapped: np.ndarray  # shape (N,), dtype bool
    matrices: np.ndarray  # shape (N, 3, 3), dtype float64
    line_error_ft: np.ndarray  # shape (N,), dtype float32 (NaN when unmapped)
    lens: Lens | None = None

    @property
    def frame_count(self) -> int:
        return self.end_frame - self.start_frame + 1

    @property
    def mapped_count(self) -> int:
        return int(np.count_nonzero(self.mapped))

    @property
    def unmapped_count(self) -> int:
        return self.frame_count - self.mapped_count

    def contains(self, frame: int) -> bool:
        return self.start_frame <= frame <= self.end_frame

    def at(self, frame: int) -> Matrix | None:
        """The normalised `frame_to_ref` homography at `frame`, or None if unmapped or out."""
        if not self.contains(frame):
            return None
        idx = frame - self.start_frame
        if not bool(self.mapped[idx]):
            return None
        return self.matrices[idx]

    def error_ft_at(self, frame: int) -> float | None:
        """Median court-line residual in feet at `frame`, or None if unmapped or out of span."""
        if not self.contains(frame):
            return None
        idx = frame - self.start_frame
        if not bool(self.mapped[idx]):
            return None
        val = float(self.line_error_ft[idx])
        return None if math.isnan(val) else val

    def unmapped_ranges(self) -> list[FrameRange]:
        """Contiguous inclusive ranges of frames in this span that failed registration."""
        unmapped = ~self.mapped
        if not np.any(unmapped):
            return []
        padded = np.concatenate(([False], unmapped, [False]))
        diff = np.diff(padded.astype(np.int8))
        starts = np.flatnonzero(diff == 1)
        ends = np.flatnonzero(diff == -1) - 1
        return [
            FrameRange(
                start_frame=self.start_frame + int(s),
                end_frame=self.start_frame + int(e),
                camera_view=self.camera_view,
            )
            for s, e in zip(starts, ends, strict=True)
        ]


class CameraMotion:
    """Tracked Camera Motion across a Match's Play Segments."""

    def __init__(self, spans: Sequence[SpanMotion] = ()) -> None:
        self._spans = tuple(sorted(spans, key=lambda s: s.start_frame))

    @property
    def spans(self) -> tuple[SpanMotion, ...]:
        return self._spans

    def span_at(self, frame: int) -> SpanMotion | None:
        for span in self._spans:
            if span.contains(frame):
                return span
        return None

    def covers(self, frame: int) -> bool:
        return self.span_at(frame) is not None

    def at(self, frame: int) -> Matrix | None:
        """The normalised `frame_to_ref` homography at `frame`, or None if unmapped/untracked."""
        span = self.span_at(frame)
        return None if span is None else span.at(frame)

    def lens_at(self, frame: int) -> Lens | None:
        """The lens `at(frame)` expects its image points undistorted by, or None for none."""
        span = self.span_at(frame)
        return None if span is None else span.lens

    def unmapped_ranges(self) -> list[FrameRange]:
        """All contiguous unmapped frame ranges across tracked spans, in frame order."""
        ranges: list[FrameRange] = []
        for span in self._spans:
            ranges.extend(span.unmapped_ranges())
        return ranges


def calibration_spans(
    segments: Sequence[PlaySegment], calibrations: Sequence[Calibration]
) -> list[CalibrationSpan]:
    """Splits each Play Segment into contiguous spans governed by one Calibration."""
    from pb_tokei.calibration import calibration_at

    spans: list[CalibrationSpan] = []
    for segment in sorted(segments, key=lambda s: s.start_frame):
        of_view = sorted(
            (c for c in calibrations if c.camera_view is segment.camera_view),
            key=lambda c: c.effective_from_frame,
        )
        if not of_view:
            continue
        cuts = [
            c.effective_from_frame
            for c in of_view
            if segment.start_frame < c.effective_from_frame <= segment.end_frame
        ]
        boundaries = [segment.start_frame, *cuts, segment.end_frame + 1]
        for start, next_start in itertools.pairwise(boundaries):
            cal = calibration_at(of_view, segment.camera_view, start)
            if cal is not None:
                spans.append(CalibrationSpan(start, next_start - 1, segment.camera_view, cal))
    return spans


_FRAME_COUNT_CACHE_LOCK = threading.Lock()
_FRAME_COUNT_CACHE: dict[tuple[str, int, int], int | None] = {}


def video_frame_count(video_path: Path | None) -> int | None:
    """Returns the positive frame count of `video_path`, or None if unreadable/not a video."""
    if video_path is None or not video_path.is_file():
        return None
    try:
        stat = video_path.stat()
    except OSError:
        return None
    key = (str(video_path), stat.st_size, stat.st_mtime_ns)
    with _FRAME_COUNT_CACHE_LOCK:
        if key in _FRAME_COUNT_CACHE:
            return _FRAME_COUNT_CACHE[key]
    cap = cv2.VideoCapture(str(video_path))
    count: int | None = None
    try:
        if cap.isOpened():
            raw = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            if raw > 0:
                count = raw
    finally:
        cap.release()
    if count is not None:
        with _FRAME_COUNT_CACHE_LOCK:
            if len(_FRAME_COUNT_CACHE) > 128:
                _FRAME_COUNT_CACHE.clear()
            _FRAME_COUNT_CACHE[key] = count
    return count


class _WorkGrid(NamedTuple):
    """Work-resolution dimensions and normalised <-> work-pixel scaling matrices."""

    sw: int
    sh: int
    s_norm_to_w: Matrix
    s_w_to_norm: Matrix


def _work_scale(cap: cv2.VideoCapture) -> _WorkGrid | None:
    """Computes work-resolution dimensions and scaling transforms for an open capture."""
    orig_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    orig_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if orig_w <= 0 or orig_h <= 0:
        return None
    scale = min(1.0, _WORK_MAX_WIDTH / orig_w)
    sw = max(1, int(round(orig_w * scale)))
    sh = max(1, int(round(orig_h * scale)))
    s_norm_to_w = np.array([[sw, 0.0, 0.0], [0.0, sh, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    s_w_to_norm = np.array(
        [[1.0 / sw, 0.0, 0.0], [0.0, 1.0 / sh, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64
    )
    return _WorkGrid(sw=sw, sh=sh, s_norm_to_w=s_norm_to_w, s_w_to_norm=s_w_to_norm)


def _accepts_reloc(
    h: Matrix | None, inliers: int, spread_ok: bool, sw: int, sh: int
) -> TypeGuard[Matrix]:
    """Whether a direct / relocalisation feature homography passes quality and sanity gates."""
    return (
        h is not None
        and inliers >= _MIN_RELOC_INLIERS
        and spread_ok
        and _is_sane_homography(h, sw, sh, strict_step=False)
    )


def _accepts_step(
    h: Matrix | None,
    inliers: int,
    spread_ok: bool,
    sw: int,
    sh: int,
    *,
    require_spread: bool = False,
) -> TypeGuard[Matrix]:
    """Whether a keyframe-to-keyframe feature homography passes step gates."""
    return (
        h is not None
        and inliers >= _MIN_STEP_INLIERS
        and (not require_spread or spread_ok)
        and _is_sane_homography(h, sw, sh, strict_step=True)
    )


def default_cache_dir(db_path: Path) -> Path:
    """Where rebuildable Camera Motion caches live beside a Rally Log database."""
    return db_path.parent / DEFAULT_CACHE_DIR_NAME / "camera_motion"


# --- Cache --------------------------------------------------------------------------------


def span_cache_key(
    video_path: Path,
    span: CalibrationSpan,
    *,
    method_version: int = METHOD_VERSION,
) -> str:
    """Stable hash keying a span's Camera Motion to its Calibration, bounds, video and version."""
    stat = video_path.stat()
    cal = span.calibration
    payload = {
        "method_version": method_version,
        "video": {
            "name": video_path.name,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        },
        "span": {
            "start_frame": span.start_frame,
            "end_frame": span.end_frame,
            "camera_view": span.camera_view.value,
        },
        "calibration": {
            "camera_view": cal.camera_view.value,
            "effective_from_frame": cal.effective_from_frame,
            "reference_frame": cal.reference_frame,
            "landmarks": {
                lm.value: [cal.landmarks[lm].x, cal.landmarks[lm].y, cal.landmarks[lm].frame]
                for lm in sorted(cal.landmarks, key=lambda item: item.value)
            },
        },
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


def landmark_reg_cache_key(
    video_path: Path,
    reference_frame: int,
    source_frame: int,
    *,
    allow_chain: bool,
    method_version: int = METHOD_VERSION,
) -> str:
    """Stable hash keying a single `source_frame -> reference_frame` Landmark registration."""
    stat = video_path.stat()
    payload = {
        "kind": "landmark_reg",
        "method_version": method_version,
        "video": {
            "name": video_path.name,
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
        },
        "reference_frame": reference_frame,
        "source_frame": source_frame,
        "allow_chain": allow_chain,
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:32]


class CameraMotionCache:
    """Disk-backed, rebuildable cache of per-span Camera Motion (ADR 0006)."""

    def __init__(self, cache_dir: Path, *, method_version: int = METHOD_VERSION) -> None:
        self._dir = cache_dir
        self._method_version = method_version

    @property
    def cache_dir(self) -> Path:
        return self._dir

    def _path_for(self, video_path: Path, span: CalibrationSpan) -> Path:
        key = span_cache_key(video_path, span, method_version=self._method_version)
        return self._dir / f"{key}.npz"

    def _reg_path_for(
        self, video_path: Path, reference_frame: int, source_frame: int, *, allow_chain: bool
    ) -> Path:
        key = landmark_reg_cache_key(
            video_path,
            reference_frame,
            source_frame,
            allow_chain=allow_chain,
            method_version=self._method_version,
        )
        return self._dir / f"reg_{key}.npz"

    def _get_reg(
        self, video_path: Path, reference_frame: int, source_frame: int, *, allow_chain: bool
    ) -> tuple[bool, Matrix | None]:
        """Returns `(cache_hit, matrix_or_none)` for a cached frame-to-reference registration."""
        if not video_path.is_file():
            return False, None
        path = self._reg_path_for(
            video_path, reference_frame, source_frame, allow_chain=allow_chain
        )
        if not path.is_file():
            return False, None
        try:
            with np.load(path) as data:
                if int(data["method_version"]) != self._method_version:
                    return False, None
                mapped = bool(data["mapped"])
                matrix = np.array(data["matrix"], dtype=np.float64)
        except OSError, ValueError, KeyError:
            return False, None
        if matrix.shape != (3, 3):
            return False, None
        return True, (matrix if mapped else None)

    def _put_reg(
        self,
        video_path: Path,
        reference_frame: int,
        source_frame: int,
        matrix: Matrix | None,
        *,
        allow_chain: bool,
    ) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        target = self._reg_path_for(
            video_path, reference_frame, source_frame, allow_chain=allow_chain
        )
        fd, raw_tmp = tempfile.mkstemp(dir=self._dir, prefix=".reg-", suffix=".tmp.npz")
        os.close(fd)
        tmp = Path(raw_tmp)
        try:
            np.savez_compressed(
                tmp,
                method_version=np.int32(self._method_version),
                mapped=np.bool_(matrix is not None),
                matrix=(
                    np.eye(3, dtype=np.float64) if matrix is None else matrix.astype(np.float64)
                ),
            )
            tmp.replace(target)
        except BaseException:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            raise

    def register_calibration_frames(
        self,
        video_path: Path | None,
        calibration: Calibration,
        segments: Sequence[PlaySegment] = (),
        *,
        cancel: threading.Event | None = None,
    ) -> dict[int, Matrix]:
        """Returns normalised `frame -> reference_frame` matrices for off-reference Landmarks.

        Results are cached on disk beside span motion caches. Out-of-bounds frames and transient
        video open/decode failures are never cached as permanent unmapped entries.
        """
        ref_f = calibration.reference_frame
        other_frames = sorted({p.frame for p in calibration.landmarks.values() if p.frame != ref_f})
        if not other_frames or video_path is None or not video_path.is_file():
            return {}

        frame_count = video_frame_count(video_path)
        if frame_count is not None:
            if ref_f >= frame_count:
                return {}
            other_frames = [f for f in other_frames if f < frame_count]
            if not other_frames:
                return {}

        ref_seg = next(
            (s for s in segments if s.camera_view is calibration.camera_view and s.contains(ref_f)),
            None,
        )
        chain_frames: set[int] = set()
        for src_f in other_frames:
            if abs(src_f - ref_f) > _MAX_CHAIN_SPAN_FRAMES:
                continue
            if ref_seg is not None:
                if ref_seg.contains(src_f):
                    chain_frames.add(src_f)
            elif not segments and abs(src_f - ref_f) <= _MAX_IMPLICIT_CHAIN_FRAMES:
                chain_frames.add(src_f)

        result: dict[int, Matrix] = {}
        uncached: list[int] = []
        for src_f in other_frames:
            hit, matrix = self._get_reg(
                video_path, ref_f, src_f, allow_chain=(src_f in chain_frames)
            )
            if hit:
                if matrix is not None:
                    result[src_f] = matrix
            else:
                uncached.append(src_f)

        if uncached:
            computed = register_frames_to_reference(
                video_path,
                ref_f,
                uncached,
                chain_frames=chain_frames & set(uncached),
                cancel=cancel,
            )
            for src_f in uncached:
                if src_f not in computed:
                    # Capture/decode failure: leave uncached so a later call can retry.
                    continue
                mat = computed[src_f]
                self._put_reg(video_path, ref_f, src_f, mat, allow_chain=(src_f in chain_frames))
                if mat is not None:
                    result[src_f] = mat
        return result

    def landmark_frame_to_ref(
        self,
        video_path: Path | None,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        *,
        cancel: threading.Event | None = None,
    ) -> dict[tuple[CameraView, int], dict[int, Matrix]]:
        """Maps `(camera_view, effective_from_frame)` to off-reference Landmark transforms."""
        if video_path is None or not video_path.is_file():
            return {}
        out: dict[tuple[CameraView, int], dict[int, Matrix]] = {}
        for cal in calibrations:
            if not cal.has_off_reference_landmarks:
                continue
            f2r = self.register_calibration_frames(video_path, cal, segments, cancel=cancel)
            if f2r:
                out[(cal.camera_view, cal.effective_from_frame)] = f2r
        return out

    def get(self, video_path: Path, span: CalibrationSpan) -> SpanMotion | None:
        """Loads a cached SpanMotion if present and valid, else returns None."""
        if not video_path.is_file():
            return None
        path = self._path_for(video_path, span)
        if not path.is_file():
            return None
        try:
            with np.load(path) as data:
                if int(data["method_version"]) != self._method_version:
                    return None
                mapped = np.array(data["mapped"], dtype=bool)
                matrices = np.array(data["matrices"], dtype=np.float64)
                line_error_ft = np.array(data["line_error_ft"], dtype=np.float32)
                lens_k1 = float(data["lens_k1"])
                lens_aspect = float(data["lens_aspect"])
        except OSError, ValueError, KeyError:
            return None
        expected_n = span.frame_count
        if (
            mapped.shape != (expected_n,)
            or matrices.shape != (expected_n, 3, 3)
            or line_error_ft.shape != (expected_n,)
            or not math.isfinite(lens_k1)
            or not (math.isfinite(lens_aspect) and lens_aspect > 0)
        ):
            return None
        return SpanMotion(
            start_frame=span.start_frame,
            end_frame=span.end_frame,
            camera_view=span.camera_view,
            calibration_effective_from=span.calibration.effective_from_frame,
            calibration_reference_frame=span.calibration.reference_frame,
            mapped=mapped,
            matrices=matrices,
            line_error_ft=line_error_ft,
            lens=Lens(lens_k1, lens_aspect) if lens_k1 != 0.0 else None,
        )

    def put(self, video_path: Path, span: CalibrationSpan, motion: SpanMotion) -> None:
        """Atomically writes a SpanMotion to the cache directory."""
        self._dir.mkdir(parents=True, exist_ok=True)
        target = self._path_for(video_path, span)
        fd, raw_tmp = tempfile.mkstemp(dir=self._dir, prefix=".motion-", suffix=".tmp.npz")
        os.close(fd)
        tmp = Path(raw_tmp)
        try:
            np.savez_compressed(
                tmp,
                method_version=np.int32(self._method_version),
                mapped=motion.mapped.astype(bool),
                matrices=motion.matrices.astype(np.float64),
                line_error_ft=motion.line_error_ft.astype(np.float32),
                lens_k1=np.float64(0.0 if motion.lens is None else motion.lens.k1),
                lens_aspect=np.float64(1.0 if motion.lens is None else motion.lens.aspect),
            )
            tmp.replace(target)
        except BaseException:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            raise

    def get_or_track(
        self,
        video_path: Path,
        span: CalibrationSpan,
        base_homography: Homography,
        *,
        cancel: threading.Event | None = None,
    ) -> SpanMotion:
        """Returns cached Camera Motion for `span`, or tracks and caches it."""
        _check_cancelled(cancel)
        cached = self.get(video_path, span)
        if cached is not None:
            return cached
        motion = track_span(video_path, span, base_homography, cancel=cancel)
        _check_cancelled(cancel)
        self.put(video_path, span, motion)
        return motion

    def load_cached(
        self,
        video_path: Path,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
    ) -> tuple[CameraMotion, list[tuple[CalibrationSpan, Homography]]]:
        """Loads all cached spans for a Match and returns any complete spans not yet cached."""
        from pb_tokei.calibration import assess

        cached_spans: list[SpanMotion] = []
        missing: list[tuple[CalibrationSpan, Homography]] = []
        reg_cache: dict[tuple[CameraView, int], dict[int, Matrix]] = {}
        for span in calibration_spans(segments, calibrations):
            cal = span.calibration
            cal_key = (cal.camera_view, cal.effective_from_frame)
            if cal.has_off_reference_landmarks and cal_key not in reg_cache:
                reg_cache[cal_key] = self.register_calibration_frames(video_path, cal, segments)
            base = assess(cal, frame_to_ref=reg_cache.get(cal_key)).homography
            if base is None:
                continue
            hit = self.get(video_path, span)
            if hit is not None:
                cached_spans.append(hit)
            else:
                missing.append((span, base))
        return CameraMotion(cached_spans), missing

    def track_match(
        self,
        video_path: Path,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        *,
        on_span_done: Callable[[SpanMotion], None] | None = None,
        cancel: threading.Event | None = None,
    ) -> CameraMotion:
        """Ensures every complete CalibrationSpan in a Match is tracked and cached."""
        motion, missing = self.load_cached(video_path, segments, calibrations)
        spans = list(motion.spans)
        for span, base in missing:
            _check_cancelled(cancel)
            tracked = self.get_or_track(video_path, span, base, cancel=cancel)
            spans.append(tracked)
            if on_span_done is not None:
                on_span_done(tracked)
        return CameraMotion(spans)


# --- Landmark frame registration ----------------------------------------------------------


def register_frames_to_reference(
    video_path: Path,
    reference_frame: int,
    source_frames: Sequence[int],
    *,
    chain_frames: AbstractSet[int] = frozenset(),
    keyframe_stride: int = _KEYFRAME_STRIDE,
    cancel: threading.Event | None = None,
) -> dict[int, Matrix | None]:
    """Estimates normalised `source_frame -> reference_frame` homographies via image features.

    For each `src_f` in `source_frames`:
    - If `src_f == reference_frame`, maps to the identity matrix.
    - First tries direct ORB + USAC_MAGSAC matching from `src_f` to `reference_frame`.
    - If `src_f in chain_frames` and direct matching fails (e.g. a wide pan within one Play
      Segment), chains ORB + USAC_MAGSAC across intermediate keyframes at `keyframe_stride`.
    - Maps an attempted frame to None when registration fails. Frames where video open or frame
      decoding failed are omitted from the returned dict so callers do not cache transient errors.
    """
    _check_cancelled(cancel)
    result: dict[int, Matrix | None] = {}
    unique_others: list[int] = []
    for src_f in sorted(set(source_frames)):
        if src_f == reference_frame:
            result[src_f] = np.eye(3, dtype=np.float64)
        else:
            unique_others.append(src_f)
    if not unique_others or not video_path.is_file():
        return result

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return result
    try:
        return _register_frames_open(
            cap,
            reference_frame,
            unique_others,
            result,
            chain_frames=chain_frames,
            keyframe_stride=keyframe_stride,
            cancel=cancel,
        )
    finally:
        cap.release()


def _register_frames_open(
    cap: cv2.VideoCapture,
    reference_frame: int,
    unique_others: list[int],
    result: dict[int, Matrix | None],
    *,
    chain_frames: AbstractSet[int],
    keyframe_stride: int,
    cancel: threading.Event | None,
) -> dict[int, Matrix | None]:
    grid = _work_scale(cap)
    if grid is None:
        return result

    ref_gray = _read_gray_frame(cap, reference_frame, grid)
    if ref_gray is None:
        return result

    detector: Any = cv2.ORB.create(_ORB_FEATURES)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    ref_feats = detector.detectAndCompute(ref_gray, None)

    direct, need_chain = _match_direct_frames(
        cap,
        grid,
        ref_feats,
        unique_others,
        chain_frames,
        detector,
        matcher,
        cancel,
    )
    result.update(direct)

    if not need_chain:
        return result

    lo = min(reference_frame, *need_chain)
    hi = max(reference_frame, *need_chain)
    step = max(1, min(keyframe_stride, max(1, (hi - lo) // 4)))
    kf_set = set(range(lo, hi + 1, step)) | {lo, hi, reference_frame, *need_chain}
    kf_gray = _decode_gray_keyframes(cap, lo, hi, kf_set, grid, cancel)
    if reference_frame not in kf_gray:
        return result

    available_kfs = sorted(kf_gray)
    feat_mask = _estimate_static_mask([kf_gray[f] for f in available_kfs])
    kf_feats: dict[int, tuple[Any, np.ndarray | None]] = {
        f: detector.detectAndCompute(kf_gray[f], feat_mask) for f in available_kfs
    }
    kf_to_ref = _chain_to_reference(available_kfs, reference_frame, kf_feats, matcher, grid, cancel)

    for src_f in need_chain:
        h_w = kf_to_ref.get(src_f)
        if h_w is not None:
            result[src_f] = _work_homography_to_norm(h_w, grid.s_norm_to_w, grid.s_w_to_norm)
    return result


def _read_gray_frame(cap: cv2.VideoCapture, frame_idx: int, grid: _WorkGrid) -> np.ndarray | None:
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ok, bgr = cap.read()
    if not ok or bgr is None:
        return None
    return cv2.cvtColor(_resize_work(bgr, grid.sw, grid.sh), cv2.COLOR_BGR2GRAY)


def _match_direct_frames(
    cap: cv2.VideoCapture,
    grid: _WorkGrid,
    ref_feats: tuple[Any, np.ndarray | None],
    source_frames: Sequence[int],
    chain_frames: AbstractSet[int],
    detector: Any,
    matcher: cv2.BFMatcher,
    cancel: threading.Event | None,
) -> tuple[dict[int, Matrix | None], list[int]]:
    """Attempts direct feature registration from each source frame to `reference_frame`."""
    direct: dict[int, Matrix | None] = {}
    need_chain: list[int] = []
    for src_f in source_frames:
        _check_cancelled(cancel)
        src_gray = _read_gray_frame(cap, src_f, grid)
        if src_gray is None:
            continue
        direct[src_f] = None
        src_feats = detector.detectAndCompute(src_gray, None)
        h_step, inliers, spread_ok = _match_features(
            src_feats, ref_feats, matcher, grid.sw, grid.sh
        )
        if _accepts_reloc(h_step, inliers, spread_ok, grid.sw, grid.sh):
            f2r = _work_homography_to_norm(h_step, grid.s_norm_to_w, grid.s_w_to_norm)
            if f2r is not None:
                direct[src_f] = f2r
                continue
        if src_f in chain_frames:
            need_chain.append(src_f)
    return direct, need_chain


def _decode_gray_keyframes(
    cap: cv2.VideoCapture,
    lo: int,
    hi: int,
    kf_set: AbstractSet[int],
    grid: _WorkGrid,
    cancel: threading.Event | None,
) -> dict[int, np.ndarray]:
    """Grabs sequentially from `lo` to `hi`, decoding only frames in `kf_set` as grayscale."""
    cap.set(cv2.CAP_PROP_POS_FRAMES, lo)
    kf_gray: dict[int, np.ndarray] = {}
    for f in range(lo, hi + 1):
        if (f - lo) % 30 == 0:
            _check_cancelled(cancel)
        if not cap.grab():
            break
        if f in kf_set:
            ok, bgr = cap.retrieve()
            if not ok or bgr is None:
                continue
            kf_gray[f] = cv2.cvtColor(_resize_work(bgr, grid.sw, grid.sh), cv2.COLOR_BGR2GRAY)
    return kf_gray


def _chain_to_reference(
    available_kfs: Sequence[int],
    reference_frame: int,
    kf_feats: dict[int, tuple[Any, np.ndarray | None]],
    matcher: cv2.BFMatcher,
    grid: _WorkGrid,
    cancel: threading.Event | None,
) -> dict[int, Matrix]:
    """Walks outward from `reference_frame` across keyframes, preferring direct matches."""
    kf_to_ref: dict[int, Matrix] = {reference_frame: np.eye(3, dtype=np.float64)}
    ref_pos = available_kfs.index(reference_frame)

    def walk(indices: Sequence[int]) -> None:
        last_good: int | None = reference_frame
        prev_mapped = True
        for idx_k in indices:
            _check_cancelled(cancel)
            cur_f = available_kfs[idx_k]
            h_dir, inliers_d, spread_d = _match_features(
                kf_feats[cur_f], kf_feats[reference_frame], matcher, grid.sw, grid.sh
            )
            if _accepts_reloc(h_dir, inliers_d, spread_d, grid.sw, grid.sh):
                kf_to_ref[cur_f] = h_dir
                last_good = cur_f
                prev_mapped = True
                continue
            if prev_mapped and last_good is not None:
                h_step, inliers_s, spread_s = _match_features(
                    kf_feats[cur_f], kf_feats[last_good], matcher, grid.sw, grid.sh
                )
                if _accepts_step(
                    h_step, inliers_s, spread_s, grid.sw, grid.sh, require_spread=True
                ):
                    chained = kf_to_ref[last_good] @ h_step
                    if (
                        np.all(np.isfinite(chained))
                        and np.linalg.cond(chained) < _MAX_HOMOGRAPHY_COND
                    ):
                        kf_to_ref[cur_f] = _normalise_h(chained)
                        last_good = cur_f
                        prev_mapped = True
                        continue
            prev_mapped = False

    walk(list(range(ref_pos + 1, len(available_kfs))))
    walk(list(range(ref_pos - 1, -1, -1)))
    return kf_to_ref


def _work_homography_to_norm(
    h_w: Matrix, s_norm_to_w: Matrix, s_w_to_norm: Matrix
) -> Matrix | None:
    """Converts a work-pixel `src -> ref` matrix into a normalised `[0, 1]^2` `src -> ref` one."""
    f2r = s_w_to_norm @ h_w @ s_norm_to_w
    if not np.all(np.isfinite(f2r)) or np.linalg.cond(f2r) > _MAX_HOMOGRAPHY_COND:
        return None
    w_center = float(f2r[2, 0] * 0.5 + f2r[2, 1] * 0.5 + f2r[2, 2])
    if w_center < 0:
        f2r = -f2r
    norm = float(np.linalg.norm(f2r))
    return None if norm < 1e-12 else f2r / norm


# --- Tracking algorithm -------------------------------------------------------------------


def _check_cancelled(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise TrackingCancelledError("Camera Motion tracking cancelled")


@dataclass(frozen=True)
class _LineStats:
    n_vis: int
    n_obs: int
    n_inliers: int
    n_lines: int
    med_px: float
    med_ft: float
    p90_ft: float
    n_across: int = 0
    n_along: int = 0


_EMPTY_LINE_STATS = _LineStats(0, 0, 0, 0, math.inf, math.inf, math.inf)


def track_span(
    video_path: Path,
    span: CalibrationSpan,
    base_homography: Homography,
    *,
    keyframe_stride: int = _KEYFRAME_STRIDE,
    cancel: threading.Event | None = None,
) -> SpanMotion:
    """Tracks Camera Motion across every frame of `span` from `video_path`.

    1. Reads keyframes spaced by `keyframe_stride` (plus span endpoints and `reference_frame`),
       masks static broadcast overlays (scorebug) when the camera moves, and chains ORB +
       USAC_MAGSAC homographies outward from `reference_frame`, refining each keyframe against
       the detected white court lines to eliminate drift.
    2. Streams every frame in a second O(1)-memory pass, interpolating between consecutive
       mapped keyframes and running fast court-line refinement + verification, while stepping
       frame-by-frame across mapped/unmapped boundaries to pinpoint cuts.
    """
    _check_cancelled(cancel)
    if not video_path.is_file():
        raise CameraMotionError(f"Source video not found: {video_path}")
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise CameraMotionError(f"Could not open video: {video_path}")

    try:
        return _track_span_open(
            cap, span, base_homography, keyframe_stride=keyframe_stride, cancel=cancel
        )
    finally:
        cap.release()


def _track_span_open(
    cap: cv2.VideoCapture,
    span: CalibrationSpan,
    base_homography: Homography,
    *,
    keyframe_stride: int,
    cancel: threading.Event | None = None,
) -> SpanMotion:
    grid = _work_scale(cap)
    if grid is None:
        raise CameraMotionError("Video has invalid frame dimensions")

    sw, sh, s_norm_to_w, s_w_to_norm = grid
    flank = max(3, int(round(5 * sw / 960)))
    r_wide = max(10, int(round(16 * sw / 960)))
    r_narrow = max(4, int(round(6 * sw / 960)))
    r_anchor = max(r_wide, int(round(_ANCHOR_SEARCH_PX * sw / 960)))
    h_court_to_ref_w = s_norm_to_w @ base_homography.court_to_image

    start_f = span.start_frame
    end_f = span.end_frame
    ref_f = span.calibration.reference_frame
    n_frames = span.frame_count

    mapped = np.zeros(n_frames, dtype=bool)
    matrices = np.broadcast_to(np.eye(3, dtype=np.float64), (n_frames, 3, 3)).copy()
    line_error_ft = np.full(n_frames, np.nan, dtype=np.float32)

    ref_inside = start_f <= ref_f <= end_f
    kf_set = set(range(start_f, end_f + 1, max(1, keyframe_stride))) | {start_f, end_f}
    if ref_inside:
        kf_set.add(ref_f)
    kf_frames = sorted(kf_set)

    # Read external reference frame if it sits outside this span.
    ref_gray_ext: np.ndarray | None = None
    ref_score_ext: np.ndarray | None = None
    if not ref_inside:
        cap.set(cv2.CAP_PROP_POS_FRAMES, ref_f)
        ok, ref_bgr = cap.read()
        if ok and ref_bgr is not None:
            ref_small = _resize_work(ref_bgr, sw, sh)
            ref_gray_ext = cv2.cvtColor(ref_small, cv2.COLOR_BGR2GRAY)
            ref_score_ext = _white_score(ref_small)

    # Pass 1: grab sequentially through span, decoding only keyframes.
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_f)
    kf_gray: dict[int, np.ndarray] = {}
    kf_score: dict[int, np.ndarray] = {}
    for f in range(start_f, end_f + 1):
        if (f - start_f) % 30 == 0:
            _check_cancelled(cancel)
        if not cap.grab():
            break
        if f in kf_set:
            ok, bgr = cap.retrieve()
            if not ok or bgr is None:
                continue
            small = _resize_work(bgr, sw, sh)
            kf_gray[f] = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
            kf_score[f] = _white_score(small)

    available_kfs = [f for f in kf_frames if f in kf_gray]
    if not available_kfs:
        return _build_span_motion(span, mapped, matrices, line_error_ft)

    # Detect static overlay graphic (scorebug) when the camera moves.
    feat_mask = _estimate_static_mask([kf_gray[f] for f in available_kfs])

    detector: Any = cv2.ORB.create(_ORB_FEATURES)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    kf_feats: dict[int, tuple[Any, np.ndarray | None]] = {
        f: detector.detectAndCompute(kf_gray[f], feat_mask) for f in available_kfs
    }
    ref_feats: tuple[Any, np.ndarray | None] | None = None
    if ref_inside and ref_f in kf_feats:
        ref_feats = kf_feats[ref_f]
    elif ref_gray_ext is not None:
        ref_feats = detector.detectAndCompute(ref_gray_ext, feat_mask)

    # `kf_c2p` holds `court -> undistorted work px` (see `_Lens`); stored frames keep that, and the
    # span carries the lens (`SpanMotion.lens`).
    kf_c2p: dict[int, Matrix] = {}
    kf_err: dict[int, float] = {}

    # The clicked Landmarks only approximate the reference frame's court lines: to a few pixels
    # when clicked carefully, by feet when a click is off-target or pinned to the frame edge. Every
    # other frame is tracked from the reference frame, so register it against the painted lines
    # too (estimating the lens on the way), and keep the clicked fit only when that won't verify.
    ref_score = kf_score.get(ref_f) if ref_inside else ref_score_ext
    lens = _Lens.none(sw, sh)
    h_anchor = h_court_to_ref_w
    anchor_err_ft: float | None = None
    if ref_score is not None:
        anchored = _anchor_to_court_lines(
            ref_score, h_court_to_ref_w, search_radius=r_anchor, flank=flank, valid_mask=feat_mask
        )
        if anchored is not None:
            h_anchor, anchor_err_ft, lens = anchored

    def register(score: np.ndarray, h_init: Matrix, radius: int) -> tuple[Matrix, _LineStats]:
        return _register_frame(
            score,
            h_init,
            search_radius=radius,
            r_wide=r_wide,
            r_narrow=r_narrow,
            flank=flank,
            valid_mask=feat_mask,
            lens=lens,
        )

    def try_relocalize(target_f: int, anchor_feats: Any, anchor_c2p: Matrix) -> bool:
        h_step, inliers, spread_ok = _match_features(
            kf_feats[target_f], anchor_feats, matcher, sw, sh
        )
        if not _accepts_reloc(h_step, inliers, spread_ok, sw, sh):
            return False
        h_init = _safe_inv(h_step)
        if h_init is None:
            return False
        h_init = h_init @ anchor_c2p
        h_ref, st = register(kf_score[target_f], h_init, r_anchor)
        if not _frame_accepted(st, feature_inliers=inliers):
            return False
        kf_c2p[target_f] = h_ref
        kf_err[target_f] = st.med_ft if math.isfinite(st.med_ft) else 0.0
        return True

    def try_step(cur_f: int, prev_f: int) -> bool:
        h_step, inliers, spread_ok = _match_features(
            kf_feats[cur_f], kf_feats[prev_f], matcher, sw, sh
        )
        if not _accepts_step(h_step, inliers, spread_ok, sw, sh):
            return False
        h_inv = _safe_inv(h_step)
        if h_inv is None:
            return False
        h_init = h_inv @ kf_c2p[prev_f]
        h_ref, st = register(kf_score[cur_f], h_init, r_anchor)
        if not _frame_accepted(st, feature_inliers=inliers):
            return False
        kf_c2p[cur_f] = h_ref
        kf_err[cur_f] = st.med_ft if math.isfinite(st.med_ft) else 0.0
        return True

    def walk(indices: Sequence[int], seed_f: int | None) -> None:
        last_good = seed_f
        prev_mapped = seed_f is not None
        for idx_k in indices:
            _check_cancelled(cancel)
            cur_f = available_kfs[idx_k]
            if cur_f in kf_c2p:
                last_good = cur_f
                prev_mapped = True
                continue
            ok = False
            if prev_mapped and last_good is not None:
                ok = try_step(cur_f, last_good)
            if not ok and ref_feats is not None:
                ok = try_relocalize(cur_f, ref_feats, h_anchor)
            if not ok and last_good is not None and last_good != ref_f:
                ok = try_relocalize(cur_f, kf_feats[last_good], kf_c2p[last_good])
            if ok:
                last_good = cur_f
                prev_mapped = True
            else:
                prev_mapped = False

    if ref_inside and ref_f in kf_gray:
        kf_c2p[ref_f] = h_anchor
        kf_err[ref_f] = 0.0 if anchor_err_ft is None else anchor_err_ft
        ref_pos = available_kfs.index(ref_f)
        walk(list(range(ref_pos + 1, len(available_kfs))), ref_f)
        walk(list(range(ref_pos - 1, -1, -1)), ref_f)
    else:
        # Reference frame is outside this span: walk forward relocalizing against reference_frame,
        # then fill backward from the first recovered keyframe if needed.
        walk(list(range(len(available_kfs))), None)
        first_good_pos = next((i for i, f in enumerate(available_kfs) if f in kf_c2p), None)
        if first_good_pos is not None and first_good_pos > 0:
            walk(list(range(first_good_pos - 1, -1, -1)), available_kfs[first_good_pos])

    # Record keyframe results directly.
    def store_frame(frame: int, h_c2p_w: Matrix, err_ft: float) -> None:
        f2r = _court_to_frame_as_frame_to_ref(h_c2p_w, base_homography.court_to_image, s_w_to_norm)
        if f2r is None:
            return
        idx = frame - start_f
        mapped[idx] = True
        matrices[idx] = f2r
        line_error_ft[idx] = np.float32(err_ft)

    for f, h_w in kf_c2p.items():
        if f == ref_f and anchor_err_ft is None:
            # The clicked fit stands: the reference frame maps to itself.
            idx = f - start_f
            mapped[idx] = True
            matrices[idx] = np.eye(3, dtype=np.float64)
            line_error_ft[idx] = np.float32(0.0)
        else:
            store_frame(f, h_w, kf_err[f])

    # Pass 2: stream intermediate frames in O(1) memory between consecutive keyframes.
    if len(available_kfs) >= 2:
        _fill_intermediate_frames(
            cap=cap,
            available_kfs=available_kfs,
            kf_c2p=kf_c2p,
            sw=sw,
            sh=sh,
            r_wide=r_wide,
            r_narrow=r_narrow,
            flank=flank,
            feat_mask=feat_mask,
            lens=lens,
            ref_f=ref_f,
            store_frame=store_frame,
            cancel=cancel,
        )

    return _build_span_motion(
        span, mapped, matrices, line_error_ft, lens=lens.lens if lens.k1 != 0.0 else None
    )


def _register_frame(
    score_img: np.ndarray,
    h_court_to_px_init: Matrix,
    *,
    search_radius: int,
    r_wide: int,
    r_narrow: int,
    flank: int,
    valid_mask: np.ndarray | None,
    lens: _Lens,
) -> tuple[Matrix, _LineStats]:
    """Registers a frame to the court lines: jointly, or by plain refinement if that fails."""
    joint = _register_to_court_lines(
        score_img,
        h_court_to_px_init,
        search_radius=search_radius,
        flank=flank,
        valid_mask=valid_mask,
        lens=lens,
    )
    if joint is not None and _lines_ok(joint.stats):
        return joint.h_court_to_px, joint.stats
    return _refine_to_lines(
        score_img,
        h_court_to_px_init,
        passes=(r_wide, r_narrow),
        flank=flank,
        valid_mask=valid_mask,
        lens=lens,
    )


def _anchor_to_court_lines(
    score_img: np.ndarray,
    h_court_to_px_init: Matrix,
    *,
    search_radius: int,
    flank: int,
    valid_mask: np.ndarray | None,
) -> tuple[Matrix, float, _Lens] | None:
    """Registers the reference frame from its clicked fit, estimating the lens on the way.

    Returns `(court -> undistorted px, median line error in feet, lens)`, or None when the
    registration does not verify (the clicked fit then stands, with no lens correction).
    """
    sh, sw = score_img.shape
    lens = _Lens.none(sw, sh)
    reg = _register_to_court_lines(
        score_img,
        h_court_to_px_init,
        search_radius=search_radius,
        flank=flank,
        valid_mask=valid_mask,
        lens=lens,
    )
    if reg is None or not _lines_ok(reg.stats):
        return None
    # Bent lines only partly fit a straight hypothesis until the lens is known, so alternate.
    for _ in range(2):
        estimate = _estimate_lens(reg, lens, score_img.shape)
        if estimate is None:
            break
        lens_k, h_k = estimate
        reg_k = _register_to_court_lines(
            score_img,
            h_k,
            search_radius=search_radius,
            flank=flank,
            valid_mask=valid_mask,
            lens=lens_k,
        )
        if reg_k is None or not _lines_ok(reg_k.stats):
            break
        lens, reg = lens_k, reg_k
    return reg.h_court_to_px, reg.stats.med_ft, lens


def _estimate_lens(
    reg: _Registration, lens: _Lens, shape: tuple[int, ...]
) -> tuple[_Lens, Matrix] | None:
    """The radial coefficient that best straightens a registration's line points.

    Searches `k1` coarse-to-fine, refitting the court homography to the points undistorted by
    each candidate and scoring the scale-corrected point-to-line residuals. Returns the lens and
    its `court -> undistorted px` fit, or None when the registration has too few points.
    """
    pts = reg.samples.pts
    if len(pts) < 24:
        return None
    frame_pts = lens.distort(pts)
    eqs = reg.samples.eqs
    h_p2c0 = _safe_inv(reg.h_court_to_px)
    if h_p2c0 is None:
        return None
    radius2 = lens.radius2(frame_pts)

    def cost(k1: float) -> tuple[float, Matrix]:
        lens_k = lens.with_k1(k1)
        undist = lens_k.undistort(frame_pts)
        h_p2c = _fit_lines_gn(
            h_p2c0, h_p2c0, undist, eqs, shape, outlier_px=None, iterations=8, regularise=False
        )
        l_img = (h_p2c.T @ eqs.T).T
        r = np.abs(np.sum(l_img[:, :2] * undist, axis=1) + l_img[:, 2]) / np.maximum(
            np.hypot(l_img[:, 0], l_img[:, 1]), 1e-12
        )
        r = r / (1.0 + 2.0 * k1 * radius2)  # back to frame pixels
        return float(np.mean(np.minimum(r, 3.0) ** 2)), h_p2c

    results = {k: cost(k) for k in np.round(np.arange(-0.05, 0.2501, 0.01), 4)}
    k_best = min(results, key=lambda k: results[k][0])
    for k in np.round(np.arange(k_best - 0.009, k_best + 0.0091, 0.001), 4):
        results[k] = cost(float(k))
    k_best = min(results, key=lambda k: results[k][0])
    h_c2p = _safe_inv(results[k_best][1])
    if h_c2p is None:
        return None
    return lens.with_k1(float(k_best)), _normalise_h(h_c2p)


def _fill_intermediate_frames(
    *,
    cap: cv2.VideoCapture,
    available_kfs: list[int],
    kf_c2p: dict[int, Matrix],
    sw: int,
    sh: int,
    r_wide: int,
    r_narrow: int,
    flank: int,
    feat_mask: np.ndarray | None,
    lens: _Lens,
    ref_f: int,
    store_frame: Callable[[int, Matrix, float], None],
    cancel: threading.Event | None = None,
) -> None:
    def register(score: np.ndarray, h_init: Matrix) -> tuple[Matrix, _LineStats]:
        return _register_frame(
            score,
            h_init,
            search_radius=r_wide,
            r_wide=r_wide,
            r_narrow=r_narrow,
            flank=flank,
            valid_mask=feat_mask,
            lens=lens,
        )

    cap.set(cv2.CAP_PROP_POS_FRAMES, available_kfs[0])
    cur_pos = available_kfs[0]

    for k_idx in range(len(available_kfs) - 1):
        _check_cancelled(cancel)
        k0 = available_kfs[k_idx]
        k1 = available_kfs[k_idx + 1]
        if k1 - k0 <= 1:
            continue
        m0 = k0 in kf_c2p
        m1 = k1 in kf_c2p

        if not m0 and not m1:
            # Both keyframes unmapped: skip intermediate frames quickly.
            continue

        # Advance video stream to k0 + 1 sequentially (or seek if we skipped a big gap).
        target_start = k0 + 1
        if target_start < cur_pos or target_start - cur_pos > 30:
            cap.set(cv2.CAP_PROP_POS_FRAMES, target_start)
            cur_pos = target_start
        while cur_pos < target_start:
            if not cap.grab():
                return
            cur_pos += 1

        if m0 and m1:
            h0 = _normalise_h(kf_c2p[k0])
            h1 = _normalise_h(kf_c2p[k1])
            steady = _max_corner_disp(h0, h1, sw, sh) < 1.0
            for f in range(k0 + 1, k1):
                ok, bgr = cap.read()
                cur_pos += 1
                if not ok or bgr is None:
                    return
                if f == ref_f:
                    continue
                alpha = (f - k0) / (k1 - k0)
                h_interp = (1.0 - alpha) * h0 + alpha * h1
                sc = _white_score(_resize_work(bgr, sw, sh))
                if steady:
                    # Fast path for a stationary camera: verify court lines first without full GN.
                    st0 = _evaluate_lines(
                        sc,
                        h_interp,
                        search_radius=r_narrow,
                        flank=flank,
                        valid_mask=feat_mask,
                        lens=lens,
                    )
                    if _lines_ok(st0) and st0.med_px < 1.0:
                        store_frame(f, h_interp, st0.med_ft)
                        continue
                h_ref, st = register(sc, h_interp)
                if _lines_ok(st):
                    store_frame(f, h_ref, st.med_ft)
        else:
            # Boundary interval (one mapped, one unmapped): decode the short slice (<= stride-1
            # frames) and walk from the mapped side to pinpoint the exact cut frame.
            slice_scores: list[tuple[int, np.ndarray]] = []
            for f in range(k0 + 1, k1):
                ok, bgr = cap.read()
                cur_pos += 1
                if not ok or bgr is None:
                    break
                slice_scores.append((f, _white_score(_resize_work(bgr, sw, sh))))

            ordered = slice_scores if m0 else list(reversed(slice_scores))
            h_cur = kf_c2p[k0] if m0 else kf_c2p[k1]
            for f, sc in ordered:
                h_ref, st = register(sc, h_cur)
                if not _lines_ok(st):
                    break
                h_cur = h_ref
                store_frame(f, h_ref, st.med_ft)


# --- Low-level vision helpers -------------------------------------------------------------


def _build_span_motion(
    span: CalibrationSpan,
    mapped: np.ndarray,
    matrices: np.ndarray,
    line_error_ft: np.ndarray,
    *,
    lens: Lens | None = None,
) -> SpanMotion:
    return SpanMotion(
        start_frame=span.start_frame,
        end_frame=span.end_frame,
        camera_view=span.camera_view,
        calibration_effective_from=span.calibration.effective_from_frame,
        calibration_reference_frame=span.calibration.reference_frame,
        mapped=mapped,
        matrices=matrices,
        line_error_ft=line_error_ft,
        lens=lens,
    )


def _resize_work(bgr: np.ndarray, sw: int, sh: int) -> np.ndarray:
    if bgr.shape[1] == sw and bgr.shape[0] == sh:
        return bgr
    return cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA)


def _white_score(bgr: np.ndarray) -> np.ndarray:
    """White-line contrast map: min(B, G, R) is high on white lines and low on colored courts."""
    m = cv2.min(cv2.min(bgr[:, :, 0], bgr[:, :, 1]), bgr[:, :, 2])
    return cv2.GaussianBlur(m, (3, 3), 0.7).astype(np.float32)


def _estimate_static_mask(grays: Sequence[np.ndarray]) -> np.ndarray | None:
    """Masks out static broadcast overlays (scorebug) when the camera moves across keyframes."""
    if len(grays) < 4:
        return None
    step = max(1, len(grays) // 12)
    probe = np.stack([g.astype(np.float32) for g in grays[::step]], axis=0)
    std_map = np.std(probe, axis=0)
    if float(np.median(std_map)) <= 3.0:
        return None
    static = (std_map < 1.5).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15))
    static = cv2.dilate(static, kernel)
    # Don't mask more than 40% of the frame (safety guard for mostly-static segments).
    if float(np.mean(static > 0)) > 0.40:
        return None
    return ((1 - static) * 255).astype(np.uint8)


def _match_features(
    feats_src: tuple[Any, np.ndarray | None],
    feats_dst: tuple[Any, np.ndarray | None],
    matcher: cv2.BFMatcher,
    sw: int,
    sh: int,
) -> tuple[Matrix | None, int, bool]:
    """Matches ORB features between two frames and estimates a homography with USAC_MAGSAC."""
    kp1, des1 = feats_src
    kp2, des2 = feats_dst
    if des1 is None or des2 is None or len(kp1) < 12 or len(kp2) < 12:
        return None, 0, False
    pairs = matcher.knnMatch(des1, des2, k=2)
    good = [
        m
        for pair in pairs
        if len(pair) == 2
        for m, n in (pair,)
        if m.distance < _LOWE_RATIO * n.distance
    ]
    if len(good) < 12:
        return None, 0, False
    src_pts = np.array([kp1[m.queryIdx].pt for m in good], dtype=np.float32).reshape(-1, 1, 2)
    dst_pts = np.array([kp2[m.trainIdx].pt for m in good], dtype=np.float32).reshape(-1, 1, 2)
    homography, mask = cv2.findHomography(src_pts, dst_pts, cv2.USAC_MAGSAC, _RANSAC_REPROJ_PX)
    if homography is None or mask is None:
        return None, 0, False
    inlier_mask = mask.ravel().astype(bool)
    inliers = int(np.count_nonzero(inlier_mask))
    if inliers < 4:
        return None, inliers, False
    inlier_pts = src_pts[inlier_mask, 0, :]
    span_x = float(inlier_pts[:, 0].max() - inlier_pts[:, 0].min())
    span_y = float(inlier_pts[:, 1].max() - inlier_pts[:, 1].min())
    spread_ok = span_x >= _MIN_RELOC_SPREAD_X * sw and span_y >= _MIN_RELOC_SPREAD_Y * sh
    return homography.astype(np.float64), inliers, spread_ok


def _is_sane_homography(homography: Matrix, sw: int, sh: int, *, strict_step: bool) -> bool:
    """Rejects singular, flipped, or wildly distorted image-to-image homographies."""
    if not np.all(np.isfinite(homography)):
        return False
    if np.linalg.cond(homography) > 1e8:
        return False
    h = _normalise_h(homography)
    corners = np.array(
        [[0.0, 0.0, 1.0], [sw, 0.0, 1.0], [sw, sh, 1.0], [0.0, sh, 1.0]], dtype=np.float64
    )
    warped = (h @ corners.T).T
    if np.any(warped[:, 2] <= 0.1):
        return False
    pts = warped[:, :2] / warped[:, 2:3]
    # Check convexity and consistent orientation (clockwise in image coordinates: cross > 0).
    edges = np.roll(pts, -1, axis=0) - pts
    next_edges = np.roll(edges, -1, axis=0)
    crosses = edges[:, 0] * next_edges[:, 1] - edges[:, 1] * next_edges[:, 0]
    if np.any(crosses <= 0):
        return False
    # Polygon area via shoelace formula.
    area = 0.5 * abs(
        float(np.sum(pts[:, 0] * np.roll(pts[:, 1], -1) - np.roll(pts[:, 0], -1) * pts[:, 1]))
    )
    ratio = area / max(1.0, float(sw * sh))
    low, high = (0.4, 2.5) if strict_step else (0.15, 6.0)
    return low <= ratio <= high


class _Lens(NamedTuple):
    """A `Lens` in work pixels: points are normalised by the frame size, bent, and scaled back.

    Broadcast lenses bow straight court lines near the frame edges (16-18 px across a 1080p
    Sideline View), further than any single homography can follow, so court lines are matched in
    the undistorted image.
    """

    lens: Lens
    sw: int
    sh: int

    @classmethod
    def none(cls, sw: int, sh: int) -> _Lens:
        return cls(Lens(0.0, sw / sh), sw, sh)

    @property
    def k1(self) -> float:
        return self.lens.k1

    def with_k1(self, k1: float) -> _Lens:
        return self._replace(lens=Lens(k1, self.lens.aspect))

    def _size(self) -> np.ndarray:
        return np.array([self.sw, self.sh], dtype=np.float64)

    def radius2(self, pts: np.ndarray) -> np.ndarray:
        return self.lens.radius2(pts / self._size())

    def undistort(self, pts: np.ndarray) -> np.ndarray:
        if self.k1 == 0.0 or len(pts) == 0:
            return pts
        return self.lens.undistort(pts / self._size()) * self._size()

    def distort(self, pts: np.ndarray) -> np.ndarray:
        if self.k1 == 0.0 or len(pts) == 0:
            return pts
        return self.lens.distort(pts / self._size()) * self._size()


class _RidgeProfiles(NamedTuple):
    """White-ridge response along the normal of each visible court-line sample.

    `(u, v)` are sample positions in the frame and `(nx, ny)` unit normals there; `ridge[i, j]`
    is the response at offset `j - radius` pixels from sample `i` along its normal. Points found
    on them are undistorted with `lens` before fitting.
    """

    u: np.ndarray
    v: np.ndarray
    nx: np.ndarray
    ny: np.ndarray
    lids: np.ndarray
    ridge: np.ndarray
    radius: int
    vis_per_line: np.ndarray
    lens: _Lens

    @property
    def n_vis(self) -> int:
        return int(self.vis_per_line.sum())

    def points(self, rows: np.ndarray, offsets: np.ndarray) -> np.ndarray:
        """Undistorted image points `offsets` pixels along the normals of samples `rows`."""
        pts = np.column_stack(
            [self.u[rows] + offsets * self.nx[rows], self.v[rows] + offsets * self.ny[rows]]
        ).astype(np.float64)
        return self.lens.undistort(pts)

    def undistorted_positions(self) -> np.ndarray:
        return self.lens.undistort(np.column_stack([self.u, self.v]).astype(np.float64))


class _LineSamples(NamedTuple):
    """The strongest ridge on each visible court-line sample: image point and its court line."""

    pts: np.ndarray
    eqs: np.ndarray
    lids: np.ndarray
    vis_per_line: np.ndarray

    @property
    def n_vis(self) -> int:
        return int(self.vis_per_line.sum())


def _no_samples(vis_per_line: np.ndarray | None = None) -> _LineSamples:
    vis = np.zeros(len(_COURT_LINES), dtype=np.int64) if vis_per_line is None else vis_per_line
    return _LineSamples(np.zeros((0, 2)), np.zeros((0, 3)), np.zeros((0,), dtype=np.int32), vis)


def _ridge_profiles(
    score_img: np.ndarray,
    h_court_to_px: Matrix,
    *,
    search_radius: int,
    flank: int,
    valid_mask: np.ndarray | None,
    lens: _Lens,
) -> _RidgeProfiles | None:
    """Samples the white-ridge response along normals to the projected court lines (vectorised).

    `h_court_to_px` maps the court into the undistorted image; `lens` bends it into the frame.
    Returns None when `h_court_to_px` is singular.
    """
    h_img, w_img = score_img.shape
    h_px_to_court = _safe_inv(h_court_to_px)
    if h_px_to_court is None:
        return None

    court_pts, lids_v = _visible_line_samples(
        h_court_to_px, w_img, h_img, edge=flank + 2, lens=lens
    )
    proj = (h_court_to_px @ court_pts.T).T
    p_u = proj[:, :2] / proj[:, 2:3]
    l_img = (h_px_to_court.T @ _LINE_EQS.T).T
    norms = np.maximum(np.hypot(l_img[:, 0], l_img[:, 1]), 1e-12)
    n_u = (l_img[:, :2] / norms[:, None])[lids_v]
    if lens.k1 == 0.0 or len(p_u) == 0:
        p_d, n_d = p_u, n_u
    else:
        # The lens bends the line: take its normal from the distorted tangent.
        t_u = np.column_stack([-n_u[:, 1], n_u[:, 0]])
        t_d = lens.distort(p_u + t_u) - lens.distort(p_u - t_u)
        t_d /= np.maximum(np.hypot(t_d[:, 0], t_d[:, 1]), 1e-12)[:, None]
        n_d = np.column_stack([t_d[:, 1], -t_d[:, 0]])
        p_d = lens.distort(p_u)
    u0, v0, nx, ny = p_d[:, 0], p_d[:, 1], n_d[:, 0], n_d[:, 1]
    if valid_mask is not None and len(u0):
        ix = np.clip(np.rint(u0).astype(np.int32), 0, w_img - 1)
        iy = np.clip(np.rint(v0).astype(np.int32), 0, h_img - 1)
        keep = valid_mask[iy, ix] > 0
        u0, v0, nx, ny, lids_v = u0[keep], v0[keep], nx[keep], ny[keep], lids_v[keep]

    vis_per_line = np.bincount(lids_v, minlength=len(_COURT_LINES))

    s_vals = np.arange(-search_radius - flank, search_radius + flank + 1, dtype=np.float32)
    if len(u0) == 0:
        ridge = np.zeros((0, 2 * search_radius + 1), dtype=np.float32)
    else:
        su = (u0[:, None] + nx[:, None] * s_vals[None, :]).astype(np.float32)
        sv = (v0[:, None] + ny[:, None] * s_vals[None, :]).astype(np.float32)
        profs = cv2.remap(score_img, su, sv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        center = profs[:, flank:-flank]
        ridge = np.minimum(center - profs[:, : -2 * flank], center - profs[:, 2 * flank :])
        # Offsets whose ridge test reaches off the frame carry no evidence.
        inside = (su >= 0) & (su <= w_img - 1) & (sv >= 0) & (sv <= h_img - 1)
        usable = inside[:, flank:-flank] & inside[:, : -2 * flank] & inside[:, 2 * flank :]
        ridge = np.where(usable, ridge, np.float32(-1e3))
    return _RidgeProfiles(u0, v0, nx, ny, lids_v, ridge, search_radius, vis_per_line, lens)


def _visible_line_samples(
    h_court_to_px: Matrix, w_img: int, h_img: int, *, edge: float, lens: _Lens
) -> tuple[np.ndarray, np.ndarray]:
    """Court points spread over each line's in-frame stretch, and the line each belongs to."""
    proj = np.einsum("ij,lnj->lni", h_court_to_px, _PROBE_COURT_PTS)
    w = proj[:, :, 2]
    in_front = w > 1e-6
    safe_w = np.where(in_front, w, 1.0)
    frame = lens.distort(
        np.column_stack([(proj[:, :, 0] / safe_w).ravel(), (proj[:, :, 1] / safe_w).ravel()])
    )
    us = frame[:, 0].reshape(w.shape)
    vs = frame[:, 1].reshape(w.shape)
    inside = in_front & (us > edge) & (us < w_img - edge) & (vs > edge) & (vs < h_img - edge)
    pts: list[np.ndarray] = []
    lids: list[np.ndarray] = []
    for lid in range(len(_COURT_LINES)):
        idx = np.flatnonzero(inside[lid])
        if len(idx) < 2:
            continue
        lo, hi = idx[0], idx[-1]
        length_px = math.hypot(us[lid, hi] - us[lid, lo], vs[lid, hi] - vs[lid, lo])
        n = min(_SAMPLES_PER_LINE, int(length_px / _MIN_SAMPLE_SPACING_PX))
        if n < 2:
            continue
        ts = np.linspace(_PROBE_TS[lo], _PROBE_TS[hi], n)
        start, end = _LINE_STARTS[lid], _LINE_ENDS[lid]
        xy = start[None, :] + (end - start)[None, :] * ts[:, None]
        pts.append(np.column_stack([xy, np.ones(n)]))
        lids.append(np.full(n, lid, dtype=np.int32))
    if not pts:
        return np.zeros((0, 3)), np.zeros((0,), dtype=np.int32)
    return np.vstack(pts), np.concatenate(lids)


def _subpixel_offsets(ridge: np.ndarray, rows: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """Parabolic sub-pixel peak offsets (in samples, within +-0.5) at `ridge[rows, idx]`."""
    ym = ridge[rows, idx - 1]
    y0 = ridge[rows, idx]
    yp = ridge[rows, idx + 1]
    d2 = ym - 2.0 * y0 + yp
    # Skip peaks beside an off-frame offset (masked to a large negative response).
    safe = (np.abs(d2) > 1e-6) & (ym > -100.0) & (yp > -100.0)
    sub = np.where(safe, 0.5 * (ym - yp) / np.where(safe, d2, 1.0), 0.0)
    return np.clip(sub, -0.5, 0.5)


def _sample_lines(
    score_img: np.ndarray,
    h_court_to_px: Matrix,
    *,
    search_radius: int,
    flank: int,
    valid_mask: np.ndarray | None,
    lens: _Lens,
) -> _LineSamples:
    """Detects the strongest white court-line ridge along each projected court line's normal.

    Points are returned undistorted (see `_Lens`).
    """
    prof = _ridge_profiles(
        score_img,
        h_court_to_px,
        search_radius=search_radius,
        flank=flank,
        valid_mask=valid_mask,
        lens=lens,
    )
    if prof is None:
        return _no_samples()
    if prof.n_vis < 8:
        return _no_samples(prof.vis_per_line)

    ridge = prof.ridge
    best_idx = np.argmax(ridge, axis=1)
    rows = np.arange(prof.n_vis)
    peaks = ridge[rows, best_idx]
    ok = (peaks >= _RIDGE_THRESHOLD) & (best_idx > 0) & (best_idx < ridge.shape[1] - 1)
    if not np.any(ok):
        return _no_samples(prof.vis_per_line)

    ok_rows = rows[ok]
    bi = best_idx[ok]
    s_peak = (bi - search_radius) + _subpixel_offsets(ridge, ok_rows, bi)
    pts = prof.points(ok_rows, s_peak)
    lids = prof.lids[ok]
    return _LineSamples(pts, _LINE_EQS[lids], lids, prof.vis_per_line)


def _evaluate_lines(
    score_img: np.ndarray,
    h_court_to_px: Matrix,
    *,
    search_radius: int,
    flank: int,
    valid_mask: np.ndarray | None,
    lens: _Lens,
) -> _LineStats:
    """Measures court-line agreement of `h_court_to_px` without modifying it."""
    h_p2c = _safe_inv(h_court_to_px)
    if h_p2c is None:
        return _EMPTY_LINE_STATS
    samples = _sample_lines(
        score_img,
        h_court_to_px,
        search_radius=search_radius,
        flank=flank,
        valid_mask=valid_mask,
        lens=lens,
    )
    if len(samples.pts) == 0:
        return _LineStats(samples.n_vis, 0, 0, 0, math.inf, math.inf, math.inf)
    return _compute_line_stats(h_p2c, samples)


def _refine_to_lines(
    score_img: np.ndarray,
    h_court_to_px_init: Matrix,
    *,
    passes: tuple[int, ...],
    flank: int,
    valid_mask: np.ndarray | None,
    lens: _Lens,
) -> tuple[Matrix, _LineStats]:
    """Refines `h_court_to_px_init` via Huber-IRLS Gauss-Newton onto detected white court lines.

    Residuals are weighted by how many feet on the court each pixel spans, so the fit minimises
    court error rather than pixel error: the foreshortened far side, where one pixel is many
    inches, is not traded away for sub-pixel agreement on the near side.
    """
    shape = score_img.shape
    h_c2p_init = _normalise_h(h_court_to_px_init)
    h_p2c_init = _safe_inv(h_c2p_init)
    if h_p2c_init is None:
        return h_court_to_px_init, _EMPTY_LINE_STATS
    h_p2c = h_p2c_init.copy()

    stats = _EMPTY_LINE_STATS
    for radius in passes:
        h_cur_c2p = _safe_inv(h_p2c)
        if h_cur_c2p is None:
            return h_court_to_px_init, _EMPTY_LINE_STATS
        samples = _sample_lines(
            score_img,
            h_cur_c2p,
            search_radius=radius,
            flank=flank,
            valid_mask=valid_mask,
            lens=lens,
        )
        if len(samples.pts) < 12 or len(set(samples.lids.tolist())) < 2:
            stats = _LineStats(samples.n_vis, len(samples.pts), 0, 0, math.inf, math.inf, math.inf)
            break
        h_p2c = _fit_lines_gn(
            h_p2c_init,
            h_p2c,
            samples.pts,
            samples.eqs,
            shape,
            outlier_px=5.0 if radius <= 8 else None,
        )
        stats = _compute_line_stats(h_p2c, samples)

    h_final = _safe_inv(h_p2c)
    if h_final is None:
        return h_court_to_px_init, _EMPTY_LINE_STATS
    return h_final, stats


def _fit_lines_gn(
    h_p2c_ref: Matrix,
    h_p2c_start: Matrix,
    pts: np.ndarray,
    eqs: np.ndarray,
    shape: tuple[int, ...],
    *,
    outlier_px: float | None,
    iterations: int = 6,
    regularise: bool = True,
) -> Matrix:
    """Huber-IRLS Gauss-Newton fit of `px -> court` so `pts` lie on their court lines `eqs`.

    Parameterised as a perturbation of `h_p2c_ref` (and, with `regularise`, pulled towards it),
    starting from `h_p2c_start`. Residuals are point-to-line distances in pixels, weighted by
    feet per pixel (`_feet_per_pixel_weights`) and by how much of each line was seen
    (`_coverage_weights`); with `outlier_px`, points further off than that are ignored. Returns
    `h_p2c_start` if the fit degenerates.
    """
    h_img, w_img = shape[:2]
    n_p = np.array([[2.0 / w_img, 0.0, -1.0], [0.0, 2.0 / h_img, -1.0], [0.0, 0.0, 1.0]])
    n_p_inv = np.linalg.inv(n_p)
    reg = np.diag([2.0, 2.0, 1.0, 2.0, 2.0, 1.0, 5.0, 5.0]) * (1.0 if regularise else 1e-6)
    h_c2p_ref = _safe_inv(h_p2c_ref)
    if h_c2p_ref is None:
        return h_p2c_start
    w_ft = _feet_per_pixel_weights(h_p2c_start, pts, eqs) * _coverage_weights(h_p2c_start, pts, eqs)

    m_cur = _normalise_h(n_p @ h_c2p_ref @ h_p2c_start @ n_p_inv)
    p = np.array(
        [
            m_cur[0, 0] - 1.0,
            m_cur[0, 1],
            m_cur[0, 2],
            m_cur[1, 0],
            m_cur[1, 1] - 1.0,
            m_cur[1, 2],
            m_cur[2, 0],
            m_cur[2, 1],
        ],
        dtype=np.float64,
    )
    pts_h = np.hstack([pts, np.ones((len(pts), 1))])
    l0 = (n_p_inv.T @ h_p2c_ref.T @ eqs.T).T

    huber_delta = _GN_HUBER_PX
    for _ in range(iterations):
        m_mat = _param_matrix(p)
        l_img = (n_p.T @ m_mat.T @ l0.T).T
        r = np.sum(l_img * pts_h, axis=1) / np.maximum(np.hypot(l_img[:, 0], l_img[:, 1]), 1e-12)
        abs_r = np.abs(r)
        w_irls = np.where(abs_r <= huber_delta, 1.0, huber_delta / np.maximum(abs_r, 1e-12))
        if outlier_px is not None:
            w_irls = np.where(abs_r > outlier_px, 0.0, w_irls)

        jac = np.empty((len(pts), 8), dtype=np.float64)
        eps = 1e-6
        for k in range(8):
            p2 = p.copy()
            p2[k] += eps
            l2 = (n_p.T @ _param_matrix(p2).T @ l0.T).T
            r2 = np.sum(l2 * pts_h, axis=1) / np.maximum(np.hypot(l2[:, 0], l2[:, 1]), 1e-12)
            jac[:, k] = (r2 - r) / eps

        jw = jac * (w_irls * w_ft)[:, None]
        try:
            dp = np.linalg.solve(jw.T @ jac + reg, -(jw.T @ r + reg @ p))
        except np.linalg.LinAlgError:
            break
        p += dp
        if float(np.linalg.norm(dp)) < 1e-5:
            break

    candidate = h_p2c_ref @ n_p_inv @ _param_matrix(p) @ n_p
    if np.all(np.isfinite(candidate)) and np.linalg.cond(candidate) < _MAX_HOMOGRAPHY_COND:
        return candidate
    return h_p2c_start


def _register_to_court_lines(
    score_img: np.ndarray,
    h_court_to_px_init: Matrix,
    *,
    search_radius: int,
    flank: int,
    valid_mask: np.ndarray | None,
    lens: _Lens,
    rounds: int = 3,
) -> _Registration | None:
    """Registers the court to its painted lines from a rough `court -> px` estimate.

    `_refine_to_lines` snaps every sample to its strongest nearby ridge, so a rough estimate lets
    each line lock onto whatever bright edge is closest (a logo, lettering, the back wall). This
    searches jointly instead: it keeps several ridge candidates per sample, finds straight-line
    hypotheses for each court line, and scores every homography built from two lines across the
    court and two along it by how many samples on all eight lines it explains. A logo edge can
    pass for one line but not consistently with the court's geometry, so it cannot win.

    The winner is then fitted (in feet, `_fit_lines_gn`) to the points of every line hypothesis it
    agrees with, including lines the lens bends a few pixels off any single homography (the
    baselines at the frame edges). Those stay in the fit however far the compromise leaves them,
    rather than dropping out of a narrow search window and letting the fit slide off them. The
    search repeats around the result for up to `rounds` rounds, so lines that started outside the
    search band are found once the rest of the court is in place. The stats describe the fitted
    hypothesis points. Everything happens in the image undistorted by `lens`.

    Returns None when no hypothesis can be formed or too few lines of a family associate.
    """
    h_cur = _normalise_h(h_court_to_px_init)
    result: _Registration | None = None
    for _ in range(rounds):
        h_p2c_cur = _safe_inv(h_cur)
        if h_p2c_cur is None:
            break
        prof = _ridge_profiles(
            score_img,
            h_cur,
            search_radius=search_radius,
            flank=flank,
            valid_mask=valid_mask,
            lens=lens,
        )
        if prof is None or prof.n_vis < _MIN_VISIBLE_LINE_SAMPLES:
            break
        cands = _ridge_candidates(prof, _neighbour_limits(prof, h_p2c_cur))
        if cands is None:
            break
        rows, pts = cands
        hyps = _line_hypotheses(prof, rows, pts, h_p2c_cur)
        best = _best_court_hypothesis(hyps, prof, rows, pts, h_cur, h_p2c_cur)
        if best is None:
            break
        samples = _associate_hypotheses(
            best, hyps, prof.vis_per_line, tolerance=0.75 * search_radius
        )
        h_p2c_best = _safe_inv(best)
        if samples is None or h_p2c_best is None:
            break
        h_p2c_fit = _fit_lines_gn(
            h_p2c_best,
            h_p2c_best,
            samples.pts,
            samples.eqs,
            score_img.shape,
            outlier_px=None,
            iterations=10,
        )
        h_fit = _safe_inv(h_p2c_fit)
        if h_fit is None:
            break
        h_fit = _normalise_h(h_fit)
        result = _Registration(h_fit, _compute_line_stats(h_p2c_fit, samples), samples)
        moved = _max_corner_disp(h_cur, h_fit, score_img.shape[1], score_img.shape[0])
        h_cur = h_fit
        if moved < 0.5:
            break
    return result


class _Registration(NamedTuple):
    """A frame registered to the court lines: `court -> undistorted px`, its stats and points."""

    h_court_to_px: Matrix
    stats: _LineStats
    samples: _LineSamples


def _associate_hypotheses(
    h_c2p: Matrix,
    hyps: list[list[tuple[np.ndarray, np.ndarray]]],
    vis_per_line: np.ndarray,
    *,
    tolerance: float,
) -> _LineSamples | None:
    """The points of each court line's best-supported hypothesis within `tolerance` pixels.

    A hypothesis is within tolerance when the median distance of its points to where `h_c2p`
    projects that court line is. The lens bends lines near the frame edges a few pixels off any
    single homography, so the nearest hypothesis there can be sponsor lettering painted beside the
    line; a painted line is one long unbroken ridge, lettering a broken one, so the hypothesis
    with most points wins and distance only breaks ties. Returns None when fewer than
    `_MIN_LINES_PER_FAMILY` lines of either family associate.
    """
    h_p2c = _safe_inv(h_c2p)
    if h_p2c is None:
        return None
    l_proj = (h_p2c.T @ _KEY_EQS.T).T
    l_proj = l_proj / np.maximum(np.hypot(l_proj[:, 0], l_proj[:, 1]), 1e-12)[:, None]
    pts_all: list[np.ndarray] = []
    lids_all: list[np.ndarray] = []
    families = [0, 0]
    for key in range(_N_LINE_KEYS):
        best: tuple[int, float, np.ndarray] | None = None
        for _line, line_pts in hyps[key]:
            d = float(np.median(np.abs(line_pts @ l_proj[key, :2] + l_proj[key, 2])))
            if d > tolerance:
                continue
            if best is None or (len(line_pts), -d) > (best[0], -best[1]):
                best = (len(line_pts), d, line_pts)
        if best is None:
            continue
        pts_all.append(best[2])
        lids_all.append(np.full(len(best[2]), key))  # line `key` carries key `key`
        families[int(_KEY_FAMILY[key])] += 1
    if min(families) < _MIN_LINES_PER_FAMILY:
        return None
    lids = np.concatenate(lids_all).astype(np.int32)
    return _LineSamples(np.vstack(pts_all), _LINE_EQS[lids], lids, vis_per_line)


def _neighbour_limits(prof: _RidgeProfiles, h_p2c: Matrix) -> np.ndarray:
    """Per-sample search limit: a fraction of the distance to the nearest other line of its family.

    Keeps a wide search from reaching the neighbouring parallel line (the far baseline from the far
    kitchen line on a high Main View, say), which would make a shifted assignment look consistent.
    """
    l_img = (h_p2c.T @ _KEY_EQS.T).T
    p = np.column_stack([prof.undistorted_positions(), np.ones(len(prof.u))])
    num = p @ l_img.T
    den = prof.nx[:, None] * l_img[None, :, 0] + prof.ny[:, None] * l_img[None, :, 1]
    with np.errstate(divide="ignore", invalid="ignore"):
        dist = np.abs(num / den)
    own = _LINE_KEY[prof.lids]
    other_same_family = (_KEY_FAMILY[None, :] == _LINE_FAMILY[prof.lids][:, None]) & (
        np.arange(_N_LINE_KEYS)[None, :] != own[:, None]
    )
    dist = np.where(other_same_family & np.isfinite(dist), dist, np.inf)
    nearest = dist.min(axis=1) if dist.shape[1] else np.full(len(prof.u), np.inf)
    return np.clip(_NEIGHBOUR_SEARCH_FRACTION * nearest, 2.0, float(prof.radius))


def _ridge_candidates(
    prof: _RidgeProfiles, limits: np.ndarray
) -> tuple[np.ndarray, np.ndarray] | None:
    """Up to `_MAX_PEAKS_PER_SAMPLE` ridge peaks per sample within its limit, sorted by sample.

    Returns `(rows, pts)`: the sample index of each candidate and its sub-pixel image point.
    """
    ridge = prof.ridge
    n, m = ridge.shape
    if n == 0 or m < 3:
        return None
    offsets = np.abs(np.arange(1, m - 1) - prof.radius)
    inner = ridge[:, 1:-1]
    peak = (
        (inner >= ridge[:, :-2])
        & (inner > ridge[:, 2:])
        & (inner >= _RIDGE_THRESHOLD)
        & (offsets[None, :] <= limits[:, None])
    )
    vals = np.where(peak, inner, -np.inf)
    k = min(_MAX_PEAKS_PER_SAMPLE, vals.shape[1])
    top = np.argpartition(-vals, k - 1, axis=1)[:, :k]
    ok = np.isfinite(np.take_along_axis(vals, top, axis=1))
    if not np.any(ok):
        return None
    rows = np.broadcast_to(np.arange(n)[:, None], top.shape)[ok]
    idx = top[ok] + 1
    s = (idx - prof.radius) + _subpixel_offsets(ridge, rows, idx)
    pts = prof.points(rows, s)
    order = np.argsort(rows, kind="stable")
    return rows[order], pts[order]


def _line_hypotheses(
    prof: _RidgeProfiles, rows: np.ndarray, pts: np.ndarray, h_p2c: Matrix
) -> list[list[tuple[np.ndarray, np.ndarray]]]:
    """Up to `_HYPOTHESES_PER_LINE` straight image lines per court line (`_LINE_KEY`).

    Each is the best-supported straight line through that court line's ridge candidates (at most
    one candidate per sample counts), roughly parallel to its predicted image, after removing the
    candidates of the hypotheses already found. Returned as `(line, inlier_points)` pairs.
    """
    l_pred = (h_p2c.T @ _KEY_EQS.T).T
    keys = _LINE_KEY[prof.lids[rows]]
    visible = np.bincount(_LINE_KEY, weights=prof.vis_per_line, minlength=_N_LINE_KEYS)
    cos_max = math.cos(math.radians(_HYPOTHESIS_MAX_ANGLE_DEG))
    hyps: list[list[tuple[np.ndarray, np.ndarray]]] = [[] for _ in range(_N_LINE_KEYS)]
    for key in range(_N_LINE_KEYS):
        needed = max(_MIN_LINE_SUPPORT, math.ceil(_MIN_LINE_SUPPORT_RATIO * visible[key]))
        remaining = np.flatnonzero(keys == key)
        d_pred = np.array([-l_pred[key, 1], l_pred[key, 0]])
        d_norm = float(np.hypot(*d_pred))
        if d_norm < 1e-12:
            continue
        d_pred /= d_norm
        for _ in range(_HYPOTHESES_PER_LINE):
            if len(np.unique(rows[remaining])) < needed:
                break
            fit = _fit_straight_line(pts[remaining], rows[remaining], d_pred, cos_max)
            if fit is None:
                break
            line, inl = fit
            if len(np.unique(rows[remaining][inl])) < needed:
                break
            hyps[key].append((line, pts[remaining][inl]))
            remaining = remaining[~inl]
    return hyps


def _fit_straight_line(
    pts: np.ndarray, rows: np.ndarray, d_pred: np.ndarray, cos_max: float
) -> tuple[np.ndarray, np.ndarray] | None:
    """Exhaustive two-point RANSAC for the straight line through most of `pts`.

    Only lines within `_HYPOTHESIS_MAX_ANGLE_DEG` of `d_pred` are considered. Returns the
    least-squares line `(a, b, c)` (unit normal) through the inliers and the inlier mask.
    """
    n = len(pts)
    pool = (
        np.arange(n)
        if n <= _HYPOTHESIS_MAX_POINTS
        else np.linspace(0, n - 1, _HYPOTHESIS_MAX_POINTS).astype(np.intp)
    )
    i, j = np.triu_indices(len(pool), 1)
    i, j = pool[i], pool[j]
    d = pts[j] - pts[i]
    length = np.hypot(d[:, 0], d[:, 1])
    valid = (rows[i] != rows[j]) & (length > 1e-6)
    dirs = d / np.maximum(length, 1e-12)[:, None]
    valid &= np.abs(dirs @ d_pred) >= cos_max
    if not np.any(valid):
        return None
    anchor = pts[i[valid]]
    normal = np.column_stack([-dirs[valid, 1], dirs[valid, 0]])
    dist = np.abs(
        (pts[None, :, 0] - anchor[:, 0:1]) * normal[:, 0:1]
        + (pts[None, :, 1] - anchor[:, 1:2]) * normal[:, 1:2]
    )
    inl = dist[int(np.argmax(np.count_nonzero(dist < _HYPOTHESIS_INLIER_PX, axis=1)))]
    inl = inl < _HYPOTHESIS_INLIER_PX
    for _ in range(2):  # least-squares refit, then re-select inliers against it
        if np.count_nonzero(inl) < 2:
            return None
        q = pts[inl]
        centre = q.mean(axis=0)
        _, _, vt = np.linalg.svd(q - centre)
        nrm = vt[1]
        line = np.array([nrm[0], nrm[1], -float(nrm @ centre)])
        inl = np.abs(pts @ line[:2] + line[2]) < _HYPOTHESIS_INLIER_PX
    return line, inl


def _best_court_hypothesis(
    hyps: list[list[tuple[np.ndarray, np.ndarray]]],
    prof: _RidgeProfiles,
    rows: np.ndarray,
    pts: np.ndarray,
    h_init: Matrix,
    h_p2c_init: Matrix,
) -> Matrix | None:
    """The `court -> px` homography, from two lines across and two along, that explains most.

    Every candidate homography is scored by how many samples, on every court line, have a ridge
    candidate within `_SUPPORT_PX` of where it projects that line; ties go to the one closest to
    `h_init`. `h_init` itself competes too, so a frame with too few hypotheses keeps it.
    """
    lines = [(k, line) for k in range(_N_LINE_KEYS) for line, _pts in hyps[k]]
    across = [(k, line) for k, line in lines if _KEY_FAMILY[k] == _ACROSS]
    along = [(k, line) for k, line in lines if _KEY_FAMILY[k] == _ALONG]
    homographies = [h_init]
    for (k1, l1), (k2, l2) in itertools.combinations(across, 2):
        if k1 == k2:
            continue
        for (k3, l3), (k4, l4) in itertools.combinations(along, 2):
            if k3 == k4:
                continue
            h = _homography_from_lines((k1, l1), (k2, l2), (k3, l3), (k4, l4))
            if h is not None:
                homographies.append(h)
    hs = np.stack(homographies)
    dets = np.linalg.det(hs)
    hs = hs[np.isfinite(dets) & (np.abs(dets) > 1e-12)]
    if len(hs) == 0:
        return None
    hinv = np.linalg.inv(hs)

    # Probe points: the visible samples' court positions under `h_init`.
    probe_px = np.column_stack([prof.undistorted_positions(), np.ones(len(prof.u))])[
        :: max(1, prof.n_vis // 48)
    ]
    probe_court = (h_p2c_init @ probe_px.T).T
    probe_ok = np.abs(probe_court[:, 2]) > 1e-12
    probe_px, probe_court = probe_px[probe_ok], probe_court[probe_ok]
    probe_court = probe_court / probe_court[:, 2:3]
    projected = np.einsum("kij,nj->kni", hs, probe_court)
    w = projected[:, :, 2]
    in_front = np.all(w > 1e-9, axis=1)
    disp = np.median(
        np.hypot(
            projected[:, :, 0] / np.where(w > 1e-9, w, 1.0) - probe_px[None, :, 0],
            projected[:, :, 1] / np.where(w > 1e-9, w, 1.0) - probe_px[None, :, 1],
        ),
        axis=1,
    )

    # Support: samples with a candidate within `_SUPPORT_PX` of their projected court line.
    eqs = _LINE_EQS[prof.lids[rows]]
    l_img = np.einsum("kji,nj->kni", hinv, eqs)
    pts_h = np.column_stack([pts, np.ones(len(pts))])
    dist = np.abs(np.sum(l_img * pts_h[None], axis=2)) / np.maximum(
        np.hypot(l_img[:, :, 0], l_img[:, :, 1]), 1e-12
    )
    starts = np.concatenate([[0], np.flatnonzero(np.diff(rows)) + 1])
    support = np.count_nonzero(np.minimum.reduceat(dist, starts, axis=1) < _SUPPORT_PX, axis=1)
    score = np.where(in_front, support - disp / (4.0 * prof.radius), -np.inf)
    best = int(np.argmax(score))
    return hs[best] if np.isfinite(score[best]) else None


def _homography_from_lines(
    across_a: tuple[int, np.ndarray],
    across_b: tuple[int, np.ndarray],
    along_a: tuple[int, np.ndarray],
    along_b: tuple[int, np.ndarray],
) -> Matrix | None:
    """The `court -> px` homography taking two court lines of each family to these image lines."""
    img: list[np.ndarray] = []
    court: list[tuple[float, float]] = []
    for k_across, l_across in (across_a, across_b):
        for k_along, l_along in (along_a, along_b):
            x = np.cross(l_across, l_along)
            if abs(float(x[2])) < 1e-9:
                return None
            img.append(x[:2] / x[2])
            court.append((float(_KEY_COORD[k_along]), float(_KEY_COORD[k_across])))
    try:
        h = cv2.getPerspectiveTransform(
            np.array(court, dtype=np.float32), np.array(img, dtype=np.float32)
        )
    except cv2.error:
        return None
    h = np.asarray(h, dtype=np.float64)
    return _normalise_h(h) if np.all(np.isfinite(h)) else None


def _coverage_weights(h_p2c: Matrix, pts: np.ndarray, eqs: np.ndarray) -> np.ndarray:
    """Per-point weights so each court line counts by how many feet of it were seen.

    Samples are spread over each line's visible stretch, so a line barely in shot gets as many as
    a line seen end to end; without this it would dominate the fit.
    """
    pts_h = np.hstack([pts, np.ones((len(pts), 1))])
    court = (h_p2c @ pts_h.T).T
    ok = np.abs(court[:, 2]) > 1e-12
    xy = np.where(ok[:, None], court[:, :2] / np.where(ok, court[:, 2], 1.0)[:, None], 0.0)
    along = xy[:, 0] * eqs[:, 1] - xy[:, 1] * eqs[:, 0]  # position along each point's line
    _, group = np.unique(np.round(eqs, 9), axis=0, return_inverse=True)
    group = group.ravel()
    weights = np.ones(len(pts))
    for g in np.unique(group):
        members = group == g
        extent = float(np.ptp(along[members & ok])) if np.any(members & ok) else 0.0
        weights[members] = max(extent, 1.0) / np.count_nonzero(members)
    return weights / float(np.median(weights))


def _feet_per_pixel_weights(h_p2c: Matrix, pts: np.ndarray, eqs: np.ndarray) -> np.ndarray:
    """Per-point weights proportional to (feet per pixel across its line)^2, median-normalised.

    A point's residual in pixels times its feet-per-pixel is its residual in court feet, so
    weighting squared pixel residuals by this makes Gauss-Newton minimise squared feet.
    """
    pts_h = np.hstack([pts, np.ones((len(pts), 1))])
    l_img = (h_p2c.T @ eqs.T).T
    l_norm = np.maximum(np.hypot(l_img[:, 0], l_img[:, 1]), 1e-12)
    # Court-line value (feet) changes by |grad| per pixel moved along the image normal.
    court_h = (h_p2c @ pts_h.T).T
    w = court_h[:, 2]
    safe = np.abs(w) > 1e-12
    # d/dp of (eq . H p) / (h3 . p): the gradient's norm along the image line normal.
    num = np.sum(eqs * court_h, axis=1)
    grad = (eqs @ h_p2c)[:, :2] * w[:, None] - num[:, None] * h_p2c[2, :2][None, :]
    grad = grad / np.where(safe, w * w, 1.0)[:, None]
    nrm = l_img[:, :2] / l_norm[:, None]
    ft_per_px = np.abs(np.sum(grad * nrm, axis=1))
    ft_per_px = np.where(safe & np.isfinite(ft_per_px), ft_per_px, 0.0)
    med = float(np.median(ft_per_px[ft_per_px > 0])) if np.any(ft_per_px > 0) else 1.0
    return np.clip((ft_per_px / med) ** _FT_WEIGHT_POWER, 0.05, 25.0)


def _compute_line_stats(h_p2c: Matrix, samples: _LineSamples) -> _LineStats:
    pts, eqs, lids = samples.pts, samples.eqs, samples.lids
    n_vis = samples.n_vis
    pts_h = np.hstack([pts, np.ones((len(pts), 1))])
    l_img = (h_p2c.T @ eqs.T).T
    err_px = np.abs(
        np.sum(l_img * pts_h, axis=1) / np.maximum(np.hypot(l_img[:, 0], l_img[:, 1]), 1e-12)
    )
    court_pts = (h_p2c @ pts_h.T).T
    valid_w = np.abs(court_pts[:, 2]) > 1e-9
    court_xy = np.zeros((len(pts), 2), dtype=np.float64)
    court_xy[valid_w] = court_pts[valid_w, :2] / court_pts[valid_w, 2:3]
    err_ft = np.where(
        valid_w,
        np.abs(eqs[:, 0] * court_xy[:, 0] + eqs[:, 1] * court_xy[:, 1] + eqs[:, 2]),
        math.inf,
    )
    inliers = valid_w & (err_px < _LINE_INLIER_PX)
    if not np.any(inliers):
        return _LineStats(n_vis, len(pts), 0, 0, math.inf, math.inf, math.inf)
    matched = _matched_line_keys(lids[inliers], samples.vis_per_line)
    return _LineStats(
        n_vis=n_vis,
        n_obs=len(pts),
        n_inliers=int(np.count_nonzero(inliers)),
        n_lines=int(np.count_nonzero(matched)),
        med_px=float(np.median(err_px[inliers])),
        med_ft=float(np.median(err_ft[inliers])),
        p90_ft=float(np.percentile(err_ft[inliers], 90)),
        n_across=int(np.count_nonzero(matched & (_KEY_FAMILY == _ACROSS))),
        n_along=int(np.count_nonzero(matched & (_KEY_FAMILY == _ALONG))),
    )


def _matched_line_keys(inlier_lids: np.ndarray, vis_per_line: np.ndarray) -> np.ndarray:
    """Which distinct court lines (`_LINE_KEY`) have enough of their visible samples on a ridge."""
    support = np.bincount(_LINE_KEY[inlier_lids], minlength=_N_LINE_KEYS)
    visible = np.bincount(_LINE_KEY, weights=vis_per_line, minlength=_N_LINE_KEYS)
    needed = np.maximum(_MIN_LINE_SUPPORT, np.ceil(_MIN_LINE_SUPPORT_RATIO * visible))
    return (visible > 0) & (support >= needed)


def _lines_ok(stats: _LineStats) -> bool:
    if stats.n_vis < _MIN_VISIBLE_LINE_SAMPLES:
        return False
    min_req = max(_MIN_LINE_INLIERS, int(_MIN_LINE_INLIER_RATIO * stats.n_vis))
    return (
        stats.n_inliers >= min_req
        and stats.n_across >= _MIN_LINES_PER_FAMILY
        and stats.n_along >= _MIN_LINES_PER_FAMILY
        and stats.med_ft <= _MAX_MEDIAN_LINE_ERROR_FT
        and stats.p90_ft <= _MAX_P90_LINE_ERROR_FT
    )


def _frame_accepted(stats: _LineStats, *, feature_inliers: int) -> bool:
    if stats.n_vis >= _MIN_VISIBLE_LINE_SAMPLES:
        return _lines_ok(stats)
    # Almost no court lines expected in view: fall back to strong feature agreement.
    return feature_inliers >= _MIN_FALLBACK_INLIERS


def _court_to_frame_as_frame_to_ref(
    h_court_to_f_w: Matrix,
    base_court_to_image: Matrix,
    s_w_to_norm: Matrix,
) -> Matrix | None:
    """Converts a work-pixel `court -> frame` matrix into a normalised `frame -> ref` matrix."""
    h_court_to_f_norm = s_w_to_norm @ h_court_to_f_w
    h_f_to_court_norm = _safe_inv(h_court_to_f_norm)
    if h_f_to_court_norm is None:
        return None
    f2r = base_court_to_image @ h_f_to_court_norm
    if not np.all(np.isfinite(f2r)) or np.linalg.cond(f2r) > _MAX_HOMOGRAPHY_COND:
        return None
    # Scale so homogeneous `w` is positive at the centre of the frame.
    w_center = float(f2r[2, 0] * 0.5 + f2r[2, 1] * 0.5 + f2r[2, 2])
    if w_center < 0:
        f2r = -f2r
    norm = float(np.linalg.norm(f2r))
    return None if norm < 1e-12 else f2r / norm


def _param_matrix(p: np.ndarray) -> Matrix:
    return np.array(
        [[1.0 + p[0], p[1], p[2]], [p[3], 1.0 + p[4], p[5]], [p[6], p[7], 1.0]], dtype=np.float64
    )


def _normalise_h(h: Matrix) -> Matrix:
    scale = float(h[2, 2]) if abs(float(h[2, 2])) > 1e-12 else float(np.linalg.norm(h))
    return h / scale if scale != 0 else h


def _safe_inv(h: Matrix) -> Matrix | None:
    try:
        inv = np.linalg.inv(h)
    except np.linalg.LinAlgError:
        return None
    return inv if np.all(np.isfinite(inv)) else None


def _max_corner_disp(h0: Matrix, h1: Matrix, sw: int, sh: int) -> float:
    """Approximate max pixel shift of visible court corners between two consecutive keyframes."""
    h0_inv = _safe_inv(h0)
    if h0_inv is None:
        return math.inf
    step = h1 @ h0_inv
    corners = np.array(
        [[0.0, 0.0, 1.0], [sw, 0.0, 1.0], [sw, sh, 1.0], [0.0, sh, 1.0]], dtype=np.float64
    )
    warped = (step @ corners.T).T
    if np.any(np.abs(warped[:, 2]) < 1e-9):
        return math.inf
    pts = warped[:, :2] / warped[:, 2:3]
    return float(np.max(np.linalg.norm(pts - corners[:, :2], axis=1)))
