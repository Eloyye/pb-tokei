"""Offline tests for Player Tracking geometry, filtering, identity propagation, Settled,
two-layer caching, device selection, HTTP API, and `pb-tokei track` CLI."""

from __future__ import annotations

import threading
from collections.abc import Sequence
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from test_calibration import MAIN, SIDELINE

from pb_tokei import main
from pb_tokei.annotate.app import create_app
from pb_tokei.calibration import CourtMapping, Homography, Lens, fit_landmarks
from pb_tokei.camera_motion import CalibrationSpan, CameraMotion, SpanMotion
from pb_tokei.player_tracking import (
    METHOD_VERSION,
    PlayerTrackingCache,
    SegmentDetections,
    positions_at,
    sample_frames_for_segment,
    solve_match_tracking,
)
from pb_tokei.player_vision import (
    APPEARANCE_DIM,
    DeviceKind,
    PlayerTrackingError,
    RawDetection,
    extract_appearance_embedding,
    select_device,
)
from pb_tokei.rally_log import (
    UNKNOWN,
    AnchorKind,
    Calibration,
    CameraView,
    Certainty,
    CourtPoint,
    Handedness,
    MatchId,
    MatchRoster,
    Player,
    PlayerAnchor,
    PlayerId,
    PlaySegment,
    RallyLog,
    SourceVideo,
    Team,
    TeamEnd,
    TeamId,
    Tour,
    Tournament,
    TournamentId,
    Zone,
    inferred,
    new_id,
    observed,
)

LOCAL = "http://127.0.0.1"


def _make_roster() -> tuple[Tournament, Team, Team, MatchRoster]:
    tournament = Tournament(TournamentId(new_id()), "Test Open", Tour.PPA)
    p_a1 = Player(PlayerId(new_id()), "Alice One", Handedness.RIGHT)
    p_a2 = Player(PlayerId(new_id()), "Bob Two", Handedness.RIGHT)
    p_b1 = Player(PlayerId(new_id()), "Cara Three", Handedness.LEFT)
    p_b2 = Player(PlayerId(new_id()), "Dan Four", Handedness.RIGHT)
    team_a = Team(TeamId(new_id()), (p_a1.id, p_a2.id))
    team_b = Team(TeamId(new_id()), (p_b1.id, p_b2.id))
    roster = MatchRoster(
        match_id=MatchId(new_id()),
        team_a_id=team_a.id,
        team_b_id=team_b.id,
        team_a_players=(p_a1, p_a2),
        team_b_players=(p_b1, p_b2),
    )
    return tournament, team_a, team_b, roster


def _unit_emb(index: int) -> np.ndarray:
    """Orthogonal unit vector in APPEARANCE_DIM so distinct kits have distance 1.0."""
    vec = np.zeros(APPEARANCE_DIM, dtype=np.float32)
    vec[index % APPEARANCE_DIM] = 1.0
    return vec


def _det_at_court(
    homography: Homography,
    x_ft: float,
    y_ft: float,
    *,
    emb: np.ndarray | None = None,
    box_w: float = 0.06,
    box_h: float = 0.20,
    ankles_visible: bool = True,
    force_bottom_y: float | None = None,
    score: float = 0.92,
) -> RawDetection:
    img = homography.to_image(CourtPoint(x_ft, y_ft))
    assert img is not None, f"Point ({x_ft}, {y_ft}) behind camera"
    fx, fy = img.x, img.y
    y2 = force_bottom_y if force_bottom_y is not None else min(1.0, fy + 0.005)
    y1 = max(0.0, y2 - box_h)
    x1 = max(0.0, fx - box_w * 0.5)
    x2 = min(1.0, fx + box_w * 0.5)
    if ankles_visible:
        la = (max(0.0, fx - 0.008), fy, 0.90)
        ra = (min(1.0, fx + 0.008), fy, 0.88)
    else:
        la = (fx, fy, 0.05)
        ra = (fx, fy, 0.04)
    return RawDetection(
        x1=x1,
        y1=y1,
        x2=x2,
        y2=y2,
        score=score,
        left_ankle=la,
        right_ankle=ra,
        appearance=emb if emb is not None else np.zeros(APPEARANCE_DIM, dtype=np.float32),
    )


def _write_dummy_video(path: Path, n_frames: int = 30, w: int = 160, h: int = 90) -> None:
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter.fourcc(*"mp4v"), 60.0, (w, h))
    assert writer.isOpened()
    try:
        for i in range(n_frames):
            frame = np.full((h, w, 3), (40 + i % 20, 90, 140), dtype=np.uint8)
            writer.write(frame)
    finally:
        writer.release()


class _FakeVisionBackend:
    """Fast deterministic VisionBackend for offline CI tests."""

    def __init__(
        self,
        detections_per_call: Sequence[tuple[RawDetection, ...]] | None = None,
        *,
        device: DeviceKind = DeviceKind.CPU,
        detector_model: str = "fake-detector",
        pose_model: str = "fake-pose",
    ) -> None:
        self.device = device
        self.detector_model = detector_model
        self.pose_model = pose_model
        self._detections = detections_per_call
        self.calls = 0

    def detect_batch(self, frames_bgr: Sequence[np.ndarray]) -> list[tuple[RawDetection, ...]]:
        self.calls += len(frames_bgr)
        if self._detections is not None:
            return [
                self._detections[min(i, len(self._detections) - 1)] for i in range(len(frames_bgr))
            ]
        return [() for _ in frames_bgr]


# --- Geometry, lens distortion, and non-player filtering ----------------------------------


def test_court_projection_honors_adr_0011_lens_distortion() -> None:
    _, _, _, roster = _make_roster()
    a1 = roster.team_a_players[0].id
    base = fit_landmarks(SIDELINE.clicks())
    assert base is not None
    lens = Lens(k1=0.09, aspect=16.0 / 9.0)
    distorted_h = base.compose(np.eye(3, dtype=np.float64), lens=lens)
    assert distorted_h is not None

    seg = PlaySegment(0, 8, CameraView.SIDELINE)
    cal = Calibration(CameraView.SIDELINE, 0, 0, SIDELINE.placed(0))
    span = SpanMotion(
        0,
        8,
        CameraView.SIDELINE,
        0,
        0,
        np.ones(9, dtype=bool),
        np.broadcast_to(np.eye(3, dtype=np.float64), (9, 3, 3)).copy(),
        np.zeros(9, dtype=np.float32),
        lens=lens,
    )
    mapping = CourtMapping([seg], [cal], camera_motion=CameraMotion([span]))

    # Place a Player near the far corner where barrel distortion bends lines most.
    target = CourtPoint(8.5, 19.5)
    # Use the lens-aware homography to compute where their ankles appear in the bowed frame.
    samples = sample_frames_for_segment(0, 8, stride=4)
    dets = {f: (_det_at_court(distorted_h, target.x, target.y, emb=_unit_emb(0)),) for f in samples}
    img_click = distorted_h.to_image(target)
    assert img_click is not None
    anchor = PlayerAnchor(0, a1, AnchorKind.IDENTITY, img_click.x, max(0.0, img_click.y - 0.05))

    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={(0, 8): SegmentDetections(0, 8, 4, "d", "p", samples, dets)},
        court_mapping=mapping,
        player_anchors=[anchor],
    )
    pos = positions_at(tracking, 0)[a1].position
    assert pos.certainty is Certainty.OBSERVED
    assert pos.value is not None
    assert pos.value.x == pytest.approx(target.x, abs=0.15)
    assert pos.value.y == pytest.approx(target.y, abs=0.15)


