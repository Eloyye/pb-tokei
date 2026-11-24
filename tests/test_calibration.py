import math

import numpy as np
import pytest

from pb_tokei.calibration import (
    CourtMapping,
    Homography,
    assess,
    calibration_at,
    fit_landmarks,
    resolve_landmarks,
)
from pb_tokei.rally_log import (
    Calibration,
    CameraView,
    CourtPoint,
    ImagePoint,
    Landmark,
    PlacedLandmark,
    PlaySegment,
)

WIDTH, HEIGHT = 1920, 1080


class Camera:
    """A pinhole broadcast camera looking at a point on the court, for making synthetic clicks."""

    def __init__(
        self, position: tuple[float, float, float], target: tuple[float, float, float], fov: float
    ) -> None:
        eye = np.array(position, dtype=float)
        forward = np.array(target, dtype=float) - eye
        forward /= np.linalg.norm(forward)
        right = np.cross(forward, [0.0, 0.0, 1.0])
        right /= np.linalg.norm(right)
        down = np.cross(forward, right)
        self.rotation = np.array([right, down, forward])
        self.eye = eye
        self.focal = (WIDTH / 2) / math.tan(math.radians(fov) / 2)

    def pixel(self, x: float, y: float) -> tuple[float, float] | None:
        """Pixel coordinates of a court point, or None if it is behind the camera."""
        cam = self.rotation @ (np.array([x, y, 0.0]) - self.eye)
        if cam[2] <= 0:
            return None
        return (
            WIDTH / 2 + self.focal * cam[0] / cam[2],
            HEIGHT / 2 + self.focal * cam[1] / cam[2],
        )

    def image(self, x: float, y: float, noise_px: tuple[float, float] = (0, 0)) -> ImagePoint:
        pixel = self.pixel(x, y)
        assert pixel is not None
        return ImagePoint((pixel[0] + noise_px[0]) / WIDTH, (pixel[1] + noise_px[1]) / HEIGHT)

    def in_frame(self, x: float, y: float) -> bool:
        pixel = self.pixel(x, y)
        return pixel is not None and 0 <= pixel[0] <= WIDTH and 0 <= pixel[1] <= HEIGHT

    def clicks(
        self, landmarks: list[Landmark] | None = None, noise_px: float = 0, seed: int = 0
    ) -> dict[Landmark, ImagePoint]:
        """Clicks every Landmark in shot (or those given), with Gaussian click noise in pixels."""
        rng = np.random.default_rng(seed)
        chosen = list(Landmark) if landmarks is None else landmarks
        clicks = {}
        for landmark in chosen:
            p = landmark.court_point
            if not self.in_frame(p.x, p.y):
                continue
            noise = rng.normal(0, noise_px, 2) if noise_px else (0.0, 0.0)
            clicks[landmark] = self.image(p.x, p.y, (float(noise[0]), float(noise[1])))
        return clicks

    def placed(
        self,
        frame: int = 0,
        landmarks: list[Landmark] | None = None,
        noise_px: float = 0,
        seed: int = 0,
    ) -> dict[Landmark, PlacedLandmark]:
        """Same as `clicks`, tagged with `frame` for constructing a `Calibration`."""
        return {
            lm: PlacedLandmark.at(pt, frame)
            for lm, pt in self.clicks(landmarks, noise_px=noise_px, seed=seed).items()
        }


# High behind the near baseline, the whole court in shot.
MAIN = Camera(position=(0, -50, 25), target=(0, -3, 0), fov=50)
# Low beside the left sideline by the kitchen, looking across: only Landmarks on the centreline and
# the right sideline are in shot.
SIDELINE = Camera(position=(-16, -4, 5), target=(4, 2, 0), fov=75)


def assert_near(a: CourtPoint | None, b: CourtPoint, tol: float) -> None:
    assert a is not None
    assert math.hypot(a.x - b.x, a.y - b.y) < tol, (a, b)


# --- Landmarks ----------------------------------------------------------------------------


