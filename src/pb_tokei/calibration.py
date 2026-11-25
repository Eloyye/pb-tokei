"""Mapping between video frames and the court, fitted from each Camera View's Calibration.

Part of Tracking (ADR 0001): Event Processing never reads this. A Calibration's clicked Landmarks
are fitted to a ground-plane homography, so only points on the court surface (feet, landings) map
correctly. The clicked fit has no lens model; a frame tracked by Camera Motion may carry one (a
`Lens`, ADR 0011), applied to image points before the homography.

A homography also maps points behind the camera, and image points above the horizon, as if they
were in front. Each fitted matrix is scaled so that its homogeneous `w` is positive at the
Landmarks, which are all on the visible court; a point whose `w` is not positive is behind the
camera (court to image) or not on the ground (image to court).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

from pb_tokei.rally_log import (
    Calibration,
    CameraView,
    CourtPoint,
    ImagePoint,
    Landmark,
    PlaySegment,
)

if TYPE_CHECKING:
    from pb_tokei.camera_motion import CameraMotion

MIN_LANDMARKS = 4
"""A homography needs four points, no three of them on one line."""

ERROR_WARNING_FT = 0.5
"""A Landmark error above this many feet is flagged: Zone boundaries need about this accuracy."""

_MAX_CONDITION = 1e12

_ALL_LANDMARK_COURT_POINTS = np.array(
    [[lm.court_point.x, lm.court_point.y] for lm in Landmark], dtype=np.float64
)

type Matrix = np.ndarray[tuple[int, int], np.dtype[np.float64]]


@dataclass(frozen=True)
class Lens:
    """One-coefficient radial lens distortion about the frame centre, in normalised coordinates.

    Broadcast lenses bow straight court lines near the frame edges. A point `p` of the frame lies
    at `c + (p - c) * (1 + k1 * r^2)` in the undistorted image, where `c` is the frame centre and
    `r` is the distance from it in pixels over the frame's half-diagonal; `aspect` is the frame's
    width over its height, which turns normalised coordinates back into pixel proportions.
    """

    k1: float
    aspect: float

    def radius2(self, points: np.ndarray) -> np.ndarray:
        """Squared distance of `(N, 2)` normalised points from the centre, in half-diagonals."""
        d = points - 0.5
        return 4.0 * (d[:, 0] ** 2 * self.aspect**2 + d[:, 1] ** 2) / (self.aspect**2 + 1.0)

    def undistort(self, points: np.ndarray) -> np.ndarray:
        """Where `(N, 2)` normalised frame points lie in the undistorted image."""
        if self.k1 == 0.0 or len(points) == 0:
            return points
        return 0.5 + (points - 0.5) * (1.0 + self.k1 * self.radius2(points))[:, None]

    def distort(self, points: np.ndarray) -> np.ndarray:
        """Where `(N, 2)` undistorted normalised points appear in the frame (`undistort` inverse).

        Solved by fixed-point iteration on the radial scale, which converges for the small
        coefficients of broadcast lenses.
        """
        if self.k1 == 0.0 or len(points) == 0:
            return points
        ru2 = self.radius2(points)
        s = np.ones(len(points))
        for _ in range(12):
            s = np.clip(1.0 / np.maximum(1.0 + self.k1 * ru2 * s * s, 1e-3), 0.2, 5.0)
        return 0.5 + (points - 0.5) * s[:, None]


@dataclass(frozen=True, eq=False)
class Homography:
    """A ground-plane mapping between normalised image points and court feet.

    With a `lens`, the matrices relate the court to the undistorted image: `to_court` undistorts
    an image point before mapping it, and `to_image` distorts the mapped point back into the frame.
    A Calibration's own fit has no lens; frames tracked by Camera Motion may (ADR 0011).
    """

    image_to_court: Matrix
    court_to_image: Matrix
    lens: Lens | None = None

    def to_court(self, point: ImagePoint) -> CourtPoint | None:
        """Where an image point lies on the court, or None if it's above the horizon."""
        x, y = point.x, point.y
        if self.lens is not None:
            x, y = self.lens.undistort(np.array([[x, y]], dtype=np.float64))[0]
        mapped = _apply(self.image_to_court, float(x), float(y))
        return None if mapped is None else CourtPoint(*mapped)

    def to_image(self, point: CourtPoint) -> ImagePoint | None:
        """Where a court point appears in the frame, or None if it's behind the camera.

        The result may lie outside the frame (beyond 0 to 1); see `in_frame`.
        """
        mapped = _apply(self.court_to_image, point.x, point.y)
        if mapped is None:
            return None
        if self.lens is not None:
            x, y = self.lens.distort(np.array([mapped], dtype=np.float64))[0]
            return ImagePoint(float(x), float(y))
        return ImagePoint(*mapped)

    def in_frame(self, point: CourtPoint) -> bool:
        """Whether a court point is in shot: in front of the camera and inside the frame."""
        image = self.to_image(point)
        return image is not None and 0 <= image.x <= 1 and 0 <= image.y <= 1

    def compose(
        self,
        frame_to_ref: Matrix,
        *,
        court_points: np.ndarray | None = None,
        lens: Lens | None = None,
    ) -> Homography | None:
        """Composes this reference-frame mapping with a frame's Camera Motion (`frame -> ref`).

        With a `lens`, `frame_to_ref` takes the frame's undistorted image to the reference frame,
        and the result carries that lens. Returns a Homography for that frame, or None if
        `frame_to_ref` is singular or degenerate.
        """
        if not np.all(np.isfinite(frame_to_ref)) or np.linalg.cond(frame_to_ref) > _MAX_CONDITION:
            return None
        try:
            ref_to_frame = np.linalg.inv(frame_to_ref)
        except np.linalg.LinAlgError:
            return None
        image_to_court = self.image_to_court @ frame_to_ref
        court_to_image = ref_to_frame @ self.court_to_image
        if (
            not np.all(np.isfinite(image_to_court))
            or not np.all(np.isfinite(court_to_image))
            or np.linalg.cond(image_to_court) > _MAX_CONDITION
        ):
            return None
        ref_court = _ALL_LANDMARK_COURT_POINTS if court_points is None else court_points
        court_to_image = _facing_forward(court_to_image, ref_court)
        projected = (court_to_image @ np.column_stack([ref_court, np.ones(len(ref_court))]).T).T
        front = projected[:, 2] > 1e-9
        if np.any(front):
            img_pts = projected[front, :2] / projected[front, 2:3]
            image_to_court = _facing_forward(image_to_court, img_pts)
        else:
            image_to_court = _facing_forward(image_to_court, np.array([[0.5, 0.5]]))
        if lens is not None and lens.k1 == 0.0:
            lens = None
        return Homography(image_to_court=image_to_court, court_to_image=court_to_image, lens=lens)