def test_filters_referees_and_spectators_but_keeps_ernes_and_operator_overrides() -> None:
    _, _, _, roster = _make_roster()
    a1, a2 = roster.team_a_players[0].id, roster.team_a_players[1].id
    h = fit_landmarks(MAIN.clicks())
    assert h is not None
    seg = PlaySegment(0, 20, CameraView.MAIN)
    cal = Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))
    mapping = CourtMapping([seg], [cal])
    samples = sample_frames_for_segment(0, 20, stride=4)

    dets: dict[int, tuple[RawDetection, ...]] = {}
    erne_xs = {0: -8.0, 4: -9.0, 8: -10.5, 12: -11.5, 16: -13.0, 20: -13.0}
    for f in samples:
        # Player A1 starts inside court (-8, -6.5) and steps smoothly outside sideline for an Erne.
        erne_x = erne_xs[f]
        # Stationary referee at net post (-12.5, 0) never enters |x| <= 10.5.
        # Spectator behind far baseline (0, 28) is visible in frame and never enters |y| <= 24.
        # Out-of-ROI person at (14.0, -10.0) targeted explicitly by operator anchor for A2.
        dets[f] = (
            _det_at_court(h, erne_x, -6.5, emb=_unit_emb(0)),
            _det_at_court(h, -12.5, 0.0, emb=_unit_emb(5)),
            _det_at_court(h, 0.0, 28.0, emb=_unit_emb(6)),
            _det_at_court(h, 14.0, -10.0, emb=_unit_emb(1)),
        )

    img_a1 = h.to_image(CourtPoint(-8.0, -6.5))
    img_a2 = h.to_image(CourtPoint(14.0, -10.0))
    assert img_a1 is not None and img_a2 is not None
    anchors = [
        PlayerAnchor(0, a1, AnchorKind.IDENTITY, img_a1.x, max(0.0, img_a1.y - 0.05)),
        PlayerAnchor(0, a2, AnchorKind.IDENTITY, img_a2.x, max(0.0, img_a2.y - 0.05)),
    ]

    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={(0, 20): SegmentDetections(0, 20, 4, "d", "p", samples, dets)},
        court_mapping=mapping,
        player_anchors=anchors,
    )

    # Erne step outside sideline is kept because tracklet entered court lines earlier!
    st_erne = positions_at(tracking, 16)[a1]
    assert st_erne.position.certainty is Certainty.OBSERVED
    assert st_erne.position.value is not None
    assert st_erne.position.value.x == pytest.approx(-13.0, abs=0.2)

    # Operator anchor overrides non-player filtering for A2 at x = 14 ft!
    st_override = positions_at(tracking, 16)[a2]
    assert st_override.position.certainty is Certainty.OBSERVED
    assert st_override.position.value is not None
    assert st_override.position.value.x == pytest.approx(14.0, abs=0.2)

    # Referee and spectator were filtered out from kept detections on frame 16.
    kept = tracking.detections_at(16)
    assert len(kept) == 2


# --- Occlusions, cropped feet, unmapped frames, and Certainty -----------------------------


def test_occlusion_cropped_feet_unmapped_and_unanchored_certainty_rules() -> None:
    _, _, _, roster = _make_roster()
    a1, a2 = roster.team_a_players[0].id, roster.team_a_players[1].id
    h = fit_landmarks(MAIN.clicks())
    assert h is not None

    seg = PlaySegment(0, 100, CameraView.MAIN)
    cal = Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))
    # Mark frames 92..96 as unmapped Camera Motion.
    mapped = np.ones(101, dtype=bool)
    mapped[92:97] = False
    span = SpanMotion(
        0,
        100,
        CameraView.MAIN,
        0,
        0,
        mapped,
        np.broadcast_to(np.eye(3, dtype=np.float64), (101, 3, 3)).copy(),
        np.zeros(101, dtype=np.float32),
    )
    mapping = CourtMapping([seg], [cal], camera_motion=CameraMotion([span]))
    samples = sample_frames_for_segment(0, 100, stride=4)

    dets: dict[int, tuple[RawDetection, ...]] = {}
    for f in samples:
        frame_list: list[RawDetection] = []
        # A1 present on 0..8, occluded 12..24 (gap 20 <= 30 -> Inferred),
        # present 28..32, occluded 36..68 (gap 40 > 30 -> Unknown),
        # present 72..80, bottom-cropped ankles-invisible on 84, present 88..100.
        if f in (0, 4, 8, 28, 32, 72, 76, 80, 88, 92, 96, 100):
            frame_list.append(_det_at_court(h, -3.0, -12.0, emb=_unit_emb(0)))
        elif f == 84:
            frame_list.append(
                _det_at_court(
                    h,
                    -3.0,
                    -12.0,
                    emb=_unit_emb(0),
                    ankles_visible=False,
                    force_bottom_y=0.995,
                )
            )
        # Unanchored Player A2 walks in court too, should stay Unknown.
        frame_list.append(_det_at_court(h, 4.0, -14.0, emb=_unit_emb(1)))
        dets[f] = tuple(frame_list)

    img_a1 = h.to_image(CourtPoint(-3.0, -12.0))
    assert img_a1 is not None
    anchors = [PlayerAnchor(0, a1, AnchorKind.IDENTITY, img_a1.x, max(0.0, img_a1.y - 0.05))]

    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={(0, 100): SegmentDetections(0, 100, 4, "d", "p", samples, dets)},
        court_mapping=mapping,
        player_anchors=anchors,
    )

    # Normal stride interpolation (frame 2 between 0 and 4) -> Observed.
    assert positions_at(tracking, 2)[a1].position.certainty is Certainty.OBSERVED
    # Brief mid-track occlusion (frame 18 between 8 and 28, gap=20 <= 30) -> Inferred.
    assert positions_at(tracking, 18)[a1].position.certainty is Certainty.INFERRED
    # Longer occlusion (frame 50 between 32 and 72, gap=40 > 30) -> Unknown.
    assert positions_at(tracking, 50)[a1].position is UNKNOWN
    # Cropped feet on frame 84 (between 80 and 88, gap=8 <= 30) -> frame 84 itself was excluded
    # from direct observations, so frame 84 is NOT Observed (interpolated across 80..88 as Inferred,
    # or Unknown when not bounded within 30 frames). Test unbounded cropped feet below too!
    assert positions_at(tracking, 84)[a1].position.certainty is not Certainty.OBSERVED
    # Unmapped Camera Motion frame 94 -> Unknown.
    assert positions_at(tracking, 94)[a1].position is UNKNOWN
    # Unanchored Player A2 -> Unknown.
    assert positions_at(tracking, 4)[a2].position is UNKNOWN
    # Outside Play Segment -> Unknown.
    assert positions_at(tracking, 500)[a1].position is UNKNOWN