def test_landmarks_sit_on_the_court_lines_seen_from_the_main_view() -> None:
    assert Landmark.NEAR_BASELINE_LEFT.court_point == CourtPoint(-10, -22)
    assert Landmark.NEAR_KITCHEN_CENTRE.court_point == CourtPoint(0, -7)
    assert Landmark.FAR_KITCHEN_RIGHT.court_point == CourtPoint(10, 7)
    assert Landmark.FAR_BASELINE_CENTRE.court_point == CourtPoint(0, 22)
    assert len({lm.court_point for lm in Landmark}) == 12


def test_the_synthetic_cameras_see_what_their_views_see() -> None:
    assert len(MAIN.clicks()) == 12
    seen = set(SIDELINE.clicks())
    assert 4 <= len(seen) < 12
    assert Landmark.FAR_KITCHEN_RIGHT in seen


# --- Fitting ------------------------------------------------------------------------------


@pytest.mark.parametrize("camera", [MAIN, SIDELINE], ids=["main", "sideline"])
def test_exact_clicks_recover_the_court_mapping(camera: Camera) -> None:
    homography = fit_landmarks(camera.clicks())

    assert homography is not None
    # Points that aren't Landmarks, including Zone boundaries at 9, 12 and 18 ft.
    for x, y in [(3, -9), (-4, -12), (5, -18), (0, 0), (2, 9), (-6, 15)]:
        if camera.in_frame(x, y):
            assert_near(homography.to_court(camera.image(x, y)), CourtPoint(x, y), 1e-6)


@pytest.mark.parametrize("camera", [MAIN, SIDELINE], ids=["main", "sideline"])
def test_image_to_court_to_image_round_trips(camera: Camera) -> None:
    homography = fit_landmarks(camera.clicks())
    assert homography is not None
    start = ImagePoint(0.4, 0.8)

    court = homography.to_court(start)
    assert court is not None
    back = homography.to_image(court)

    assert back is not None
    assert back.x == pytest.approx(start.x) and back.y == pytest.approx(start.y)


def test_noisy_clicks_still_place_zone_boundaries_within_half_a_foot() -> None:
    homography = fit_landmarks(MAIN.clicks(noise_px=1.5, seed=1))

    assert homography is not None
    for x, y in [(3, -9), (-4, -12), (5, -18), (2, 9), (-3, 12), (6, 18)]:
        assert_near(homography.to_court(MAIN.image(x, y)), CourtPoint(x, y), 0.5)


def test_fewer_than_four_landmarks_give_no_fit() -> None:
    clicks = MAIN.clicks()
    three = {lm: clicks[lm] for lm in list(clicks)[:3]}

    assert fit_landmarks(three) is None


def test_four_landmarks_with_three_on_one_line_give_no_fit() -> None:
    line = [
        Landmark.NEAR_BASELINE_LEFT,
        Landmark.NEAR_BASELINE_CENTRE,
        Landmark.NEAR_BASELINE_RIGHT,
    ]
    kitchen = [Landmark.NEAR_KITCHEN_LEFT, Landmark.NEAR_KITCHEN_RIGHT]

    assert fit_landmarks(MAIN.clicks([*line, kitchen[0]])) is None
    assert fit_landmarks(MAIN.clicks([*line, *kitchen])) is not None


def test_landmarks_on_two_lines_are_enough() -> None:
    six = [lm for lm in Landmark if lm.value.startswith(("near_baseline", "near_kitchen"))]

    assert fit_landmarks(MAIN.clicks(six)) is not None


def test_clicks_all_on_one_spot_give_no_fit() -> None:
    spot = ImagePoint(0.5, 0.5)
    corners = [lm for lm in Landmark if not lm.value.endswith("centre")]

    assert fit_landmarks(dict.fromkeys(corners, spot)) is None


# --- Behind the camera and above the horizon ----------------------------------------------


def test_court_points_behind_the_camera_are_not_in_frame() -> None:
    homography = fit_landmarks(SIDELINE.clicks())
    assert homography is not None
    behind = CourtPoint(-25, -4)  # past the camera, which stands at x = -16

    assert SIDELINE.pixel(behind.x, behind.y) is None
    assert homography.to_image(behind) is None
    assert not homography.in_frame(behind)