@dataclass(frozen=True)
class LandmarkError:
    """How far off the fit puts a clicked Landmark, in feet on the court.

    `residual_ft` uses the fit that includes the Landmark. `leave_one_out_ft` refits without it,
    which says how well the fit predicts a point it wasn't given; it is None when the other
    Landmarks can't be fitted on their own. Either is infinite when that fit puts the click off
    the court (above the horizon), as a Landmark clicked on the backstop can be.
    """

    residual_ft: float
    leave_one_out_ft: float | None

    @property
    def worst_ft(self) -> float:
        return self.leave_one_out_ft if self.leave_one_out_ft is not None else self.residual_ft

    @property
    def off_court(self) -> bool:
        return math.isinf(self.worst_ft)

    @property
    def needs_attention(self) -> bool:
        return self.worst_ft > ERROR_WARNING_FT


@dataclass(frozen=True)
class CalibrationFit:
    """A Calibration's fitted homography, or None while it is incomplete, and its errors."""

    homography: Homography | None
    errors: dict[Landmark, LandmarkError]
    resolved_landmarks: dict[Landmark, ImagePoint] = field(default_factory=dict)
    unmapped_landmarks: frozenset[Landmark] = field(default_factory=frozenset)

    @property
    def complete(self) -> bool:
        return self.homography is not None

    @property
    def worst_error_ft(self) -> float | None:
        """The largest Landmark error, infinite if some click is off the court; None if no fit."""
        return max((e.worst_ft for e in self.errors.values()), default=None)

    @property
    def needs_attention(self) -> bool:
        return bool(self.unmapped_landmarks) or any(e.needs_attention for e in self.errors.values())


def resolve_landmarks(
    calibration: Calibration,
    frame_to_ref: Mapping[int, Matrix] | None = None,
    lenses: Mapping[int, Lens] | None = None,
) -> tuple[dict[Landmark, ImagePoint], frozenset[Landmark]]:
    """Maps a Calibration's placed Landmarks into `reference_frame` image coordinates.

    Landmarks clicked on `reference_frame` stay as-is. Landmarks clicked on another frame `f`
    are warped through `frame_to_ref[f]`, after undistorting the click with `lenses[f]` when that
    matrix starts from the undistorted image (Camera Motion's, ADR 0011); if no valid transform is
    available for `f` (or the warped point lies behind the camera), the Landmark is returned in
    `unmapped_landmarks` rather than silently mixed with `reference_frame` clicks.
    """
    resolved: dict[Landmark, ImagePoint] = {}
    unmapped: set[Landmark] = set()
    for landmark, placed in calibration.landmarks.items():
        if placed.frame == calibration.reference_frame:
            resolved[landmark] = placed.point
            continue
        matrix = None if frame_to_ref is None else frame_to_ref.get(placed.frame)
        if matrix is None:
            unmapped.add(landmark)
            continue
        x, y = placed.x, placed.y
        lens = None if lenses is None else lenses.get(placed.frame)
        if lens is not None:
            x, y = (float(v) for v in lens.undistort(np.array([[x, y]], dtype=np.float64))[0])
        mapped = _apply(matrix, x, y)
        if mapped is None or not (math.isfinite(mapped[0]) and math.isfinite(mapped[1])):
            unmapped.add(landmark)
            continue
        resolved[landmark] = ImagePoint(*mapped)
    return resolved, frozenset(unmapped)


