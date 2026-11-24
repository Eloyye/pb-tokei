"""Mapping between video frames and the court, fitted from each Camera View's Calibration.

Part of Tracking (ADR 0001): Event Processing never reads this. A Calibration's clicked Landmarks
are fitted to a ground-plane homography, so only points on the court surface (feet, landings) map
correctly. There is no lens-distortion model.

A homography also maps points behind the camera, and image points above the horizon, as if they
were in front. Each fitted matrix is scaled so that its homogeneous `w` is positive at the
Landmarks, which are all on the visible court; a point whose `w` is not positive is behind the
camera (court to image) or not on the ground (image to court).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np

from pb_tokei.rally_log import (
    Calibration,
    CameraView,
    CourtPoint,
    ImagePoint,
    Landmark,
    PlaySegment,
)

MIN_LANDMARKS = 4
"""A homography needs four points, no three of them on one line."""

ERROR_WARNING_FT = 0.5
"""A Landmark error above this many feet is flagged: Zone boundaries need about this accuracy."""

_MAX_CONDITION = 1e12

type Matrix = np.ndarray[tuple[int, int], np.dtype[np.float64]]


@dataclass(frozen=True, eq=False)
class Homography:
    """One Calibration's ground-plane mapping: normalised image points to court feet and back."""

    image_to_court: Matrix
    court_to_image: Matrix

    def to_court(self, point: ImagePoint) -> CourtPoint | None:
        """Where an image point lies on the court, or None if it's above the horizon."""
        mapped = _apply(self.image_to_court, point.x, point.y)
        return None if mapped is None else CourtPoint(*mapped)

    def to_image(self, point: CourtPoint) -> ImagePoint | None:
        """Where a court point appears in the frame, or None if it's behind the camera.

        The result may lie outside the frame (beyond 0 to 1); see `in_frame`.
        """
        mapped = _apply(self.court_to_image, point.x, point.y)
        return None if mapped is None else ImagePoint(*mapped)

    def in_frame(self, point: CourtPoint) -> bool:
        """Whether a court point is in shot: in front of the camera and inside the frame."""
        image = self.to_image(point)
        return image is not None and 0 <= image.x <= 1 and 0 <= image.y <= 1


@dataclass(frozen=True)
class LandmarkError:
    """How far off the fit puts a clicked Landmark, in feet on the court.

    `residual_ft` uses the fit that includes the Landmark. `leave_one_out_ft` refits without it,
    which says how well the fit predicts a point it wasn't given; it is None when the other
    Landmarks can't be fitted on their own.
    """

    residual_ft: float | None
    leave_one_out_ft: float | None

    @property
    def worst_ft(self) -> float | None:
        return self.leave_one_out_ft if self.leave_one_out_ft is not None else self.residual_ft


@dataclass(frozen=True)
class CalibrationFit:
    """A Calibration's fitted homography, or None while it is incomplete, and its errors."""

    homography: Homography | None
    errors: dict[Landmark, LandmarkError]

    @property
    def complete(self) -> bool:
        return self.homography is not None

    @property
    def worst_error_ft(self) -> float | None:
        errors = [e.worst_ft for e in self.errors.values() if e.worst_ft is not None]
        return max(errors, default=None)

    @property
    def needs_attention(self) -> bool:
        worst = self.worst_error_ft
        return worst is not None and worst > ERROR_WARNING_FT


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


def assess(calibration: Calibration) -> CalibrationFit:
    """Fits a Calibration and measures each Landmark's error, in feet."""
    landmarks = calibration.landmarks
    homography = fit_landmarks(landmarks)
    if homography is None:
        return CalibrationFit(None, {})
    errors = {}
    for landmark, point in landmarks.items():
        others = {lm: p for lm, p in landmarks.items() if lm is not landmark}
        refit = fit_landmarks(others)
        errors[landmark] = LandmarkError(
            residual_ft=_error_ft(homography, landmark, point),
            leave_one_out_ft=None if refit is None else _error_ft(refit, landmark, point),
        )
    return CalibrationFit(homography, errors)


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
    """The court mapping at any frame of a Match, from its Play Segments and Calibrations."""

    def __init__(self, segments: Sequence[PlaySegment], calibrations: Sequence[Calibration]):
        self._segments = sorted(segments, key=lambda s: s.start_frame)
        self._calibrations = tuple(calibrations)
        self._fits: dict[tuple[CameraView, int], Homography | None] = {}

    def at(self, frame: int) -> Homography | None:
        """The homography for a frame, or None outside Play Segments or without a complete fit."""
        segment = next((s for s in self._segments if s.contains(frame)), None)
        if segment is None:
            return None
        calibration = calibration_at(self._calibrations, segment.camera_view, frame)
        if calibration is None:
            return None
        key = (calibration.camera_view, calibration.effective_from_frame)
        if key not in self._fits:
            self._fits[key] = fit_landmarks(calibration.landmarks)
        return self._fits[key]


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


def _error_ft(homography: Homography, landmark: Landmark, point: ImagePoint) -> float | None:
    court = homography.to_court(point)
    if court is None:
        return None
    target = landmark.court_point
    return math.hypot(court.x - target.x, court.y - target.y)