def test_court_points_in_front_but_out_of_shot_are_not_in_frame() -> None:
    homography = fit_landmarks(SIDELINE.clicks())
    assert homography is not None
    out_of_shot = Landmark.NEAR_BASELINE_LEFT.court_point

    assert not SIDELINE.in_frame(out_of_shot.x, out_of_shot.y)
    assert homography.to_image(out_of_shot) is not None
    assert not homography.in_frame(out_of_shot)
    assert homography.in_frame(Landmark.FAR_KITCHEN_RIGHT.court_point)


def test_image_points_above_the_horizon_are_not_on_the_court() -> None:
    homography = fit_landmarks(SIDELINE.clicks())
    assert homography is not None

    assert homography.to_court(ImagePoint(0.5, 0.0)) is None


# --- Errors -------------------------------------------------------------------------------


def test_exact_clicks_have_no_error() -> None:
    fit = assess(Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0)))

    assert fit.complete
    assert fit.worst_error_ft == pytest.approx(0, abs=1e-6)
    assert not fit.needs_attention
    assert fit.unmapped_landmarks == frozenset()


def test_a_misclicked_landmark_stands_out_when_left_out() -> None:
    clicks = MAIN.placed(0)
    corner = Landmark.FAR_BASELINE_RIGHT
    clicks[corner] = PlacedLandmark(clicks[corner].x + 0.02, clicks[corner].y, 0)

    fit = assess(Calibration(CameraView.MAIN, 0, 0, clicks))

    worst = max(fit.errors, key=lambda lm: fit.errors[lm].leave_one_out_ft or 0)
    assert worst is corner
    assert fit.errors[corner].needs_attention
    assert fit.needs_attention


def test_a_landmark_clicked_above_the_horizon_is_flagged_off_court() -> None:
    clicks = SIDELINE.placed(0)
    corner = Landmark.FAR_BASELINE_RIGHT
    clicks[corner] = PlacedLandmark(clicks[corner].x, 0.0, 0)  # on the backstop, not the line

    fit = assess(Calibration(CameraView.SIDELINE, 0, 0, clicks))

    error = fit.errors[corner]
    assert error.leave_one_out_ft == math.inf
    assert error.off_court
    assert fit.worst_error_ft == math.inf
    assert fit.needs_attention


def test_leave_one_out_needs_four_other_landmarks() -> None:
    four = [
        Landmark.NEAR_BASELINE_LEFT,
        Landmark.NEAR_BASELINE_RIGHT,
        Landmark.FAR_BASELINE_LEFT,
        Landmark.FAR_BASELINE_RIGHT,
    ]

    fit = assess(Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0, four)))

    assert fit.complete
    assert all(e.leave_one_out_ft is None for e in fit.errors.values())
    assert all(e.residual_ft == pytest.approx(0, abs=1e-6) for e in fit.errors.values())


def test_an_incomplete_calibration_has_no_fit_and_no_errors() -> None:
    fit = assess(Calibration(CameraView.MAIN, 0, 0, {}))

    assert not fit.complete
    assert fit.errors == {}
    assert fit.worst_error_ft is None


# --- Multi-frame Landmarks (Option 2) -----------------------------------------------------


def test_off_reference_landmark_without_frame_to_ref_is_excluded_not_silently_mixed() -> None:
    clicks = MAIN.placed(100)
    # One Landmark was clicked on frame 140 (different camera angle) with no registration available.
    off_ref = Landmark.FAR_BASELINE_RIGHT
    clicks[off_ref] = PlacedLandmark(0.05, 0.05, 140)
    cal = Calibration(CameraView.MAIN, 0, 100, clicks)

    resolved, unmapped = resolve_landmarks(cal)
    assert off_ref not in resolved
    assert unmapped == frozenset({off_ref})

    fit = assess(cal)
    assert fit.complete
    assert fit.unmapped_landmarks == frozenset({off_ref})
    assert off_ref not in fit.errors
    assert fit.needs_attention
    # Remaining 11 reference-frame clicks still fit cleanly with ~0 error.
    assert fit.worst_error_ft == pytest.approx(0, abs=1e-6)