def test_cropped_feet_at_segment_end_yields_unknown() -> None:
    _, _, _, roster = _make_roster()
    a1 = roster.team_a_players[0].id
    h = fit_landmarks(MAIN.clicks())
    assert h is not None
    seg = PlaySegment(0, 8, CameraView.MAIN)
    cal = Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))
    mapping = CourtMapping([seg], [cal])
    samples = sample_frames_for_segment(0, 8, stride=4)
    dets = {
        0: (_det_at_court(h, -2.0, -18.0, emb=_unit_emb(0)),),
        4: (_det_at_court(h, -2.0, -20.0, emb=_unit_emb(0)),),
        8: (
            _det_at_court(
                h, -2.0, -22.0, emb=_unit_emb(0), ankles_visible=False, force_bottom_y=0.995
            ),
        ),
    }
    img = h.to_image(CourtPoint(-2.0, -18.0))
    assert img is not None
    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={(0, 8): SegmentDetections(0, 8, 4, "d", "p", samples, dets)},
        court_mapping=mapping,
        player_anchors=[PlayerAnchor(0, a1, AnchorKind.IDENTITY, img.x, max(0.0, img.y - 0.05))],
    )
    assert positions_at(tracking, 4)[a1].position.certainty is Certainty.OBSERVED
    assert positions_at(tracking, 8)[a1].position is UNKNOWN


# --- Cross-cut transfer, replay-gap propagation, team_ends, and piecewise anchors ---------


def test_live_cross_cut_and_replay_gap_and_team_end_flip() -> None:
    _, team_a, team_b, roster = _make_roster()
    a1, a2 = roster.team_a_players[0].id, roster.team_a_players[1].id
    b1, b2 = roster.team_b_players[0].id, roster.team_b_players[1].id
    h_main = fit_landmarks(MAIN.clicks())
    h_side = fit_landmarks(SIDELINE.clicks())
    assert h_main is not None and h_side is not None

    # Seg 1: Main [0, 40], Replay gap [41..299], Seg 2: Main [300, 340], 0-frame live cut ->
    # Seg 3: Sideline [341, 381], Replay gap + end swap -> Seg 4: Main [500, 520].
    segs = [
        PlaySegment(0, 40, CameraView.MAIN),
        PlaySegment(300, 340, CameraView.MAIN),
        PlaySegment(341, 381, CameraView.SIDELINE),
        PlaySegment(500, 520, CameraView.MAIN),
    ]
    cals = [
        Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0)),
        Calibration(CameraView.SIDELINE, 341, 341, SIDELINE.placed(341)),
    ]
    mapping = CourtMapping(segs, cals)

    # Distinct kits so appearance matching identifies partners cleanly even when stacked!
    embs = {a1: _unit_emb(0), a2: _unit_emb(1), b1: _unit_emb(2), b2: _unit_emb(3)}

    # Seg 1: Team A near (y < 0), Team B far (y > 0).
    s1_pos = {a1: (-5.0, -8.0), a2: (5.0, -8.0), b1: (-4.0, 8.0), b2: (4.0, 8.0)}
    # Seg 2 (after replay gap): Team A stacked (swapped left/right x!), still near.
    s2_pos = {a1: (6.0, -10.0), a2: (-4.0, -10.0), b1: (5.0, 9.0), b2: (-5.0, 9.0)}
    # Seg 3 (0-frame live Main -> Sideline cut at 340 -> 341): same court (x, y) coordinates!
    s3_pos = {a1: (6.1, -9.9), a2: (-4.1, -10.1), b1: (4.9, 9.1), b2: (-5.1, 8.9)}
    # Seg 4 (after TeamEnd swap at 500): Team B is now near (y < 0), Team A is far (y > 0)!
    s4_pos = {b1: (-5.0, -9.0), b2: (5.0, -9.0), a1: (-5.0, 9.0), a2: (5.0, 9.0)}

    l1: dict[tuple[int, int], SegmentDetections] = {}
    for seg, h_view, pos_map in (
        (segs[0], h_main, s1_pos),
        (segs[1], h_main, s2_pos),
        (segs[2], h_side, s3_pos),
        (segs[3], h_main, s4_pos),
    ):
        samples = sample_frames_for_segment(seg.start_frame, seg.end_frame, stride=4)
        dets = {
            f: tuple(
                _det_at_court(h_view, xy[0], xy[1], emb=embs[pid]) for pid, xy in pos_map.items()
            )
            for f in samples
        }
        l1[(seg.start_frame, seg.end_frame)] = SegmentDetections(
            seg.start_frame, seg.end_frame, 4, "d", "p", samples, dets
        )

    # Anchor ALL 4 Players ONLY once on frame 20 inside Seg 1 (no team_ends -> seeds Team A near!).
    anchors: list[PlayerAnchor] = []
    for pid, (cx, cy) in s1_pos.items():
        img = h_main.to_image(CourtPoint(cx, cy))
        assert img is not None
        anchors.append(PlayerAnchor(20, pid, AnchorKind.IDENTITY, img.x, max(0.0, img.y - 0.05)))

    # Explicit end change at frame 500 puts Team B at near end.
    team_ends = [TeamEnd(0, team_a.id), TeamEnd(500, team_b.id)]

    tracking = solve_match_tracking(
        roster=roster,
        segments=segs,
        layer1_by_segment=l1,
        court_mapping=mapping,
        player_anchors=anchors,
        team_ends=team_ends,
    )

    # Backward propagation inside Seg 1 (frame 0 before anchor at frame 20):
    assert positions_at(tracking, 0)[a1].position.value == pytest.approx(
        CourtPoint(-5.0, -8.0), abs=0.2
    )
    # Replay gap to Seg 2 with stacked (swapped x) partners: appearance matching gets both right!
    st_s2 = positions_at(tracking, 320)
    p_s2_a1, p_s2_a2 = st_s2[a1].position.value, st_s2[a2].position.value
    assert p_s2_a1 is not None and p_s2_a1.x == pytest.approx(6.0, abs=0.2)
    assert p_s2_a2 is not None and p_s2_a2.x == pytest.approx(-4.0, abs=0.2)
    # 0-frame live Main -> Sideline cut (340 -> 341): court coordinates transfer identities!
    st_s3 = positions_at(tracking, 341)
    p_s3_a1, p_s3_b1 = st_s3[a1].position.value, st_s3[b1].position.value
    assert p_s3_a1 is not None and p_s3_a1.x == pytest.approx(6.1, abs=0.2)
    assert p_s3_b1 is not None and p_s3_b1.x == pytest.approx(4.9, abs=0.2)
    # Explicit TeamEnd swap at 500 puts Team B on y < 0 and Team A on y > 0!
    st_s4 = positions_at(tracking, 512)
    p_s4_b1, p_s4_a1 = st_s4[b1].position.value, st_s4[a1].position.value
    assert p_s4_b1 is not None and p_s4_b1.y < 0
    assert p_s4_a1 is not None and p_s4_a1.y > 0
    assert tracking.near_team_at(512) == team_b.id


