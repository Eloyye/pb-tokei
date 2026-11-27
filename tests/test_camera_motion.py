"""Tests for Camera Motion tracking, court-line refinement, caching, and CourtMapping."""

from __future__ import annotations

import math
from collections.abc import Sequence, Set
from pathlib import Path

import cv2
import numpy as np
import pytest
from test_calibration import MAIN, SIDELINE, Camera, assert_near

from pb_tokei.calibration import ERROR_WARNING_FT, CourtMapping, assess, fit_landmarks
from pb_tokei.camera_motion import (
    METHOD_VERSION,
    CameraMotion,
    CameraMotionCache,
    FrameRange,
    SpanMotion,
    calibration_spans,
    span_cache_key,
    track_span,
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

# --- Synthetic broadcast renderer ---------------------------------------------------------

SYN_W, SYN_H = 640, 360

_COURT_LINE_SEGMENTS = [
    ((-10.0, -22.0), (10.0, -22.0)),
    ((-10.0, -7.0), (10.0, -7.0)),
    ((-10.0, 7.0), (10.0, 7.0)),
    ((-10.0, 22.0), (10.0, 22.0)),
    ((-10.0, -22.0), (-10.0, 22.0)),
    ((10.0, -22.0), (10.0, 22.0)),
    ((0.0, -22.0), (0.0, -7.0)),
    ((0.0, 7.0), (0.0, 22.0)),
]


def _make_court_world_canvas(*, kitchen_logo: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Renders a top-down pickleball court + textured surround canvas and court->canvas matrix.

    With `kitchen_logo`, a white sponsor logo is painted in the far kitchen: lettering, and a
    straight white edge running 1 ft short of the far kitchen line, parallel to it.
    """
    # Canvas covers x in [-26, 26], y in [-38, 38] at 18 px/ft.
    ppm = 18.0
    cw, ch = int(52 * ppm), int(76 * ppm)
    rng = np.random.default_rng(42)

    # Textured arena floor/crowd surround so ORB has abundant static features.
    canvas = np.full((ch, cw, 3), (175, 95, 35), dtype=np.uint8)
    for _ in range(900):
        x = int(rng.integers(0, cw))
        y = int(rng.integers(0, ch))
        r = int(rng.integers(3, 14))
        col = tuple(int(c) for c in rng.integers(40, 220, size=3))
        cv2.circle(canvas, (x, y), r, col, -1)

    court_to_canvas = np.array(
        [[ppm, 0.0, cw / 2.0], [0.0, ppm, ch / 2.0], [0.0, 0.0, 1.0]], dtype=np.float64
    )

    def to_px(x: float, y: float) -> tuple[int, int]:
        return int(round(x * ppm + cw / 2.0)), int(round(y * ppm + ch / 2.0))

    # Paint clean blue court surface & apron over the court area.
    cv2.rectangle(canvas, to_px(-15, -27), to_px(15, 27), (180, 95, 30), -1)
    cv2.rectangle(canvas, to_px(-10, -22), to_px(10, 22), (195, 105, 35), -1)

    # Paint crisp white court lines (~3 px wide in world canvas).
    for (x1, y1), (x2, y2) in _COURT_LINE_SEGMENTS:
        cv2.line(canvas, to_px(x1, y1), to_px(x2, y2), (245, 245, 245), 4, cv2.LINE_AA)

    if kitchen_logo:
        cv2.rectangle(canvas, to_px(-7.0, 5.6), to_px(7.0, 6.0), (245, 245, 245), -1)
        for x in np.arange(-6.5, 6.6, 1.3):
            cv2.rectangle(canvas, to_px(x, 3.2), to_px(x + 0.5, 5.6), (245, 245, 245), -1)

    return canvas, court_to_canvas


def _lens_distort_frame(frame: np.ndarray, k1: float) -> np.ndarray:
    """Bends a frame through one-coefficient radial distortion about its centre.

    An undistorted point lies at `c + (p - c) * (1 + k1 * r^2)` for frame point `p`, where `r`
    is `|p - c|` over the half-diagonal: barrel distortion for positive `k1`.
    """
    h, w = frame.shape[:2]
    cx, cy, rn = w / 2.0, h / 2.0, math.hypot(w, h) / 2.0
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    scale = 1.0 + k1 * ((xs - cx) ** 2 + (ys - cy) ** 2) / (rn * rn)
    return cv2.remap(
        frame,
        (cx + (xs - cx) * scale).astype(np.float32),
        (cy + (ys - cy) * scale).astype(np.float32),
        cv2.INTER_LINEAR,
        borderValue=(30, 30, 30),
    )


def _lens_image(camera: Camera, x: float, y: float, k1: float) -> ImagePoint:
    """Where a court point appears in a `_lens_distort_frame` frame of `camera`'s view."""
    undistorted = camera.image(x, y)
    cx, cy, rn = SYN_W / 2.0, SYN_H / 2.0, math.hypot(SYN_W, SYN_H) / 2.0
    dx, dy = undistorted.x * SYN_W - cx, undistorted.y * SYN_H - cy
    ru2 = (dx * dx + dy * dy) / (rn * rn)
    s = 1.0
    for _ in range(50):
        s = 1.0 / (1.0 + k1 * ru2 * s * s)
    return ImagePoint((cx + dx * s) / SYN_W, (cy + dy * s) / SYN_H)


def _render_camera_frame(
    canvas: np.ndarray,
    court_to_canvas: np.ndarray,
    camera: Camera,
    *,
    with_scorebug: bool = True,
) -> tuple[np.ndarray, np.ndarray]:
    """Warps the world canvas through a pinhole `Camera` and overlays a static scorebug."""
    # Exact court -> pixel homography for this synthetic camera at SYN_W x SYN_H.
    clicks = camera.clicks()
    base = fit_landmarks(clicks)
    assert base is not None
    scale = np.array([[SYN_W, 0.0, 0.0], [0.0, SYN_H, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)
    h_court_to_px = scale @ base.court_to_image
    h_canvas_to_px = h_court_to_px @ np.linalg.inv(court_to_canvas)
    frame = cv2.warpPerspective(
        canvas, h_canvas_to_px, (SYN_W, SYN_H), flags=cv2.INTER_LINEAR, borderValue=(30, 30, 30)
    )
    if with_scorebug:
        # Static top-left broadcast scorebug that stays fixed even as the camera pans/zooms.
        cv2.rectangle(frame, (8, 8), (150, 72), (20, 20, 20), -1)
        cv2.rectangle(frame, (8, 8), (150, 72), (235, 235, 235), 2)
        cv2.putText(frame, "PBTV 1-0", (18, 46), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (250, 250, 250), 2)
    return frame, h_court_to_px


def write_synthetic_video(
    path: Path,
    cameras: Sequence[Camera | None],
    *,
    kitchen_logo: bool = False,
    lens_k1: float = 0.0,
) -> None:
    """Writes an MP4 where each entry is a `Camera` frame or `None` (a hard-cut replay frame).

    `kitchen_logo` paints a sponsor logo in the far kitchen (`_make_court_world_canvas`);
    `lens_k1` bends camera frames through radial lens distortion (`_lens_distort_frame`).
    """
    canvas, court_to_canvas = _make_court_world_canvas(kitchen_logo=kitchen_logo)
    fourcc = cv2.VideoWriter.fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(path), fourcc, 60.0, (SYN_W, SYN_H))
    assert writer.isOpened(), "Failed to open OpenCV VideoWriter"
    rng = np.random.default_rng(7)
    # Build a distinct close-up/replay image with the same static scorebug (no court lines!).
    cut_frame = np.full((SYN_H, SYN_W, 3), (45, 55, 65), dtype=np.uint8)
    for _ in range(200):
        cv2.circle(
            cut_frame,
            (int(rng.integers(0, SYN_W)), int(rng.integers(0, SYN_H))),
            int(rng.integers(10, 40)),
            tuple(int(c) for c in rng.integers(60, 180, size=3)),
            -1,
        )
    cv2.rectangle(cut_frame, (8, 8), (150, 72), (20, 20, 20), -1)
    cv2.rectangle(cut_frame, (8, 8), (150, 72), (235, 235, 235), 2)
    cv2.putText(cut_frame, "PBTV 1-0", (18, 46), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (250, 250, 250), 2)

    try:
        for cam in cameras:
            if cam is None:
                writer.write(cut_frame)
            else:
                img, _ = _render_camera_frame(canvas, court_to_canvas, cam)
                writer.write(_lens_distort_frame(img, lens_k1) if lens_k1 else img)
    finally:
        writer.release()


def _panning_camera(t: float) -> Camera:
    """A fixed-position broadcast camera panning and zooming over t in [-1, 1]."""
    return Camera(
        position=(-22.0, -4.0, 11.0),
        target=(1.5 + 3.0 * t, 0.0 + 4.5 * t, 0.0),
        fov=64.0 + 10.0 * t,
    )


# --- Homography composition and CourtMapping ----------------------------------------------


def test_homography_compose_maps_panned_frame_back_to_court() -> None:
    cam_ref = _panning_camera(0.0)
    cam_t = _panning_camera(-0.8)
    base = fit_landmarks(cam_ref.clicks())
    target = fit_landmarks(cam_t.clicks())
    assert base is not None and target is not None

    frame_to_ref = base.court_to_image @ target.image_to_court
    composed = base.compose(frame_to_ref)
    assert composed is not None

    for x, y in [(0.0, -7.0), (5.0, 7.0), (-5.0, 12.0), (4.0, -15.0)]:
        if cam_t.in_frame(x, y):
            img_pt = cam_t.image(x, y)
            assert_near(composed.to_court(img_pt), CourtPoint(x, y), 1e-5)
            back = composed.to_image(CourtPoint(x, y))
            assert back is not None
            assert back.x == pytest.approx(img_pt.x, abs=1e-5)
            assert back.y == pytest.approx(img_pt.y, abs=1e-5)


def test_homography_compose_rejects_singular_matrix() -> None:
    base = fit_landmarks(MAIN.clicks())
    assert base is not None

    assert base.compose(np.zeros((3, 3), dtype=np.float64)) is None


def test_court_mapping_returns_none_on_unmapped_frames_and_composes_mapped_ones() -> None:
    cam_ref = _panning_camera(0.0)
    cam_moved = _panning_camera(0.7)
    base = fit_landmarks(cam_ref.clicks())
    moved_h = fit_landmarks(cam_moved.clicks())
    assert base is not None and moved_h is not None

    cal = Calibration(CameraView.SIDELINE, 100, 100, cam_ref.placed(100))
    seg = PlaySegment(100, 104, CameraView.SIDELINE)
    f2r = base.court_to_image @ moved_h.image_to_court

    mapped = np.array([True, True, False, False, True], dtype=bool)
    matrices = np.stack([np.eye(3), f2r, np.eye(3), np.eye(3), f2r], axis=0)
    errors = np.array([0.0, 0.04, np.nan, np.nan, 0.05], dtype=np.float32)
    span = SpanMotion(100, 104, CameraView.SIDELINE, 100, 100, mapped, matrices, errors)
    motion = CameraMotion([span])
    mapping = CourtMapping([seg], [cal], camera_motion=motion)

    assert motion.unmapped_ranges() == [FrameRange(102, 103, CameraView.SIDELINE)]
    assert mapping.at(102) is None
    assert mapping.at(103) is None

    h_ref = mapping.at(100)
    h_moved = mapping.at(101)
    assert h_ref is not None and h_moved is not None
    pt = CourtPoint(2.0, 7.0)
    assert_near(h_ref.to_court(cam_ref.image(pt.x, pt.y)), pt, 1e-5)
    assert_near(h_moved.to_court(cam_moved.image(pt.x, pt.y)), pt, 1e-5)


def test_court_mapping_camera_motion_fallback_resolves_off_ref_click_and_enforces_guards() -> None:
    cam_ref = _panning_camera(0.0)
    cam_moved = _panning_camera(0.7)
    base = fit_landmarks(cam_ref.clicks())
    moved_h = fit_landmarks(cam_moved.clicks())
    assert base is not None and moved_h is not None
    f2r = base.court_to_image @ moved_h.image_to_court

    # Only 3 Landmarks on reference frame 100 + 2 on frame 101 -> requires f2r to fit.
    ref_lms = [
        Landmark.NEAR_KITCHEN_CENTRE,
        Landmark.NEAR_KITCHEN_RIGHT,
        Landmark.FAR_KITCHEN_RIGHT,
    ]
    moved_lms = [Landmark.FAR_KITCHEN_CENTRE, Landmark.FAR_BASELINE_RIGHT]
    cal = Calibration(
        CameraView.SIDELINE,
        100,
        100,
        {**cam_ref.placed(100, ref_lms), **cam_moved.placed(101, moved_lms)},
    )
    seg = PlaySegment(100, 101, CameraView.SIDELINE)
    mapped = np.array([True, True], dtype=bool)
    matrices = np.stack([np.eye(3), f2r], axis=0)
    errors = np.array([0.0, 0.04], dtype=np.float32)

    # 1. Matching view and reference_frame: CourtMapping resolves via camera_motion alone.
    matching_span = SpanMotion(100, 101, CameraView.SIDELINE, 100, 100, mapped, matrices, errors)
    mapping = CourtMapping([seg], [cal], camera_motion=CameraMotion([matching_span]))
    h_ref = mapping.at(100)
    assert h_ref is not None
    pt = CourtPoint(2.0, 7.0)
    assert_near(h_ref.to_court(cam_ref.image(pt.x, pt.y)), pt, 1e-5)

    # 2. Span of another CameraView: guard rejects it, leaving only 3 Landmarks -> no fit.
    wrong_view_span = SpanMotion(100, 101, CameraView.MAIN, 100, 100, mapped, matrices, errors)
    assert CourtMapping([seg], [cal], camera_motion=CameraMotion([wrong_view_span])).at(100) is None

    # 3. Span anchored to a different reference_frame: guard rejects it -> no fit.
    wrong_ref_span = SpanMotion(100, 101, CameraView.SIDELINE, 100, 99, mapped, matrices, errors)
    assert CourtMapping([seg], [cal], camera_motion=CameraMotion([wrong_ref_span])).at(100) is None


# --- Span partitioning --------------------------------------------------------------------


def test_calibration_spans_splits_segment_at_inner_reanchor_calibration() -> None:
    seg = PlaySegment(100, 500, CameraView.SIDELINE)
    c1 = Calibration(CameraView.SIDELINE, 100, 120, SIDELINE.placed(120))
    c2 = Calibration(CameraView.SIDELINE, 300, 310, SIDELINE.placed(310))

    spans = calibration_spans([seg], [c2, c1])

    assert [(s.start_frame, s.end_frame, s.calibration.effective_from_frame) for s in spans] == [
        (100, 299, 100),
        (300, 500, 300),
    ]


# --- End-to-end tracking on synthetic panning/zooming video with a cut --------------------


def test_tracks_panning_and_zooming_camera_within_half_a_foot_and_flags_cuts(
    tmp_path: Path,
) -> None:
    # 40 frames: smooth pan/zoom across frames 0..24, hard cut on 25..31, recovered on 32..39.
    ref_frame = 12
    cameras: list[Camera | None] = []
    for f in range(40):
        if 25 <= f <= 31:
            cameras.append(None)
        else:
            t = (f - ref_frame) / 20.0
            cameras.append(_panning_camera(t))

    video = tmp_path / "pan_zoom_cut.mp4"
    write_synthetic_video(video, cameras)

    ref_cam = cameras[ref_frame]
    assert ref_cam is not None
    cal = Calibration(CameraView.SIDELINE, 0, ref_frame, ref_cam.placed(ref_frame))
    seg = PlaySegment(0, 39, CameraView.SIDELINE)
    base = assess(cal).homography
    assert base is not None

    span = calibration_spans([seg], [cal])[0]
    span_motion = track_span(video, span, base, keyframe_stride=5)
    mapping = CourtMapping([seg], [cal], camera_motion=CameraMotion([span_motion]))

    # Live play frames (including far ends of pan/zoom and recovery after cut) stay < 0.5 ft.
    for f in [0, 6, 12, 18, 24, 34, 39]:
        cam = cameras[f]
        assert cam is not None
        h = mapping.at(f)
        assert h is not None, f"Expected frame {f} to be mapped"
        for x, y in [(0.0, -7.0), (0.0, 7.0), (10.0, -7.0), (10.0, 7.0), (-5.0, 0.0)]:
            if cam.in_frame(x, y):
                pt = h.to_court(cam.image(x, y))
                assert pt is not None
                err = math.hypot(pt.x - x, pt.y - y)
                assert err < ERROR_WARNING_FT, f"frame {f} ({x},{y}) error {err:.3f} ft"

    # Cut frames map to nothing (Unknown) and show up as the exact unmapped range.
    for f in range(25, 32):
        assert mapping.at(f) is None, f"Cut frame {f} should be unmapped"
    assert span_motion.unmapped_ranges() == [FrameRange(25, 31, CameraView.SIDELINE)]


@pytest.mark.parametrize(
    ("start", "mapped_flags", "expected"),
    [
        (10, [True, True, True], []),
        (10, [False, False, True, True], [(10, 11)]),
        (10, [True, True, False, False], [(12, 13)]),
        (10, [True, False, True], [(11, 11)]),
        (10, [False, False, False], [(10, 12)]),
        (100, [False, True, False, False, True, False], [(100, 100), (102, 103), (105, 105)]),
    ],
    ids=["all-mapped", "at-start", "at-end", "single-frame", "all-unmapped", "multiple"],
)
def test_span_motion_unmapped_ranges_edge_cases(
    start: int, mapped_flags: list[bool], expected: list[tuple[int, int]]
) -> None:
    n = len(mapped_flags)
    span = SpanMotion(
        start_frame=start,
        end_frame=start + n - 1,
        camera_view=CameraView.SIDELINE,
        calibration_effective_from=start,
        calibration_reference_frame=start,
        mapped=np.array(mapped_flags, dtype=bool),
        matrices=np.broadcast_to(np.eye(3, dtype=np.float64), (n, 3, 3)).copy(),
        line_error_ft=np.full(n, np.nan, dtype=np.float32),
    )

    assert span.unmapped_ranges() == [FrameRange(s, e, CameraView.SIDELINE) for s, e in expected]


def test_tracks_segment_whose_reference_frame_is_in_an_earlier_segment(tmp_path: Path) -> None:
    cameras: list[Camera | None] = [_panning_camera((f - 2) / 30.0) for f in range(25)]
    video = tmp_path / "two_segments.mp4"
    write_synthetic_video(video, cameras)

    ref_cam = cameras[2]
    assert ref_cam is not None
    cal = Calibration(CameraView.SIDELINE, 0, 2, ref_cam.placed(2))
    seg2 = PlaySegment(12, 24, CameraView.SIDELINE)
    base = assess(cal).homography
    assert base is not None

    span = calibration_spans([seg2], [cal])[0]
    span_motion = track_span(video, span, base, keyframe_stride=4)

    assert span_motion.unmapped_count == 0
    mapping = CourtMapping([seg2], [cal], camera_motion=CameraMotion([span_motion]))
    h_end = mapping.at(24)
    cam_end = cameras[24]
    assert h_end is not None and cam_end is not None
    assert_near(h_end.to_court(cam_end.image(0.0, 7.0)), CourtPoint(0.0, 7.0), ERROR_WARNING_FT)


def test_far_kitchen_line_stays_on_paint_beside_a_kitchen_logo_clicked_by_mistake(
    tmp_path: Path,
) -> None:
    # A sponsor logo in the far kitchen has a straight white edge 1 ft short of the far kitchen
    # line, and the far kitchen Landmarks were clicked on that edge instead of the line.
    cameras: list[Camera | None] = [_panning_camera((f - 12) / 20.0) for f in range(25)]
    video = tmp_path / "kitchen_logo.mp4"
    write_synthetic_video(video, cameras, kitchen_logo=True)

    ref_cam = cameras[12]
    assert ref_cam is not None
    placed = ref_cam.placed(12)
    for lm in (Landmark.FAR_KITCHEN_LEFT, Landmark.FAR_KITCHEN_CENTRE, Landmark.FAR_KITCHEN_RIGHT):
        x = lm.court_point.x
        if ref_cam.in_frame(x, 6.0):
            placed[lm] = PlacedLandmark.at(ref_cam.image(x, 6.0), 12)
    cal = Calibration(CameraView.SIDELINE, 0, 12, placed)
    seg = PlaySegment(0, 24, CameraView.SIDELINE)
    base = assess(cal).homography
    assert base is not None

    span_motion = track_span(video, calibration_spans([seg], [cal])[0], base, keyframe_stride=5)
    mapping = CourtMapping([seg], [cal], camera_motion=CameraMotion([span_motion]))

    for f in [0, 6, 12, 18, 24]:
        cam = cameras[f]
        assert cam is not None
        h = mapping.at(f)
        assert h is not None, f"Expected frame {f} to be mapped"
        for x in (-5.0, 0.0, 5.0):
            if cam.in_frame(x, 7.0):
                pt = h.to_court(cam.image(x, 7.0))
                assert pt is not None
                err = math.hypot(pt.x - x, pt.y - 7.0)
                assert err < ERROR_WARNING_FT / 2, (
                    f"frame {f} far kitchen x={x} off by {err:.2f} ft"
                )


def test_tracks_through_a_distorting_lens_within_a_quarter_foot(tmp_path: Path) -> None:
    # Broadcast lenses bow court lines near the frame edges; a single homography fitted to the
    # middle of the frame is feet off at the baselines. Camera Motion estimates the lens and the
    # mapping carries it, so positions near the frame edges hold too.
    k1 = 0.08
    cameras: list[Camera | None] = [_panning_camera((f - 12) / 20.0) for f in range(25)]
    video = tmp_path / "lens.mp4"
    write_synthetic_video(video, cameras, lens_k1=k1)

    ref_cam = cameras[12]
    assert ref_cam is not None
    placed = {}
    for lm in Landmark:
        p = lm.court_point
        if ref_cam.in_frame(p.x, p.y):
            seen = _lens_image(ref_cam, p.x, p.y, k1)
            if 0 <= seen.x <= 1 and 0 <= seen.y <= 1:
                placed[lm] = PlacedLandmark.at(seen, 12)
    cal = Calibration(CameraView.SIDELINE, 0, 12, placed)
    seg = PlaySegment(0, 24, CameraView.SIDELINE)
    base = assess(cal).homography
    assert base is not None

    span = calibration_spans([seg], [cal])[0]
    span_motion = track_span(video, span, base, keyframe_stride=5)
    assert span_motion.lens is not None
    assert span_motion.lens.k1 == pytest.approx(k1, abs=0.02)
    assert span_motion.lens.aspect == pytest.approx(SYN_W / SYN_H)

    # The lens survives the cache.
    cache = CameraMotionCache(tmp_path / "cache")
    cache.put(video, span, base, span_motion)
    cached = cache.get(video, span, base)
    assert cached is not None and cached.lens == span_motion.lens

    mapping = CourtMapping([seg], [cal], camera_motion=CameraMotion([cached]))
    for f in [0, 6, 12, 18, 24]:
        cam = cameras[f]
        assert cam is not None
        h = mapping.at(f)
        assert h is not None, f"Expected frame {f} to be mapped"
        assert h.lens == span_motion.lens
        for x in (-8.0, 0.0, 8.0):
            for y in (-20.0, -7.0, 0.0, 7.0, 20.0):
                if cam.in_frame(x, y):
                    seen = _lens_image(cam, x, y, k1)
                    pt = h.to_court(seen)
                    assert pt is not None
                    err = math.hypot(pt.x - x, pt.y - y)
                    assert err < ERROR_WARNING_FT / 2, f"frame {f} ({x},{y}) off by {err:.2f} ft"
                    # And back: the court point lands where the bent frame shows it.
                    back = h.to_image(CourtPoint(x, y))
                    assert back is not None
                    px_off = math.hypot((back.x - seen.x) * SYN_W, (back.y - seen.y) * SYN_H)
                    assert px_off < 2.0, f"frame {f} ({x},{y}) drawn {px_off:.1f} px off"


# --- Multi-frame Landmark registration (Option 2) -----------------------------------------


def test_registers_multi_frame_landmarks_across_panning_video_and_rejects_cut_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 36 frames: smooth pan/zoom 0..30, hard cut 31..35.
    ref_frame = 10
    cameras: list[Camera | None] = [
        None if f >= 31 else _panning_camera((f - ref_frame) / 24.0) for f in range(36)
    ]
    video = tmp_path / "multi_frame.mp4"
    write_synthetic_video(video, cameras)

    cam_early = cameras[2]
    cam_ref = cameras[ref_frame]
    cam_late = cameras[22]
    assert cam_early is not None and cam_ref is not None and cam_late is not None

    # Split visible Landmarks across 3 different frames (fewer than 4 on reference frame alone!).
    early_lms = [Landmark.NEAR_KITCHEN_CENTRE, Landmark.NEAR_KITCHEN_RIGHT]
    ref_lms = [
        Landmark.FAR_KITCHEN_CENTRE,
        Landmark.FAR_KITCHEN_RIGHT,
        Landmark.FAR_BASELINE_CENTRE,
    ]
    late_lms = [Landmark.NEAR_BASELINE_RIGHT, Landmark.FAR_BASELINE_RIGHT]
    landmarks = {
        **cam_early.placed(2, early_lms),
        **cam_ref.placed(ref_frame, ref_lms),
        **cam_late.placed(22, late_lms),
    }
    seg = PlaySegment(0, 35, CameraView.SIDELINE)
    cal = Calibration(CameraView.SIDELINE, 0, ref_frame, landmarks)
    cache = CameraMotionCache(tmp_path / "cache")

    # Without video registration, reference frame only has 3 points -> incomplete.
    assert not assess(cal).complete

    # With registration, off-reference frames map to reference_frame and fit within 0.5 ft.
    f2r = cache.register_calibration_frames(video, cal, [seg])
    assert 2 in f2r and 22 in f2r
    fit = assess(cal, frame_to_ref=f2r)
    assert fit.complete
    assert fit.unmapped_landmarks == frozenset()
    assert fit.worst_error_ft is not None and fit.worst_error_ft < ERROR_WARNING_FT

    # Full CameraMotion + CourtMapping tracks accurately from the multi-frame Calibration.
    motion = cache.track_match(video, [seg], [cal])
    reg_map = cache.landmark_frame_to_ref(video, [seg], [cal])
    mapping = CourtMapping([seg], [cal], camera_motion=motion, landmark_frame_to_ref=reg_map)
    for f in [2, ref_frame, 22]:
        cam = cameras[f]
        assert cam is not None
        h = mapping.at(f)
        assert h is not None
        assert_near(h.to_court(cam.image(0.0, 7.0)), CourtPoint(0.0, 7.0), ERROR_WARNING_FT)

    # Second registration call serves from disk cache without invoking OpenCV again.
    def fail_register(*_args: object, **_kwargs: object) -> dict[int, np.ndarray | None]:
        raise AssertionError("register_frames_to_reference should not run on a cache hit")

    monkeypatch.setattr("pb_tokei.camera_motion.register_frames_to_reference", fail_register)
    f2r_cached = cache.register_calibration_frames(video, cal, [seg])
    assert set(f2r_cached) == {2, 22}

    # A Landmark clicked on a hard-cut frame (33) fails registration and is excluded (unmapped).
    monkeypatch.undo()
    with_cut = Calibration(
        CameraView.SIDELINE,
        0,
        ref_frame,
        {**landmarks, Landmark.NEAR_BASELINE_CENTRE: PlacedLandmark(0.5, 0.5, 33)},
    )
    f2r_cut = cache.register_calibration_frames(video, with_cut, [seg])
    assert 33 not in f2r_cut
    fit_cut = assess(with_cut, frame_to_ref=f2r_cut)
    assert fit_cut.complete
    assert fit_cut.unmapped_landmarks == frozenset({Landmark.NEAR_BASELINE_CENTRE})
    assert fit_cut.needs_attention


def test_transient_open_failure_and_out_of_bounds_frames_are_not_cached_as_unmapped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cameras: list[Camera | None] = [_panning_camera((f - 5) / 20.0) for f in range(12)]
    video = tmp_path / "transient.mp4"
    write_synthetic_video(video, cameras)

    cam_ref = cameras[5]
    cam_off = cameras[9]
    assert cam_ref is not None and cam_off is not None
    cal = Calibration(
        CameraView.SIDELINE,
        0,
        5,
        {
            **cam_ref.placed(5, [Landmark.NEAR_KITCHEN_CENTRE, Landmark.NEAR_KITCHEN_RIGHT]),
            **cam_off.placed(9, [Landmark.FAR_KITCHEN_RIGHT]),
        },
    )
    seg = PlaySegment(0, 11, CameraView.SIDELINE)
    cache_dir = tmp_path / "cache"
    cache = CameraMotionCache(cache_dir)

    # Simulate a transient failure to open the video during registration.
    class _UnopenedCapture:
        def isOpened(self) -> bool:
            return False

        def release(self) -> None:
            pass

    monkeypatch.setattr(cv2, "VideoCapture", lambda *_a, **_kw: _UnopenedCapture())
    assert cache.register_calibration_frames(video, cal, [seg]) == {}
    assert list(cache_dir.glob("reg_*.npz")) == []

    # Once VideoCapture works again, the retry succeeds instead of hitting a stale negative cache.
    monkeypatch.undo()
    f2r = cache.register_calibration_frames(video, cal, [seg])
    assert 9 in f2r
    assert len(list(cache_dir.glob("reg_*.npz"))) == 1

    # Out-of-bounds Landmark frame (>= video frame count) is skipped without writing a cache file.
    oob = Calibration(
        CameraView.SIDELINE,
        0,
        5,
        {**cal.landmarks, Landmark.FAR_BASELINE_RIGHT: PlacedLandmark(0.5, 0.5, 9999)},
    )
    f2r_oob = cache.register_calibration_frames(video, oob, [seg])
    assert 9 in f2r_oob and 9999 not in f2r_oob
    assert len(list(cache_dir.glob("reg_*.npz"))) == 1


# --- Cache invalidation & persistence -----------------------------------------------------


def test_camera_motion_cache_hits_and_invalidates_on_edits_or_version_bump(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cameras: list[Camera | None] = [_panning_camera((f - 5) / 25.0) for f in range(12)]
    video = tmp_path / "cached.mp4"
    write_synthetic_video(video, cameras)

    ref_cam = cameras[5]
    assert ref_cam is not None
    cal = Calibration(CameraView.SIDELINE, 0, 5, ref_cam.placed(5))
    seg = PlaySegment(0, 11, CameraView.SIDELINE)
    cache = CameraMotionCache(tmp_path / "cache")

    first = cache.track_match(video, [seg], [cal])
    assert len(first.spans) == 1
    assert first.spans[0].mapped_count == 12

    # Second call must serve from cache without invoking track_span.
    def fail_track(*_args: object, **_kwargs: object) -> SpanMotion:
        raise AssertionError("track_span should not run on a cache hit")

    monkeypatch.setattr("pb_tokei.camera_motion.track_span", fail_track)
    second = cache.track_match(video, [seg], [cal])
    assert np.allclose(first.spans[0].matrices, second.spans[0].matrices)

    # Key changes when a Landmark moves, its frame changes, segment bounds change, or version bumps.
    span = calibration_spans([seg], [cal])[0]
    edited_landmarks = dict(cal.landmarks)
    lm = next(iter(edited_landmarks))
    edited_landmarks[lm] = PlacedLandmark(
        min(1.0, edited_landmarks[lm].x + 0.01), edited_landmarks[lm].y, edited_landmarks[lm].frame
    )
    cal_moved = Calibration(CameraView.SIDELINE, 0, 5, edited_landmarks)
    reframed_landmarks = dict(cal.landmarks)
    reframed_landmarks[lm] = PlacedLandmark(reframed_landmarks[lm].x, reframed_landmarks[lm].y, 6)
    cal_reframed = Calibration(CameraView.SIDELINE, 0, 5, reframed_landmarks)
    span_moved = calibration_spans([seg], [cal_moved])[0]
    span_reframed = calibration_spans([seg], [cal_reframed])[0]
    span_shorter = calibration_spans([PlaySegment(0, 10, CameraView.SIDELINE)], [cal])[0]

    base = assess(cal).homography
    assert base is not None
    k_base = span_cache_key(video, span, base, method_version=METHOD_VERSION)
    assert span_cache_key(video, span_moved, base, method_version=METHOD_VERSION) != k_base
    assert span_cache_key(video, span_reframed, base, method_version=METHOD_VERSION) != k_base
    assert span_cache_key(video, span_shorter, base, method_version=METHOD_VERSION) != k_base
    bumped = METHOD_VERSION + 1
    assert span_cache_key(video, span, base, method_version=bumped) != k_base
    assert (
        CameraMotionCache(tmp_path / "cache", method_version=bumped).get(video, span, base) is None
    )


def test_split_at_calibration_boundary_invalidates_motion_if_the_resolved_fit_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    video = tmp_path / "cached.mp4"
    video.touch()
    monkeypatch.setattr("pb_tokei.camera_motion.video_frame_count", lambda _video: 20)
    original = [PlaySegment(0, 19, CameraView.MAIN)]
    halves = [PlaySegment(0, 9, CameraView.MAIN), PlaySegment(10, 19, CameraView.MAIN)]
    placed = MAIN.placed(0)
    landmark = next(iter(placed))
    placed[landmark] = PlacedLandmark.at(placed[landmark].point, 12)
    calibrations = [
        Calibration(CameraView.MAIN, 0, 0, placed),
        Calibration(CameraView.MAIN, 10, 10, MAIN.placed(10)),
    ]

    def register(
        _video: Path, _reference: int, frames: Sequence[int], *, chain_frames: Set[int], **_kwargs
    ) -> dict[int, np.ndarray]:
        matrix = np.eye(3)
        if 12 not in chain_frames:
            matrix[0, 2] = 0.02
        return dict.fromkeys(frames, matrix)

    monkeypatch.setattr("pb_tokei.camera_motion.register_frames_to_reference", register)
    cache = CameraMotionCache(tmp_path / "cache")
    _, before = cache.load_cached(video, original, calibrations)
    assert [span for span, _base in before] == calibration_spans(halves, calibrations)
    for span, base in before:
        cache.put(
            video,
            span,
            base,
            SpanMotion(
                span.start_frame,
                span.end_frame,
                span.camera_view,
                span.calibration.effective_from_frame,
                span.calibration.reference_frame,
                np.ones(span.frame_count, dtype=bool),
                np.tile(np.eye(3), (span.frame_count, 1, 1)),
                np.zeros(span.frame_count, dtype=np.float32),
            ),
        )

    motion, missing = cache.load_cached(video, halves, calibrations)
    assert [(span.start_frame, span.end_frame) for span in motion.spans] == [(10, 19)]
    assert [span for span, _base in missing] == [before[0][0]]
    assert not np.allclose(missing[0][1].court_to_image, before[0][1].court_to_image)
    restored, missing = cache.load_cached(video, original, calibrations)
    assert len(restored.spans) == 2
    assert not missing