def test_multi_frame_landmarks_mapped_through_frame_to_ref_recover_exact_homography() -> None:
    cam_ref = Camera(position=(-22, -4, 11), target=(1.5, 0.0, 0), fov=64)
    cam_pan = Camera(position=(-22, -4, 11), target=(4.5, 4.5, 0), fov=74)
    h_ref = fit_landmarks(cam_ref.clicks())
    h_pan = fit_landmarks(cam_pan.clicks())
    assert h_ref is not None and h_pan is not None
    pan_to_ref = h_ref.court_to_image @ h_pan.image_to_court

    # Only 2 Landmarks on reference frame 100, plus 3 clicked on panned frame 150!
    ref_lms = [Landmark.NEAR_KITCHEN_CENTRE, Landmark.NEAR_KITCHEN_RIGHT]
    pan_lms = [
        Landmark.FAR_KITCHEN_CENTRE,
        Landmark.FAR_KITCHEN_RIGHT,
        Landmark.FAR_BASELINE_RIGHT,
    ]
    landmarks = {**cam_ref.placed(100, ref_lms), **cam_pan.placed(150, pan_lms)}
    cal = Calibration(CameraView.SIDELINE, 0, 100, landmarks)

    # Without frame_to_ref, only 2 points resolve -> incomplete and 3 unmapped.
    unregistered_fit = assess(cal)
    assert not unregistered_fit.complete
    assert unregistered_fit.unmapped_landmarks == frozenset(pan_lms)

    # With pan_to_ref, all 5 resolve into reference-frame coordinates and fit exactly.
    fit = assess(cal, frame_to_ref={150: pan_to_ref})
    assert fit.complete
    assert fit.homography is not None
    assert fit.unmapped_landmarks == frozenset()
    assert fit.worst_error_ft == pytest.approx(0, abs=1e-5)
    assert not fit.needs_attention

    for x, y in [(0.0, -7.0), (5.0, 7.0), (10.0, 12.0)]:
        if cam_ref.in_frame(x, y):
            assert_near(fit.homography.to_court(cam_ref.image(x, y)), CourtPoint(x, y), 1e-5)


# --- Which Calibration is in effect -------------------------------------------------------

MAIN_EARLY = Calibration(CameraView.MAIN, 100, 150, MAIN.placed(150))
MAIN_LATE = Calibration(CameraView.MAIN, 5000, 5100, MAIN.placed(5100))
SIDE = Calibration(CameraView.SIDELINE, 2000, 2100, SIDELINE.placed(2100))
CALIBRATIONS = [MAIN_LATE, SIDE, MAIN_EARLY]


@pytest.mark.parametrize(
    ("view", "frame", "expected"),
    [
        (CameraView.MAIN, 100, MAIN_EARLY),
        (CameraView.MAIN, 4999, MAIN_EARLY),
        (CameraView.MAIN, 5000, MAIN_LATE),
        (CameraView.MAIN, 0, MAIN_EARLY),  # before any: the view's earliest
        (CameraView.SIDELINE, 10, SIDE),
    ],
)
def test_the_calibration_in_effect_is_the_latest_started(
    view: CameraView, frame: int, expected: Calibration
) -> None:
    assert calibration_at(CALIBRATIONS, view, frame) is expected


def test_no_calibration_is_in_effect_for_an_uncalibrated_view() -> None:
    assert calibration_at([MAIN_EARLY], CameraView.SIDELINE, 100) is None


def test_court_mapping_follows_play_segments_and_calibrations() -> None:
    segments = [
        PlaySegment(100, 1999, CameraView.MAIN),
        PlaySegment(2000, 2999, CameraView.SIDELINE),
        PlaySegment(5000, 6000, CameraView.MAIN),
        PlaySegment(7000, 7100, CameraView.SIDELINE),
    ]
    late = Calibration(CameraView.SIDELINE, 7000, 7000, {})  # started, nothing clicked yet
    mapping = CourtMapping(segments, [*CALIBRATIONS, late])

    assert mapping.at(50) is None  # not a Play Segment
    main = mapping.at(150)
    side = mapping.at(2500)
    assert isinstance(main, Homography) and isinstance(side, Homography)
    point = CourtPoint(2, -9)
    assert_near(main.to_court(MAIN.image(point.x, point.y)), point, 1e-6)
    assert_near(side.to_court(SIDELINE.image(point.x, point.y)), point, 1e-6)
    assert mapping.at(7050) is None  # the Calibration in effect is incomplete