def test_piecewise_anchor_override_and_manual_position_anchor() -> None:
    _, _, _, roster = _make_roster()
    a1, a2 = roster.team_a_players[0].id, roster.team_a_players[1].id
    h = fit_landmarks(MAIN.clicks())
    assert h is not None

    seg = PlaySegment(0, 40, CameraView.MAIN)
    cal = Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))
    mapping = CourtMapping([seg], [cal])
    samples = sample_frames_for_segment(0, 40, stride=4)

    # Two tracklets on near half: left (-5, -10) and right (+5, -10).
    dets = {
        f: (
            _det_at_court(h, -5.0, -10.0, emb=_unit_emb(0)),
            _det_at_court(h, 5.0, -10.0, emb=_unit_emb(1)),
        )
        for f in samples
    }
    img_l = h.to_image(CourtPoint(-5.0, -10.0))
    img_r = h.to_image(CourtPoint(5.0, -10.0))
    img_manual = h.to_image(CourtPoint(0.0, -15.0))
    assert img_l is not None and img_r is not None and img_manual is not None

    # Anchor at frame 8: A1=left, A2=right. Swap anchor at frame 24: A1=right, A2=left.
    # Manual `position` anchor for A1 on frame 36 at (0, -15) overrides directly without snapping!
    anchors = [
        PlayerAnchor(8, a1, AnchorKind.IDENTITY, img_l.x, max(0.0, img_l.y - 0.05)),
        PlayerAnchor(8, a2, AnchorKind.IDENTITY, img_r.x, max(0.0, img_r.y - 0.05)),
        PlayerAnchor(24, a1, AnchorKind.IDENTITY, img_r.x, max(0.0, img_r.y - 0.05)),
        PlayerAnchor(24, a2, AnchorKind.IDENTITY, img_l.x, max(0.0, img_l.y - 0.05)),
        PlayerAnchor(36, a1, AnchorKind.POSITION, img_manual.x, img_manual.y),
    ]

    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={(0, 40): SegmentDetections(0, 40, 4, "d", "p", samples, dets)},
        court_mapping=mapping,
        player_anchors=anchors,
    )

    # Earlier interval [0..20] keeps A1=left, A2=right (undisturbed by frame 24 swap!).
    p0_a1 = positions_at(tracking, 0)[a1].position.value
    p16_a1 = positions_at(tracking, 16)[a1].position.value
    assert p0_a1 is not None and p0_a1.x == pytest.approx(-5.0, abs=0.2)
    assert p16_a1 is not None and p16_a1.x == pytest.approx(-5.0, abs=0.2)
    # Later interval [24..32] swaps to A1=right, A2=left!
    p28_a1 = positions_at(tracking, 28)[a1].position.value
    p28_a2 = positions_at(tracking, 28)[a2].position.value
    assert p28_a1 is not None and p28_a1.x == pytest.approx(5.0, abs=0.2)
    assert p28_a2 is not None and p28_a2.x == pytest.approx(-5.0, abs=0.2)
    # Manual position anchor on frame 36 stays at (0, -15) without snapping back to +5!
    p36 = positions_at(tracking, 36)[a1]
    assert p36.position.certainty is Certainty.OBSERVED
    assert p36.position.value is not None
    assert p36.position.value.x == pytest.approx(0.0, abs=0.15)
    assert p36.position.value.y == pytest.approx(-15.0, abs=0.15)
    assert p36.anchor_kind is AnchorKind.POSITION


# --- Settled velocity rules ---------------------------------------------------------------


def test_settled_velocity_and_manual_anchor_rules() -> None:
    _, _, _, roster = _make_roster()
    a1, a2, b1, b2 = [p.id for p in roster.players]
    h = fit_landmarks(MAIN.clicks())
    assert h is not None

    seg = PlaySegment(0, 60, CameraView.MAIN)
    cal = Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))
    mapping = CourtMapping([seg], [cal])
    samples = sample_frames_for_segment(0, 60, stride=4)

    dets: dict[int, tuple[RawDetection, ...]] = {}
    for f in samples:
        t = f / 60.0
        # A1: moves laterally along kitchen line (|y| = 7.5 constant, x changing) -> Settled True!
        a1_xy = (-6.0 + 4.0 * t, -7.5)
        # A2: sprinting toward net from y=-12 to y=-6 at 6 ft/s (> 1.5 ft/s) -> Settled False!
        a2_xy = (3.0, -12.0 + 6.0 * t)
        # B1: stepping backward in Frontcourt (y from 7.0 to 8.5, v_toward < 0) -> Settled True!
        b1_xy = (-3.0, 7.0 + 1.5 * t)
        # B2: standing in Midcourt (y = 14.0 > 9.0) -> Settled False with position certainty!
        b2_xy = (4.0, 14.0)
        dets[f] = (
            _det_at_court(h, *a1_xy, emb=_unit_emb(0)),
            _det_at_court(h, *a2_xy, emb=_unit_emb(1)),
            _det_at_court(h, *b1_xy, emb=_unit_emb(2)),
            _det_at_court(h, *b2_xy, emb=_unit_emb(3)),
        )

    anchors = []
    for pid, xy in (
        (a1, (-6.0, -7.5)),
        (a2, (3.0, -12.0)),
        (b1, (-3.0, 7.0)),
        (b2, (4.0, 14.0)),
    ):
        img = h.to_image(CourtPoint(*xy))
        assert img is not None
        anchors.append(PlayerAnchor(0, pid, AnchorKind.IDENTITY, img.x, max(0.0, img.y - 0.05)))

    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={(0, 60): SegmentDetections(0, 60, 4, "d", "p", samples, dets)},
        court_mapping=mapping,
        player_anchors=anchors,
    )

    # Frame 40: t = 0.667 s -> A2 is at y = -8.0 (inside Frontcourt, moving toward net at 6 ft/s).
    st = positions_at(tracking, 40)
    assert st[a1].zone is Zone.FRONTCOURT
    assert st[a1].settled == observed(True)
    assert st[a2].zone is Zone.FRONTCOURT
    assert st[a2].settled == observed(False)
    assert st[b1].zone is Zone.FRONTCOURT
    assert st[b1].settled == observed(True)
    assert st[b2].zone is Zone.MIDCOURT
    assert st[b2].settled == observed(False)

    # Manual position anchor with NO detections:
    # - inside Frontcourt without surrounding track velocity -> Settled = Unknown
    # - outside Frontcourt -> Settled = Observed(False)
    img_fc = h.to_image(CourtPoint(0.0, -7.5))
    img_mc = h.to_image(CourtPoint(0.0, 14.0))
    assert img_fc is not None and img_mc is not None
    manual_only = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={},
        court_mapping=mapping,
        player_anchors=[
            PlayerAnchor(30, a1, AnchorKind.POSITION, img_fc.x, img_fc.y),
            PlayerAnchor(30, b2, AnchorKind.POSITION, img_mc.x, img_mc.y),
        ],
    )
    st_m = positions_at(manual_only, 30)
    assert st_m[a1].zone is Zone.FRONTCOURT
    assert st_m[a1].settled is UNKNOWN
    assert st_m[b2].zone is Zone.MIDCOURT
    assert st_m[b2].settled == observed(False)