def fit_landmarks(landmarks: Mapping[Landmark, ImagePoint]) -> Homography | None:
    """Fits the homography for clicked Landmarks, or None if they can't determine one.

    That is when fewer than four were clicked, when no four of them have three on one line, or
    when the clicks themselves are degenerate (such as several on one spot).
    """
    if not _determines_homography([lm.court_point for lm in landmarks]):
        return None
    image = np.array([[p.x, p.y] for p in landmarks.values()], dtype=np.float64)
    court = np.array([[lm.court_point.x, lm.court_point.y] for lm in landmarks], dtype=np.float64)
    image_to_court = _dlt(image, court)
    if image_to_court is None or np.linalg.cond(image_to_court) > _MAX_CONDITION:
        return None
    court_to_image = np.linalg.inv(image_to_court)
    return Homography(
        image_to_court=_facing_forward(image_to_court, image),
        court_to_image=_facing_forward(court_to_image, court),
    )


def assess(
    calibration: Calibration,
    *,
    frame_to_ref: Mapping[int, Matrix] | None = None,
) -> CalibrationFit:
    """Fits a Calibration on its `reference_frame` and measures each Landmark's error, in feet.

    Landmarks clicked on other frames are mapped back to `reference_frame` via `frame_to_ref`
    before fitting; any that cannot be mapped are excluded from the fit and returned in
    `unmapped_landmarks`.
    """
    resolved, unmapped = resolve_landmarks(calibration, frame_to_ref)
    homography = fit_landmarks(resolved)
    if homography is None:
        return CalibrationFit(None, {}, resolved, unmapped)
    errors = {}
    for landmark, point in resolved.items():
        others = {lm: p for lm, p in resolved.items() if lm is not landmark}
        refit = fit_landmarks(others)
        errors[landmark] = LandmarkError(
            residual_ft=_error_ft(homography, landmark, point),
            leave_one_out_ft=None if refit is None else _error_ft(refit, landmark, point),
        )
    return CalibrationFit(homography, errors, resolved, unmapped)


def calibration_at(
    calibrations: Iterable[Calibration], camera_view: CameraView, frame: int
) -> Calibration | None:
    """The Calibration of a Camera View in effect at a frame.

    That is the latest of that view starting at or before the frame, or else the view's earliest,
    so a single Calibration covers the whole Match.
    """
    of_view = sorted(
        (c for c in calibrations if c.camera_view is camera_view),
        key=lambda c: c.effective_from_frame,
    )
    started = [c for c in of_view if c.effective_from_frame <= frame]
    if started:
        return started[-1]
    return of_view[0] if of_view else None