# --- Two-layer cache, METHOD_VERSION rebuild, device selection, appearance ----------------


def test_two_layer_cache_reuses_layer1_on_anchor_and_calibration_edits(tmp_path: Path) -> None:
    _, _, _, roster = _make_roster()
    a1 = roster.team_a_players[0].id
    video = tmp_path / "match.60fps.mp4"
    _write_dummy_video(video, n_frames=16)

    h = fit_landmarks(MAIN.clicks())
    assert h is not None
    det = _det_at_court(h, -4.0, -10.0, emb=_unit_emb(0))
    backend = _FakeVisionBackend([(det,)])

    seg = PlaySegment(0, 12, CameraView.MAIN)
    cal = Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))
    mapping = CourtMapping([seg], [cal])
    cache = PlayerTrackingCache(
        tmp_path / "cache",
        detector_model=backend.detector_model,
        pose_model=backend.pose_model,
    )

    cache.track_match(video, roster, [seg], [cal], mapping, None, [], [], backend=backend)
    calls_after_first = backend.calls
    assert calls_after_first == len(sample_frames_for_segment(0, 12, 4))

    # Adding an anchor or tweaking a Calibration must NOT re-run Layer 1 GPU inference!
    img = h.to_image(CourtPoint(-4.0, -10.0))
    assert img is not None
    anchor = PlayerAnchor(0, a1, AnchorKind.IDENTITY, img.x, max(0.0, img.y - 0.05))
    tweaked_cal = Calibration(CameraView.MAIN, 0, 4, MAIN.placed(4))
    tracking = cache.track_match(
        video,
        roster,
        [seg],
        [tweaked_cal],
        CourtMapping([seg], [tweaked_cal]),
        None,
        [anchor],
        [],
        backend=backend,
    )
    assert backend.calls == calls_after_first
    assert positions_at(tracking, 4)[a1].position.certainty is Certainty.OBSERVED

    # Bumping METHOD_VERSION rebuilds Layer 1 while still honouring the saved anchor!
    v2_cache = PlayerTrackingCache(
        tmp_path / "cache",
        method_version=METHOD_VERSION + 1,
        detector_model=backend.detector_model,
        pose_model=backend.pose_model,
    )
    rebuilt = v2_cache.track_match(
        video, roster, [seg], [cal], mapping, None, [anchor], [], backend=backend
    )
    assert backend.calls == calls_after_first * 2
    assert positions_at(rebuilt, 4)[a1].position.certainty is Certainty.OBSERVED


def test_select_device_picks_cuda_mps_cpu_and_validates_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    assert select_device("auto") is DeviceKind.CUDA
    assert select_device("cpu") is DeviceKind.CPU

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    mps = getattr(torch.backends, "mps", None)
    if mps is not None:
        monkeypatch.setattr(mps, "is_available", lambda: True)
        assert select_device("auto") is DeviceKind.MPS
        assert select_device("mps") is DeviceKind.MPS
        monkeypatch.setattr(mps, "is_available", lambda: False)
    assert select_device("auto") is DeviceKind.CPU

    with pytest.raises(PlayerTrackingError, match="CUDA is not available"):
        select_device("cuda")
    if mps is not None:
        with pytest.raises(PlayerTrackingError, match="Apple MPS is not available"):
            select_device("mps")


def test_extract_appearance_embedding_distinguishes_kit_colours() -> None:
    red_frame = np.full((120, 120, 3), (20, 20, 220), dtype=np.uint8)
    blue_frame = np.full((120, 120, 3), (220, 40, 20), dtype=np.uint8)
    e_red_1 = extract_appearance_embedding(red_frame, 0.1, 0.1, 0.9, 0.9)
    e_red_2 = extract_appearance_embedding(red_frame, 0.12, 0.1, 0.88, 0.9)
    e_blue = extract_appearance_embedding(blue_frame, 0.1, 0.1, 0.9, 0.9)
    assert e_red_1.shape == (APPEARANCE_DIM,)
    assert float(np.dot(e_red_1, e_red_2)) > 0.98
    assert float(np.dot(e_red_1, e_blue)) < 0.7


# --- HTTP API and `pb-tokei track` CLI ----------------------------------------------------


def _setup_api_match(tmp_path: Path) -> tuple[Path, MatchId, MatchRoster, Path]:
    db = tmp_path / "log.duckdb"
    tournament, team_a, team_b, roster = _make_roster()
    (tmp_path / "footage").mkdir()
    orig = tmp_path / "footage" / "demo.webm"
    orig.write_bytes(b"orig")
    conv = tmp_path / "footage" / "demo.60fps.mp4"
    _write_dummy_video(conv, n_frames=40)

    with RallyLog.open(db) as log:
        log.save_tournament(tournament)
        for p in roster.players:
            log.save_player(p)
        log.save_team(team_a)
        log.save_team(team_b)
        from pb_tokei.rally_log import Match

        log.save_match(
            Match(
                id=roster.match_id,
                tournament_id=tournament.id,
                team_a_id=team_a.id,
                team_b_id=team_b.id,
                source_video=SourceVideo(
                    "https://example.com/v", "demo", Path("footage/demo.webm")
                ),
                play_segments=(
                    PlaySegment(0, 16, CameraView.MAIN),
                    PlaySegment(20, 36, CameraView.MAIN),
                ),
                calibrations=(Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0)),),
            )
        )
    return db, roster.match_id, roster, conv


def test_player_tracking_http_api_round_trip_priority_and_security(tmp_path: Path) -> None:
    db, match_id, roster, _conv = _setup_api_match(tmp_path)
    a1 = roster.team_a_players[0].id
    h = fit_landmarks(MAIN.clicks())
    assert h is not None
    det = _det_at_court(h, -4.0, -8.0, emb=_unit_emb(0))
    fake_backend = _FakeVisionBackend([(det,)], device=DeviceKind.MPS)

    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html>")

    app = create_app(
        db,
        static_dir=static,
        player_backend_factory=lambda _pref: fake_backend,
    )
    client = TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL})

    # MatchDetail includes roster IDs & Players for the UI.
    detail = client.get(f"/api/matches/{match_id}").json()
    assert detail["team_a_id"] == str(roster.team_a_id)
    assert len(detail["players"]) == 4

    # Cross-site mutating request blocked (403); stale X-Rally-Log blocked (409).
    bad_origin = client.put(
        f"/api/matches/{match_id}/player-anchors", json=[], headers={"Origin": "https://evil.test"}
    )
    assert bad_origin.status_code == 403
    wrong_log = client.get(
        f"/api/matches/{match_id}/player-tracking",
        headers={"X-Rally-Log": quote("/nonexistent/other.duckdb")},
    )
    assert wrong_log.status_code == 409

    # Anchor & TeamEnd PUT/GET + validation.
    img = h.to_image(CourtPoint(-4.0, -8.0))
    assert img is not None
    anchor_payload = [
        {
            "frame": 0,
            "player_id": str(a1),
            "kind": "identity",
            "image_x": img.x,
            "image_y": max(0.0, img.y - 0.05),
        }
    ]
    assert (
        client.put(f"/api/matches/{match_id}/player-anchors", json=anchor_payload).status_code
        == 200
    )
    assert client.get(f"/api/matches/{match_id}/player-anchors").json() == anchor_payload

    # Out-of-range frame is rejected with 422.
    bad_frame = [{**anchor_payload[0], "frame": 9999}]
    assert client.put(f"/api/matches/{match_id}/player-anchors", json=bad_frame).status_code == 422

    # Unknown Player UUID is rejected with 422.
    bad_player = [{**anchor_payload[0], "player_id": str(uuid4())}]
    assert client.put(f"/api/matches/{match_id}/player-anchors", json=bad_player).status_code == 422

    ends_payload = [{"effective_from_frame": 0, "near_team_id": str(roster.team_a_id)}]
    assert client.put(f"/api/matches/{match_id}/team-ends", json=ends_payload).status_code == 200
    assert client.get(f"/api/matches/{match_id}/team-ends").json() == ends_payload

    # Status starts idle (explicit trigger, not auto-started!).
    status0 = client.get(f"/api/matches/{match_id}/player-tracking").json()
    assert status0["status"] == "idle"
    assert status0["device"] == "mps"
    assert status0["tracked_segments"] == 0

    # Trigger tracking prioritising frame 24 (second segment first) and wait.
    tracked = client.post(
        f"/api/matches/{match_id}/player-tracking/track",
        json={"priority_frame": 24, "device": "auto", "wait": True},
    ).json()
    assert tracked["status"] == "ready"
    assert tracked["tracked_segments"] == 2
    assert tracked["progress"] == 100.0

    # Windowed frames endpoint returns resolved Player positions, Zones, Settled, and detections.
    frames_res = client.get(
        f"/api/matches/{match_id}/player-tracking/frames",
        params={"start_frame": 0, "end_frame": 16},
    )
    assert frames_res.status_code == 200
    body = frames_res.json()
    assert len(body["frames"]) == 17
    f12 = body["frames"][12]
    a1_row = next(p for p in f12["players"] if p["player_id"] == str(a1))
    assert a1_row["position_certainty"] == "observed"
    assert a1_row["zone"] == "frontcourt"
    assert a1_row["settled"] is True
    assert len(f12["detections"]) == 1

    # Excessive frame window is rejected with 422.
    too_wide = client.get(
        f"/api/matches/{match_id}/player-tracking/frames",
        params={"start_frame": 0, "end_frame": 5000},
    )
    assert too_wide.status_code == 422


def test_split_segments_retrack_without_serving_the_original_caches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db, match_id, _roster, _video = _setup_api_match(tmp_path)
    homography = fit_landmarks(MAIN.clicks())
    assert homography is not None
    detection = _det_at_court(homography, -4.0, -8.0, emb=_unit_emb(0))
    backend = _FakeVisionBackend([(detection,)])

    def track_span(_video: Path, span: CalibrationSpan, _base: Homography, **_kwargs) -> SpanMotion:
        return SpanMotion(
            span.start_frame,
            span.end_frame,
            span.camera_view,
            span.calibration.effective_from_frame,
            span.calibration.reference_frame,
            np.ones(span.frame_count, dtype=bool),
            np.tile(np.eye(3), (span.frame_count, 1, 1)),
            np.zeros(span.frame_count, dtype=np.float32),
        )

    monkeypatch.setattr("pb_tokei.camera_motion.track_span", track_span)
    app = create_app(db, player_backend_factory=lambda _pref: backend)
    client = TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL})
    match = f"/api/matches/{match_id}"
    original = client.get(f"{match}/play-segments").json()
    assert (
        client.post(f"{match}/camera-motion/track", params={"wait": True}).json()["status"]
        == "ready"
    )
    assert (
        client.post(f"{match}/player-tracking/track", json={"wait": True}).json()["status"]
        == "ready"
    )
    original_calls = backend.calls
    window = {"start_frame": 4, "end_frame": 8}
    old_motion = client.get(f"{match}/camera-motion/frames", params=window).json()
    old_players = client.get(f"{match}/player-tracking/frames", params=window).json()
    assert all(old_motion["court_to_image"])
    assert old_players["frames"][0]["detections"]
    assert old_players["frames"][-1]["detections"]

    halves = [{**original[0], "end_frame": 6}, {**original[0], "start_frame": 7}]
    assert client.put(f"{match}/play-segments", json=[*halves, original[1]]).status_code == 200
    motion = client.get(f"{match}/camera-motion").json()
    assert motion["status"] == "idle"
    assert [span["tracked"] for span in motion["spans"]] == [False, False, True]
    players = client.get(f"{match}/player-tracking").json()
    assert players["status"] == "idle"
    assert [span["status"] for span in players["spans"]] == ["pending", "pending", "done"]
    assert (
        client.get(f"{match}/camera-motion/frames", params=window).json()["court_to_image"]
        == [None] * 5
    )
    assert all(
        not frame["detections"]
        for frame in client.get(f"{match}/player-tracking/frames", params=window).json()["frames"]
    )

    # Undo saves the original bounds again and recovers their cache entries.
    assert client.put(f"{match}/play-segments", json=original).status_code == 200
    assert client.get(f"{match}/camera-motion/frames", params=window).json() == old_motion
    assert client.get(f"{match}/player-tracking/frames", params=window).json() == old_players
    assert backend.calls == original_calls