class CourtMapping:
    """The court mapping at any frame of a Match, from Play Segments, Calibrations and motion."""

    def __init__(
        self,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        camera_motion: CameraMotion | None = None,
        landmark_frame_to_ref: Mapping[tuple[CameraView, int], Mapping[int, Matrix]] | None = None,
    ):
        self._segments = sorted(segments, key=lambda s: s.start_frame)
        self._calibrations = tuple(calibrations)
        self._camera_motion = camera_motion
        self._landmark_frame_to_ref = landmark_frame_to_ref
        self._fits: dict[tuple[CameraView, int], Homography | None] = {}
        self._landmark_courts: dict[tuple[CameraView, int], np.ndarray] = {}

    def _frame_to_ref_for(
        self, calibration: Calibration
    ) -> tuple[dict[int, Matrix], dict[int, Lens]]:
        # Explicit `landmark_frame_to_ref` takes precedence over `camera_motion`: it is estimated
        # independently of the Calibration's own fit and also covers clicks from outside the active
        # span (e.g. carried over from an earlier Play Segment). `camera_motion` is a fallback for
        # off-reference clicks inside a span tracked for the same view and reference frame; its
        # matrices start from the undistorted image, so their lenses come too.
        key = (calibration.camera_view, calibration.effective_from_frame)
        f2r: dict[int, Matrix] = {}
        lenses: dict[int, Lens] = {}
        if self._landmark_frame_to_ref is not None:
            f2r.update(self._landmark_frame_to_ref.get(key, {}))
        if self._camera_motion is not None:
            for placed in calibration.landmarks.values():
                if placed.frame == calibration.reference_frame or placed.frame in f2r:
                    continue
                span = self._camera_motion.span_at(placed.frame)
                if (
                    span is not None
                    and span.camera_view is calibration.camera_view
                    and span.calibration_reference_frame == calibration.reference_frame
                ):
                    mat = span.at(placed.frame)
                    if mat is not None:
                        f2r[placed.frame] = mat
                        if span.lens is not None:
                            lenses[placed.frame] = span.lens
        return f2r, lenses

    def at(self, frame: int) -> Homography | None:
        """The homography for a frame, or None outside Play Segments, unmapped, or incomplete."""
        segment = next((s for s in self._segments if s.contains(frame)), None)
        if segment is None:
            return None
        calibration = calibration_at(self._calibrations, segment.camera_view, frame)
        if calibration is None:
            return None
        key = (calibration.camera_view, calibration.effective_from_frame)
        if key not in self._fits:
            f2r, lenses = self._frame_to_ref_for(calibration)
            resolved, _ = resolve_landmarks(calibration, f2r, lenses)
            self._fits[key] = fit_landmarks(resolved)
            if resolved:
                self._landmark_courts[key] = np.array(
                    [[lm.court_point.x, lm.court_point.y] for lm in resolved],
                    dtype=np.float64,
                )
        base = self._fits[key]
        if base is None:
            return None
        if self._camera_motion is None or not self._camera_motion.covers(frame):
            return base
        frame_to_ref = self._camera_motion.at(frame)
        if frame_to_ref is None:
            return None
        return base.compose(
            frame_to_ref,
            court_points=self._landmark_courts.get(key),
            lens=self._camera_motion.lens_at(frame),
        )


# --- Fitting ------------------------------------------------------------------------------


def _determines_homography(points: Sequence[CourtPoint]) -> bool:
    """Whether some four of the points have no three on one line."""
    return any(
        not any(_collinear(*three) for three in itertools.combinations(four, 3))
        for four in itertools.combinations(points, MIN_LANDMARKS)
    )


def _collinear(a: CourtPoint, b: CourtPoint, c: CourtPoint) -> bool:
    cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    return abs(cross) < 1e-9


def _dlt(source: np.ndarray, target: np.ndarray) -> Matrix | None:
    """The least-squares homography taking `source` points to `target` points.

    The direct linear transform, with both point sets normalised first (Hartley) so that image
    fractions and court feet are weighted alike.
    """
    source_norm, source_n = _normalise(source)
    target_norm, target_n = _normalise(target)
    if source_norm is None or target_norm is None:
        return None
    rows = []
    for (x, y), (u, v) in zip(source_n, target_n, strict=True):
        rows.append([-x, -y, -1, 0, 0, 0, u * x, u * y, u])
        rows.append([0, 0, 0, -x, -y, -1, v * x, v * y, v])
    _, _, vt = np.linalg.svd(np.array(rows))
    normalised = vt[-1].reshape(3, 3)
    matrix = np.linalg.inv(target_norm) @ normalised @ source_norm
    return matrix / np.linalg.norm(matrix)


def _normalise(points: np.ndarray) -> tuple[Matrix | None, np.ndarray]:
    """Moves points to have centroid 0 and mean distance √2 from it; returns the transform too."""
    centroid = points.mean(axis=0)
    spread = np.linalg.norm(points - centroid, axis=1).mean()
    if spread < 1e-12:
        return None, points
    scale = math.sqrt(2) / spread
    transform = np.array(
        [[scale, 0, -scale * centroid[0]], [0, scale, -scale * centroid[1]], [0, 0, 1]]
    )
    return transform, (points - centroid) * scale


def _facing_forward(matrix: Matrix, sources: np.ndarray) -> Matrix:
    """The matrix, negated if needed so that `w` is positive at the points it was fitted from."""
    w = matrix[2, 0] * sources[:, 0] + matrix[2, 1] * sources[:, 1] + matrix[2, 2]
    return -matrix if w.sum() < 0 else matrix


def _apply(matrix: Matrix, x: float, y: float) -> tuple[float, float] | None:
    u, v, w = matrix @ np.array([x, y, 1.0])
    if w <= 0:
        return None
    return float(u / w), float(v / w)


def _error_ft(homography: Homography, landmark: Landmark, point: ImagePoint) -> float:
    court = homography.to_court(point)
    if court is None:
        return math.inf
    target = landmark.court_point
    return math.hypot(court.x - target.x, court.y - target.y)