def test_partial_layer1_decode_raises_and_is_not_cached(tmp_path: Path) -> None:
    """A truncated video decode raises PlayerTrackingError and is never cached as complete."""
    video = tmp_path / "short.60fps.mp4"
    _write_dummy_video(video, n_frames=8)
    seg = PlaySegment(0, 20, CameraView.MAIN)
    cache = PlayerTrackingCache(tmp_path / "cache", detector_model="fake-d", pose_model="fake-p")
    backend = _FakeVisionBackend(detector_model="fake-d", pose_model="fake-p")

    with pytest.raises(PlayerTrackingError, match="failed to decode|ended early"):
        cache.get_or_extract_layer1(video, seg, backend)
    assert not cache.has_layer1(video, seg)


@pytest.mark.parametrize("split", [False, True], ids=["same-segments", "split-segment"])
def test_player_tracking_cancel_stops_background_job(tmp_path: Path, split: bool) -> None:
    db, match_id, _roster, _conv = _setup_api_match(tmp_path)
    started = threading.Event()
    release = threading.Event()

    class _SlowBackend(_FakeVisionBackend):
        def detect_batch(self, frames_bgr: Sequence[np.ndarray]) -> list[tuple[RawDetection, ...]]:
            started.set()
            release.wait(timeout=5.0)
            return super().detect_batch(frames_bgr)

    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html>")
    app = create_app(db, static_dir=static, player_backend_factory=lambda _pref: _SlowBackend())
    client = TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL})

    # Start background job and block inside the first segment's detect_batch.
    res = client.post(f"/api/matches/{match_id}/player-tracking/track", json={}).json()
    assert res["status"] == "tracking"
    assert started.wait(timeout=2.0)

    # Post /cancel FIRST, and only unblock detect_batch once the job's cancel flag is set.
    service = app.state.rally_logs.current.players
    job = service._jobs[match_id]

    def release_after_cancel() -> None:
        if job.cancel.wait(timeout=2.0):
            release.set()

    unblocker = threading.Thread(target=release_after_cancel, daemon=True)
    unblocker.start()
    cancelled = client.post(f"/api/matches/{match_id}/player-tracking/cancel").json()
    unblocker.join(timeout=2.0)

    assert cancelled["status"] == "idle"
    assert cancelled["status"] != "ready"
    assert cancelled["tracked_segments"] < cancelled["total_segments"]
    assert cancelled["error"] is None

    # Re-triggering waits for a superseded job to exit before running a fresh job.
    started.clear()
    release.clear()
    res2 = client.post(f"/api/matches/{match_id}/player-tracking/track", json={}).json()
    assert res2["status"] == "tracking"
    assert started.wait(timeout=2.0)

    running_job = service._jobs[match_id]
    if split:
        # The running job belongs to the old bounds. Neither half can use its results.
        url = f"/api/matches/{match_id}/play-segments"
        first, second = client.get(url).json()
        halves = [{**first, "end_frame": 6}, {**first, "start_frame": 7}]
        assert client.put(url, json=[*halves, second]).status_code == 200
        status = client.get(f"/api/matches/{match_id}/player-tracking").json()
        assert status["status"] == "idle"
        assert [span["status"] for span in status["spans"]] == ["pending"] * 3
    else:
        running_job.cancel.set()

    retracked: dict[str, object] = {}

    def trigger_fresh() -> None:
        retracked["body"] = client.post(
            f"/api/matches/{match_id}/player-tracking/track",
            json={"wait": True},
        ).json()

    retrigger_thread = threading.Thread(target=trigger_fresh, daemon=True)
    retrigger_thread.start()
    assert running_job.cancel.wait(timeout=2.0)
    # Unblock both the winding-down cancelled job and the fresh job.
    release.set()
    retrigger_thread.join(timeout=5.0)
    body = retracked.get("body")
    assert isinstance(body, dict)
    assert body["status"] == "ready"
    assert body["tracked_segments"] == body["total_segments"] == (3 if split else 2)
    assert body["error"] is None


def test_player_tracking_service_error_status_and_http_404s(tmp_path: Path) -> None:
    db, match_id, _roster, _conv = _setup_api_match(tmp_path)

    class _FailingBackend(_FakeVisionBackend):
        def detect_batch(self, frames_bgr: Sequence[np.ndarray]) -> list[tuple[RawDetection, ...]]:
            raise PlayerTrackingError("Simulated GPU out-of-memory")

    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<!doctype html>")
    app = create_app(db, static_dir=static, player_backend_factory=lambda _pref: _FailingBackend())
    client = TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL})

    failed = client.post(
        f"/api/matches/{match_id}/player-tracking/track", json={"wait": True}
    ).json()
    assert failed["status"] == "error"
    assert "Simulated GPU out-of-memory" in (failed["error"] or "")
    assert failed["tracked_segments"] == 0

    # Unknown match_id returns 404 across all Player Tracking endpoints.
    missing = uuid4()
    assert client.get(f"/api/matches/{missing}/player-anchors").status_code == 404
    assert client.put(f"/api/matches/{missing}/player-anchors", json=[]).status_code == 404
    assert client.get(f"/api/matches/{missing}/team-ends").status_code == 404
    assert client.put(f"/api/matches/{missing}/team-ends", json=[]).status_code == 404
    assert client.get(f"/api/matches/{missing}/player-tracking").status_code == 404
    assert client.post(f"/api/matches/{missing}/player-tracking/track", json={}).status_code == 404
    assert client.post(f"/api/matches/{missing}/player-tracking/cancel").status_code == 404
    assert (
        client.get(
            f"/api/matches/{missing}/player-tracking/frames",
            params={"start_frame": 0, "end_frame": 10},
        ).status_code
        == 404
    )


def test_cli_track_command_runs_engine_and_handles_errors(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db, match_id, _roster, conv = _setup_api_match(tmp_path)
    fake_backend = _FakeVisionBackend(device=DeviceKind.CPU)

    code = main(
        ["track", str(match_id), "--db", str(db), "--device", "cpu"],
        player_backend=fake_backend,
    )
    assert code == 0
    out = capsys.readouterr().out
    assert "Tracked 2 Play Segments" in out
    assert "CPU" in out
    assert fake_backend.calls > 0

    # Missing match returns exit code 1 with clear message.
    bad_code = main(
        ["track", str(uuid4()), "--db", str(db)],
        player_backend=fake_backend,
    )
    assert bad_code == 1
    assert "Match not found" in capsys.readouterr().err

    # Backend raising PlayerTrackingError returns exit code 1.
    class _FailingBackend(_FakeVisionBackend):
        def detect_batch(self, frames_bgr: Sequence[np.ndarray]) -> list[tuple[RawDetection, ...]]:
            raise PlayerTrackingError("Model download failed")

    # Clear Layer 1 cache so the failing backend actually runs.
    cache_dir = db.parent / ".pb-tokei-cache" / "player_tracking"
    for p in cache_dir.glob("l1_*.npz"):
        p.unlink()
    err_code = main(
        ["track", str(match_id), "--db", str(db), "--device", "cpu"],
        player_backend=_FailingBackend(device=DeviceKind.CPU),
    )
    assert err_code == 1
    assert "Model download failed" in capsys.readouterr().err

    # Match with no Play Segments returns exit code 1.
    with RallyLog.open(db) as log:
        log.replace_play_segments(match_id, ())
    no_seg_code = main(
        ["track", str(match_id), "--db", str(db), "--device", "cpu"],
        player_backend=fake_backend,
    )
    assert no_seg_code == 1
    assert "Play Segments" in capsys.readouterr().err

    # Match with missing video file returns exit code 1.
    with RallyLog.open(db) as log:
        log.replace_play_segments(match_id, (PlaySegment(0, 16, CameraView.MAIN),))
    conv.unlink()
    missing_vid_code = main(
        ["track", str(match_id), "--db", str(db), "--device", "cpu"],
        player_backend=fake_backend,
    )
    assert missing_vid_code == 1
    assert "video" in capsys.readouterr().err.lower()


def test_settled_inferred_certainty_during_brief_occlusion() -> None:
    """Brief occlusion (<= 30 frames) inside Frontcourt produces Inferred position & Settled."""
    _, _, _, roster = _make_roster()
    a1 = roster.team_a_players[0].id
    h = fit_landmarks(MAIN.clicks())
    assert h is not None
    seg = PlaySegment(0, 40, CameraView.MAIN)
    cal = Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))
    mapping = CourtMapping([seg], [cal])
    samples = sample_frames_for_segment(0, 40, stride=4)

    dets: dict[int, tuple[RawDetection, ...]] = {}
    for f in samples:
        if f in (0, 4, 8, 28, 32, 36, 40):
            dets[f] = (_det_at_court(h, -3.0, -7.5, emb=_unit_emb(0)),)
        else:
            dets[f] = ()
    img = h.to_image(CourtPoint(-3.0, -7.5))
    assert img is not None
    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg],
        layer1_by_segment={(0, 40): SegmentDetections(0, 40, 4, "d", "p", samples, dets)},
        court_mapping=mapping,
        player_anchors=[PlayerAnchor(0, a1, AnchorKind.IDENTITY, img.x, max(0.0, img.y - 0.05))],
    )
    mid = positions_at(tracking, 20)[a1]
    assert mid.position.certainty is Certainty.INFERRED
    assert mid.settled == inferred(True)


def test_suppresses_same_person_partial_duplicate_and_prefers_cut_frame_tracklet() -> None:
    """Overlapping partial boxes on one Player don't spawn twin tracklets, and live cross-cut
    matching prefers a persistent tracklet present on the cut frame over a delayed 1-frame blip."""
    _, _, _, roster = _make_roster()
    a1 = roster.team_a_players[0].id
    h_main = fit_landmarks(MAIN.clicks())
    h_side = fit_landmarks(SIDELINE.clicks())
    assert h_main is not None and h_side is not None

    seg1 = PlaySegment(0, 16, CameraView.MAIN)
    seg2 = PlaySegment(17, 45, CameraView.SIDELINE)
    cals = [
        Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0)),
        Calibration(CameraView.SIDELINE, 17, 17, SIDELINE.placed(17)),
    ]
    mapping = CourtMapping([seg1, seg2], cals)

    # Seg 1: A1 stands at (-3, 10) with an extra lower-scoring ankle-less partial box overlapping
    # on frame 8 (simulating partial occlusion behind the net tape).
    s1_samples = sample_frames_for_segment(0, 16, stride=4)
    s1_dets: dict[int, tuple[RawDetection, ...]] = {}
    for f in s1_samples:
        full = _det_at_court(h_main, -3.0, 10.0, emb=_unit_emb(0), score=0.92)
        if f == 8:
            partial = _det_at_court(
                h_main,
                -2.9,
                9.2,
                emb=_unit_emb(0),
                ankles_visible=False,
                box_h=0.14,
                score=0.55,
            )
            s1_dets[f] = (full, partial)
        else:
            s1_dets[f] = (full,)

    # Seg 2: A1 continues on frame 17..45 at (-2.2, 11.5) (dist ~1.7 ft from (-3, 10)),
    # while a 1-frame blip appears 12 frames later (frame 29) slightly closer to (-3, 10)!
    s2_samples = sample_frames_for_segment(17, 45, stride=4)
    s2_dets: dict[int, tuple[RawDetection, ...]] = {}
    for f in s2_samples:
        real = _det_at_court(h_side, -2.2, 11.5, emb=_unit_emb(0), score=0.90)
        if f == 29:
            blip = _det_at_court(h_side, -3.1, 10.2, emb=_unit_emb(0), score=0.55)
            s2_dets[f] = (real, blip)
        else:
            s2_dets[f] = (real,)

    img = h_main.to_image(CourtPoint(-3.0, 10.0))
    assert img is not None
    tracking = solve_match_tracking(
        roster=roster,
        segments=[seg1, seg2],
        layer1_by_segment={
            (0, 16): SegmentDetections(0, 16, 4, "d", "p", s1_samples, s1_dets),
            (17, 45): SegmentDetections(17, 45, 4, "d", "p", s2_samples, s2_dets),
        },
        court_mapping=mapping,
        player_anchors=[PlayerAnchor(0, a1, AnchorKind.IDENTITY, img.x, max(0.0, img.y - 0.05))],
    )

    # Duplicate box on frame 8 was suppressed so only 1 kept detection remains.
    assert len(tracking.detections_at(8)) == 1
    # Cross-cut matched the persistent tracklet present on frame 17, keeping A1 tracked at frame 45.
    p17 = positions_at(tracking, 17)[a1].position.value
    p45 = positions_at(tracking, 45)[a1].position.value
    assert p17 is not None and p17.x == pytest.approx(-2.2, abs=0.2)
    assert p45 is not None and p45.x == pytest.approx(-2.2, abs=0.2)
