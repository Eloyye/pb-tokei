import json
from pathlib import Path
from uuid import uuid4

import duckdb
import pytest
from fastapi.testclient import TestClient
from test_calibration import MAIN, SIDELINE

from pb_tokei import main
from pb_tokei.annotate.app import CalibrationOut, create_app
from pb_tokei.rally_log import (
    Calibration,
    CameraView,
    Landmark,
    MatchId,
    PlacedLandmark,
    RallyLog,
    SourceVideo,
)
from pb_tokei.roster import parse_roster, set_up_match

URL = "https://www.youtube.com/watch?v=abc123"
VIDEO_BYTES = bytes(range(256)) * 40
# The app only answers requests addressed to this machine (see test_other_hosts_are_refused).
LOCAL = "http://127.0.0.1"


def add_match(db: Path, *, tournament: str = "PPA Atlanta Open 2026") -> MatchId:
    roster = parse_roster(
        f'id = "{uuid4()}"\n'
        f'[tournament]\nname = "{tournament}"\ntour = "ppa"\n'
        '[[team_a.players]]\nname = "Ben Johns"\nhandedness = "right"\n'
        '[[team_a.players]]\nname = "Anna Bright"\nhandedness = "right"\n'
        '[[team_b.players]]\nname = "Cara Lee"\nhandedness = "left"\n'
        '[[team_b.players]]\nname = "Dan Kim"\nhandedness = "right"\n'
    )
    with RallyLog.open(db) as log:
        return set_up_match(log, roster).id


def set_video(db: Path, match_id: MatchId, path: Path) -> None:
    with RallyLog.open(db) as log:
        log.set_match_source_video(match_id, SourceVideo(URL, "abc123", path))


@pytest.fixture
def db(tmp_path: Path) -> Path:
    return tmp_path / "log.duckdb"


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>app</title>")
    (static / "assets" / "app.js").write_text("console.log('app')")
    return static


@pytest.fixture
def client(db: Path, tmp_path: Path, static_dir: Path) -> TestClient:
    return TestClient(create_app(db, base_dir=tmp_path, static_dir=static_dir), base_url=LOCAL)


def footage(tmp_path: Path, *, converted: bool) -> Path:
    """Writes an original download, and its 60 fps copy if `converted`; returns the original."""
    (tmp_path / "footage").mkdir(exist_ok=True)
    original = tmp_path / "footage" / "abc123.webm"
    original.write_bytes(b"original")
    if converted:
        (tmp_path / "footage" / "abc123.60fps.mp4").write_bytes(VIDEO_BYTES)
    return original


# --- Matches ------------------------------------------------------------------------------


def test_lists_matches_with_roster_and_video_status(
    client: TestClient, db: Path, tmp_path: Path
) -> None:
    no_video = add_match(db, tournament="APP Chicago 2026")
    ready = add_match(db)
    footage(tmp_path, converted=True)
    # Recorded relative to the directory the server was started from, as the CLI records it.
    set_video(db, ready, Path("footage/abc123.webm"))

    response = client.get("/api/matches")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": str(no_video),
            "tournament": "APP Chicago 2026",
            "team_a": ["Anna Bright", "Ben Johns"],
            "team_b": ["Cara Lee", "Dan Kim"],
            "franchise_a": None,
            "franchise_b": None,
            "video_status": "none",
        },
        {
            "id": str(ready),
            "tournament": "PPA Atlanta Open 2026",
            "team_a": ["Anna Bright", "Ben Johns"],
            "team_b": ["Cara Lee", "Dan Kim"],
            "franchise_a": None,
            "franchise_b": None,
            "video_status": "ready",
        },
    ]


def test_match_without_video_says_to_download(client: TestClient, db: Path) -> None:
    match_id = add_match(db)

    body = client.get(f"/api/matches/{match_id}").json()

    assert body["video_status"] == "none"
    assert body["fix_command"] == f"pb-tokei download <url> --match {match_id} --db {db}"


def test_fix_command_leaves_out_the_default_db(tmp_path: Path, static_dir: Path) -> None:
    db = tmp_path / "rally_log.duckdb"
    match_id = add_match(db)
    client = TestClient(
        create_app(Path("rally_log.duckdb"), base_dir=tmp_path, static_dir=static_dir),
        base_url=LOCAL,
    )

    body = client.get(f"/api/matches/{match_id}").json()

    assert body["fix_command"] == f"pb-tokei download <url> --match {match_id}"


def test_unconverted_match_says_to_convert(client: TestClient, db: Path, tmp_path: Path) -> None:
    match_id = add_match(db)
    footage(tmp_path, converted=False)
    set_video(db, match_id, Path("footage/abc123.webm"))

    body = client.get(f"/api/matches/{match_id}").json()

    assert body["video_status"] == "not_converted"
    assert body["fix_command"] == "pb-tokei convert footage/abc123.webm"


def test_match_whose_download_is_gone_says_to_download_again(client: TestClient, db: Path) -> None:
    match_id = add_match(db)
    set_video(db, match_id, Path("footage/abc123.webm"))

    body = client.get(f"/api/matches/{match_id}").json()

    assert body["video_status"] == "not_converted"
    # Quoted, since the `?` in a URL is a glob character in the shell.
    assert body["fix_command"] == f"pb-tokei download '{URL}' --match {match_id} --db {db}"


def test_ready_match_has_no_fix_command(client: TestClient, db: Path, tmp_path: Path) -> None:
    match_id = add_match(db)
    original = footage(tmp_path, converted=True)
    set_video(db, match_id, original)

    body = client.get(f"/api/matches/{match_id}").json()

    assert body["video_status"] == "ready"
    assert body["fix_command"] is None
    assert body["team_b"] == ["Cara Lee", "Dan Kim"]


def test_unknown_match_is_404(client: TestClient, db: Path) -> None:
    add_match(db)

    assert client.get(f"/api/matches/{uuid4()}").status_code == 404
    assert client.get(f"/api/matches/{uuid4()}/video").status_code == 404
    assert client.get("/api/matches/not-a-uuid").status_code == 422


@pytest.mark.parametrize("path", ["/api/matches", "/api/matches/{id}", "/api/matches/{id}/video"])
def test_a_locked_rally_log_is_a_503_not_a_crash(
    client: TestClient, db: Path, monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    match_id = add_match(db)

    def locked(_path: object) -> RallyLog:
        raise duckdb.IOException("Could not set lock on file: Conflicting lock is held")

    # As when `pb-tokei match add` is writing to the file at that moment.
    monkeypatch.setattr(RallyLog, "open", locked)
    response = client.get(path.format(id=match_id))

    assert response.status_code == 503
    assert response.json()["detail"].startswith("Rally Log unavailable")


def test_rally_log_is_closed_between_requests(client: TestClient, db: Path) -> None:
    add_match(db)
    client.get("/api/matches")

    # Another process (the CLI) can open the file read-write while the app is running.
    with duckdb.connect(str(db)) as connection:
        assert connection.execute("SELECT count(*) FROM matches").fetchone() == (1,)


# --- Video --------------------------------------------------------------------------------


def test_video_supports_range_requests(client: TestClient, db: Path, tmp_path: Path) -> None:
    match_id = add_match(db)
    set_video(db, match_id, footage(tmp_path, converted=True))

    whole = client.get(f"/api/matches/{match_id}/video")
    part = client.get(f"/api/matches/{match_id}/video", headers={"Range": "bytes=100-199"})

    assert whole.status_code == 200
    assert whole.headers["content-type"] == "video/mp4"
    assert whole.headers["accept-ranges"] == "bytes"
    assert whole.content == VIDEO_BYTES
    assert part.status_code == 206
    assert part.headers["content-range"] == f"bytes 100-199/{len(VIDEO_BYTES)}"
    assert part.content == VIDEO_BYTES[100:200]


def test_a_recorded_60fps_copy_is_played_as_is(
    client: TestClient, db: Path, tmp_path: Path
) -> None:
    match_id = add_match(db)
    footage(tmp_path, converted=True)
    set_video(db, match_id, Path("footage/abc123.60fps.mp4"))

    body = client.get(f"/api/matches/{match_id}").json()
    video = client.get(f"/api/matches/{match_id}/video")

    assert body["video_status"] == "ready"
    assert video.status_code == 200
    assert video.content == VIDEO_BYTES


def test_a_missing_recorded_60fps_copy_says_to_download_again(client: TestClient, db: Path) -> None:
    match_id = add_match(db)
    set_video(db, match_id, Path("footage/abc123.60fps.mp4"))

    body = client.get(f"/api/matches/{match_id}").json()

    assert body["video_status"] == "not_converted"
    assert body["fix_command"].startswith(f"pb-tokei download '{URL}' --match {match_id}")


@pytest.mark.parametrize("converted", [False, None])
def test_video_is_404_until_converted(
    client: TestClient, db: Path, tmp_path: Path, converted: bool | None
) -> None:
    match_id = add_match(db)
    if converted is not None:
        set_video(db, match_id, footage(tmp_path, converted=converted))

    assert client.get(f"/api/matches/{match_id}/video").status_code == 404


# --- Front end ----------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/", "/matches/0b1c0c55-1f43-4a87-9d2a-2a1f6c0f7f3e"])
def test_front_end_routes_get_index_html(client: TestClient, path: str) -> None:
    response = client.get(path)

    assert response.status_code == 200
    assert "<title>app</title>" in response.text


def test_built_assets_are_served(client: TestClient) -> None:
    response = client.get("/assets/app.js")

    assert response.status_code == 200
    assert response.text == "console.log('app')"


def test_files_outside_the_build_are_not_served(
    client: TestClient, tmp_path: Path, static_dir: Path
) -> None:
    (tmp_path / "secret.txt").write_text("secret")
    (static_dir / "link.txt").symlink_to(tmp_path / "secret.txt")
    index_html = (static_dir / "index.html").read_text()

    for path in ["/%2e%2e/secret.txt", "/assets/%2e%2e/%2e%2e/secret.txt", "/link.txt"]:
        response = client.get(path)

        # Treated as a front-end route, like any path that isn't a built file.
        assert response.status_code == 200, path
        assert response.text == index_html, path


@pytest.mark.parametrize("path", ["/api/matches", "/"])
def test_other_hosts_are_refused(client: TestClient, path: str) -> None:
    # A page whose domain re-resolves to 127.0.0.1 (DNS rebinding) sends its own Host.
    response = client.get(path, headers={"Host": "evil.example:8000"})

    assert response.status_code == 400


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:5173"])
def test_local_hosts_are_served(client: TestClient, host: str) -> None:
    # localhost:5173 is the Vite dev server forwarding /api.
    assert client.get("/api/matches", headers={"Host": host}).status_code == 200


def test_unknown_api_path_is_404_not_index_html(client: TestClient) -> None:
    response = client.get("/api/nope")

    assert response.status_code == 404
    assert "<title>" not in response.text


# --- Play Segments and Calibrations -------------------------------------------------------


# Where a camera high behind the near baseline sees the four baseline corners.
def corners(frame: int = 130) -> dict[str, dict[str, float | int]]:
    return {
        "near_baseline_left": {"x": 0.1, "y": 0.9, "frame": frame},
        "near_baseline_right": {"x": 0.9, "y": 0.9, "frame": frame},
        "far_baseline_left": {"x": 0.35, "y": 0.2, "frame": frame},
        "far_baseline_right": {"x": 0.65, "y": 0.2, "frame": frame},
    }


CORNERS = corners(130)


def test_play_segments_are_replaced_and_read_back(client: TestClient, db: Path) -> None:
    match_id = add_match(db)
    url = f"/api/matches/{match_id}/play-segments"
    assert client.get(url).json() == []
    segments = [
        {"start_frame": 900, "end_frame": 900, "camera_view": "sideline"},
        {"start_frame": 100, "end_frame": 899, "camera_view": "main"},
    ]

    response = client.put(url, json=segments)

    assert response.status_code == 200
    assert response.json() == [segments[1], segments[0]]
    assert client.get(url).json() == [segments[1], segments[0]]


@pytest.mark.parametrize(
    "segments",
    [
        [
            {"start_frame": 0, "end_frame": 100, "camera_view": "main"},
            {"start_frame": 100, "end_frame": 200, "camera_view": "main"},
        ],
        [{"start_frame": -1, "end_frame": 100, "camera_view": "main"}],
        [{"start_frame": 50, "end_frame": 49, "camera_view": "main"}],
        [{"start_frame": 0, "end_frame": 10, "camera_view": "overhead"}],
    ],
    ids=["overlap", "negative", "backwards", "unknown-view"],
)
def test_invalid_play_segments_are_refused(
    client: TestClient, db: Path, segments: list[dict[str, object]]
) -> None:
    match_id = add_match(db)
    url = f"/api/matches/{match_id}/play-segments"

    assert client.put(url, json=segments).status_code == 422
    assert client.get(url).json() == []


def test_calibrations_are_saved_per_view_and_returned_with_their_fit(
    client: TestClient, db: Path
) -> None:
    match_id = add_match(db)
    main = {
        "effective_from_frame": 100,
        "reference_frame": 130,
        "landmarks": CORNERS,
        "not_visible": ["near_kitchen_centre"],
    }
    sideline = {"effective_from_frame": 900, "reference_frame": 950, "landmarks": {}}

    response = client.put(f"/api/matches/{match_id}/calibrations/main", json=[main])
    client.put(f"/api/matches/{match_id}/calibrations/sideline", json=[sideline])

    assert response.status_code == 200
    (saved,) = response.json()
    assert saved["camera_view"] == "main"
    assert saved["landmarks"] == CORNERS
    assert saved["not_visible"] == ["near_kitchen_centre"]
    assert saved["unmapped_landmarks"] == []
    assert set(saved["resolved_landmarks"]) == set(CORNERS)
    assert saved["complete"] is True
    assert len(saved["image_to_court"]) == 3 and len(saved["court_to_image"]) == 3
    assert set(saved["errors"]) == set(CORNERS)
    # Four Landmarks fit exactly, and none can be left out.
    assert saved["errors"]["far_baseline_left"]["leave_one_out_ft"] is None
    assert saved["worst_error_ft"] < 1e-6
    assert saved["needs_attention"] is False
    assert not any(e["needs_attention"] for e in saved["errors"].values())

    both = client.get(f"/api/matches/{match_id}/calibrations").json()
    assert [(c["camera_view"], c["complete"]) for c in both] == [
        ("main", True),
        ("sideline", False),
    ]


def test_replacing_one_views_calibrations_keeps_the_others(client: TestClient, db: Path) -> None:
    match_id = add_match(db)
    calibration = {"effective_from_frame": 0, "reference_frame": 0, "landmarks": corners(0)}
    client.put(f"/api/matches/{match_id}/calibrations/sideline", json=[calibration])

    client.put(f"/api/matches/{match_id}/calibrations/main", json=[])

    views = [c["camera_view"] for c in client.get(f"/api/matches/{match_id}/calibrations").json()]
    assert views == ["sideline"]


@pytest.mark.parametrize(
    ("landmarks", "not_visible"),
    [
        ({"halfway_line": {"x": 0.5, "y": 0.5, "frame": 0}}, []),
        ({"near_baseline_left": {"x": 1.5, "y": 0.5, "frame": 0}}, []),
        ({"near_baseline_left": {"x": 0.5, "y": 0.5, "frame": -1}}, []),
        ({"near_baseline_left": {"x": 0.5, "y": 0.5, "frame": 0}}, ["near_baseline_left"]),
    ],
    ids=["unknown-landmark", "outside-frame", "negative-frame", "placed-and-not-visible"],
)
def test_invalid_calibrations_are_refused(
    client: TestClient, db: Path, landmarks: dict[str, object], not_visible: list[str]
) -> None:
    match_id = add_match(db)
    body = [
        {
            "effective_from_frame": 0,
            "reference_frame": 0,
            "landmarks": landmarks,
            "not_visible": not_visible,
        }
    ]

    response = client.put(f"/api/matches/{match_id}/calibrations/main", json=body)

    assert response.status_code == 422


def test_off_reference_landmark_without_video_is_flagged_unmapped(
    client: TestClient, db: Path
) -> None:
    match_id = add_match(db)
    mixed = {
        **corners(130),
        "near_kitchen_left": {"x": 0.2, "y": 0.7, "frame": 145},
    }
    response = client.put(
        f"/api/matches/{match_id}/calibrations/main",
        json=[{"effective_from_frame": 100, "reference_frame": 130, "landmarks": mixed}],
    )

    assert response.status_code == 200
    (saved,) = response.json()
    assert saved["complete"] is True
    assert saved["unmapped_landmarks"] == ["near_kitchen_left"]
    assert "near_kitchen_left" not in saved["errors"]
    assert saved["needs_attention"] is True


def test_two_calibrations_starting_at_one_frame_are_refused(client: TestClient, db: Path) -> None:
    match_id = add_match(db)
    calibration = {"effective_from_frame": 10, "reference_frame": 10, "landmarks": {}}

    response = client.put(
        f"/api/matches/{match_id}/calibrations/main", json=[calibration, calibration]
    )

    assert response.status_code == 422
    assert "start at frame 10" in response.json()["detail"]


def test_an_off_court_click_is_reported_without_infinity() -> None:
    clicks = SIDELINE.placed(0)
    corner = Landmark.FAR_BASELINE_RIGHT
    clicks[corner] = PlacedLandmark(clicks[corner].x, 0.0, 0)  # above the horizon

    out = CalibrationOut.from_domain(Calibration(CameraView.SIDELINE, 0, 0, clicks))

    body = json.loads(out.model_dump_json())
    error = body["errors"]["far_baseline_right"]
    assert error["leave_one_out_ft"] is None
    assert error["off_court"] is True
    # The feet are null, so the flag is what marks this Landmark.
    assert error["needs_attention"] is True
    assert body["worst_error_ft"] is None
    assert body["needs_attention"] is True


def test_a_misclicked_landmark_is_flagged_and_has_the_largest_error() -> None:
    clicks = MAIN.placed(0)
    corner = Landmark.FAR_BASELINE_RIGHT
    clicks[corner] = PlacedLandmark(clicks[corner].x + 0.02, clicks[corner].y, 0)

    body = json.loads(
        CalibrationOut.from_domain(Calibration(CameraView.MAIN, 0, 0, clicks)).model_dump_json()
    )

    errors = body["errors"]
    assert errors["far_baseline_right"]["needs_attention"] is True
    worst = max(errors, key=lambda lm: errors[lm]["leave_one_out_ft"])
    assert worst == "far_baseline_right"
    assert body["needs_attention"] is True


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "play-segments"),
        ("put", "play-segments"),
        ("get", "calibrations"),
        ("put", "calibrations/main"),
    ],
)
def test_segments_and_calibrations_of_a_missing_match_are_404(
    client: TestClient, method: str, path: str
) -> None:
    url = f"/api/matches/{uuid4()}/{path}"

    response = client.get(url) if method == "get" else client.put(url, json=[])

    assert response.status_code == 404


# --- Camera Motion ------------------------------------------------------------------------


def test_camera_motion_reports_no_video_without_converted_footage(
    client: TestClient, db: Path
) -> None:
    match_id = add_match(db)

    body = client.get(f"/api/matches/{match_id}/camera-motion").json()

    assert body == {
        "status": "no_video",
        "error": None,
        "tracked_spans": 0,
        "total_spans": 0,
        "unmapped_ranges": [],
        "spans": [],
    }


def test_camera_motion_tracks_caches_and_serves_frames_with_unmapped_cuts(
    client: TestClient, db: Path, tmp_path: Path
) -> None:
    from test_camera_motion import _panning_camera, write_synthetic_video

    match_id = add_match(db)
    (tmp_path / "footage").mkdir(exist_ok=True)
    original = tmp_path / "footage" / "abc123.webm"
    original.write_bytes(b"original")
    converted = tmp_path / "footage" / "abc123.60fps.mp4"

    # 20 frames: live play 0..11, hard cut 12..15, live play 16..19.
    cameras = [None if 12 <= f <= 15 else _panning_camera((f - 5) / 20.0) for f in range(20)]
    write_synthetic_video(converted, cameras)
    set_video(db, match_id, Path("footage/abc123.webm"))

    ref_cam = cameras[5]
    assert ref_cam is not None
    landmarks = {lm.value: {"x": p.x, "y": p.y, "frame": 5} for lm, p in ref_cam.clicks().items()}
    client.put(
        f"/api/matches/{match_id}/play-segments",
        json=[{"start_frame": 0, "end_frame": 19, "camera_view": "sideline"}],
    )
    client.put(
        f"/api/matches/{match_id}/calibrations/sideline",
        json=[{"effective_from_frame": 0, "reference_frame": 5, "landmarks": landmarks}],
    )

    before = client.get(f"/api/matches/{match_id}/camera-motion").json()
    assert before["status"] == "idle"
    assert before["tracked_spans"] == 0
    assert before["total_spans"] == 1

    tracked = client.post(f"/api/matches/{match_id}/camera-motion/track?wait=true").json()
    assert tracked["status"] == "ready"
    assert tracked["tracked_spans"] == 1
    assert tracked["total_spans"] == 1
    assert tracked["unmapped_ranges"] == [
        {"start_frame": 12, "end_frame": 15, "camera_view": "sideline"}
    ]

    frames = client.get(
        f"/api/matches/{match_id}/camera-motion/frames?start_frame=0&end_frame=19"
    ).json()
    assert len(frames["court_to_image"]) == 20
    assert len(frames["unmapped"]) == 20
    # Reference frame and live-play frames are mapped; cut frames are unmapped (null).
    assert frames["court_to_image"][5] is not None and frames["unmapped"][5] is False
    assert frames["court_to_image"][0] is not None and frames["unmapped"][0] is False
    for cut_f in range(12, 16):
        assert frames["court_to_image"][cut_f] is None
        assert frames["unmapped"][cut_f] is True


def test_calibrations_api_registers_off_reference_landmarks_on_panning_video(
    client: TestClient, db: Path, tmp_path: Path
) -> None:
    from test_camera_motion import _panning_camera, write_synthetic_video

    match_id = add_match(db)
    (tmp_path / "footage").mkdir(exist_ok=True)
    (tmp_path / "footage" / "abc123.webm").write_bytes(b"original")
    converted = tmp_path / "footage" / "abc123.60fps.mp4"

    cameras = [_panning_camera((f - 5) / 16.0) for f in range(15)]
    write_synthetic_video(converted, cameras)
    set_video(db, match_id, Path("footage/abc123.webm"))

    client.put(
        f"/api/matches/{match_id}/play-segments",
        json=[{"start_frame": 0, "end_frame": 14, "camera_view": "sideline"}],
    )

    # Click 3 Landmarks on reference frame 5 and 3 on panned frame 12.
    ref_clicks = cameras[5].clicks(
        [Landmark.NEAR_KITCHEN_CENTRE, Landmark.NEAR_KITCHEN_RIGHT, Landmark.FAR_KITCHEN_CENTRE]
    )
    off_clicks = cameras[12].clicks(
        [Landmark.FAR_KITCHEN_RIGHT, Landmark.NEAR_BASELINE_RIGHT, Landmark.FAR_BASELINE_RIGHT]
    )
    landmarks = {
        **{lm.value: {"x": p.x, "y": p.y, "frame": 5} for lm, p in ref_clicks.items()},
        **{lm.value: {"x": p.x, "y": p.y, "frame": 12} for lm, p in off_clicks.items()},
    }

    response = client.put(
        f"/api/matches/{match_id}/calibrations/sideline",
        json=[
            {
                "effective_from_frame": 0,
                "reference_frame": 5,
                "landmarks": landmarks,
                "not_visible": ["near_baseline_left"],
            }
        ],
    )
    assert response.status_code == 200
    (saved,) = response.json()
    assert saved["complete"] is True
    assert saved["unmapped_landmarks"] == []
    assert saved["not_visible"] == ["near_baseline_left"]
    assert saved["worst_error_ft"] is not None and saved["worst_error_ft"] < 0.5
    assert set(saved["resolved_landmarks"]) == set(landmarks)

    tracked = client.post(f"/api/matches/{match_id}/camera-motion/track?wait=true").json()
    assert tracked["status"] == "ready"
    assert tracked["tracked_spans"] == 1
    assert tracked["unmapped_ranges"] == []

    # Frames at or beyond the video's frame count (15) are rejected with 422.
    bad_ref = client.put(
        f"/api/matches/{match_id}/calibrations/sideline",
        json=[{"effective_from_frame": 0, "reference_frame": 15, "landmarks": {}}],
    )
    assert bad_ref.status_code == 422
    bad_lm = client.put(
        f"/api/matches/{match_id}/calibrations/sideline",
        json=[
            {
                "effective_from_frame": 0,
                "reference_frame": 5,
                "landmarks": {"near_kitchen_left": {"x": 0.2, "y": 0.5, "frame": 15}},
            }
        ],
    )
    assert bad_lm.status_code == 422


def test_camera_motion_rejects_invalid_frame_windows_and_missing_matches(
    client: TestClient, db: Path
) -> None:
    match_id = add_match(db)

    assert (
        client.get(
            f"/api/matches/{match_id}/camera-motion/frames?start_frame=20&end_frame=10"
        ).status_code
        == 422
    )
    assert (
        client.get(
            f"/api/matches/{match_id}/camera-motion/frames?start_frame=0&end_frame=20000"
        ).status_code
        == 422
    )
    assert client.get(f"/api/matches/{uuid4()}/camera-motion").status_code == 404
    assert client.post(f"/api/matches/{uuid4()}/camera-motion/track").status_code == 404


def test_camera_motion_service_background_jobs_dedupe_supersede_and_report_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    from pb_tokei.annotate.motion import CameraMotionService, CameraMotionStatus
    from pb_tokei.camera_motion import CameraMotion
    from pb_tokei.rally_log import PlaySegment

    video = tmp_path / "match.60fps.mp4"
    video.write_bytes(b"video")
    service = CameraMotionService(tmp_path / "cache")
    match_id = MatchId(uuid4())
    segments = [PlaySegment(0, 10, CameraView.MAIN)]
    cal_a = [Calibration(CameraView.MAIN, 0, 0, MAIN.placed(0))]
    moved = dict(MAIN.placed(0))
    moved[Landmark.NEAR_BASELINE_LEFT] = PlacedLandmark(
        min(1.0, moved[Landmark.NEAR_BASELINE_LEFT].x + 0.01),
        moved[Landmark.NEAR_BASELINE_LEFT].y,
        0,
    )
    cal_b = [Calibration(CameraView.MAIN, 0, 0, moved)]

    started_events: list[threading.Event] = []
    release_events: list[threading.Event] = []
    cancel_events: list[threading.Event | None] = []
    calls = 0

    def blocking_track_match(
        _video: Path,
        _segments: object,
        _cals: object,
        *,
        on_span_done: object = None,
        cancel: threading.Event | None = None,
    ) -> CameraMotion:
        nonlocal calls
        idx = calls
        calls += 1
        started_events[idx].set()
        cancel_events.append(cancel)
        release_events[idx].wait(timeout=5.0)
        return CameraMotion()

    monkeypatch.setattr(service.cache, "track_match", blocking_track_match)

    # 1. Triggering twice with the same signature starts only one job, and wait=True joins it.
    started_events.append(threading.Event())
    release_events.append(threading.Event())
    first = service.trigger(match_id, video, segments, cal_a)
    assert first.status is CameraMotionStatus.TRACKING
    assert started_events[0].wait(timeout=2.0)

    second = service.trigger(match_id, video, segments, cal_a)
    assert second.status is CameraMotionStatus.TRACKING
    assert calls == 1

    # 2. Editing Calibrations while job A runs: status for B is IDLE (not TRACKING for A).
    assert service.status(match_id, video, segments, cal_b).status is CameraMotionStatus.IDLE

    # Triggering B cancels job A and runs a new job for B.
    started_events.append(threading.Event())
    release_events.append(threading.Event())
    third = service.trigger(match_id, video, segments, cal_b)
    assert third.status is CameraMotionStatus.TRACKING
    assert cancel_events[0] is not None and cancel_events[0].is_set()
    assert started_events[1].wait(timeout=2.0)
    assert calls == 2

    # Stale job A finishing must not clobber job B's TRACKING state.
    release_events[0].set()
    assert service.status(match_id, video, segments, cal_b).status is CameraMotionStatus.TRACKING

    # wait=True on B joins the in-flight job B instead of starting a third run.
    joiner_entered = threading.Event()
    joiner_done = threading.Event()

    def join_b() -> None:
        joiner_entered.set()
        service.trigger(match_id, video, segments, cal_b, wait=True)
        joiner_done.set()

    joiner = threading.Thread(target=join_b, daemon=True)
    joiner.start()
    assert joiner_entered.wait(timeout=2.0)
    # Wait briefly to verify wait=True blocks while job B is still running.
    assert not joiner_done.wait(timeout=0.05)
    release_events[1].set()
    assert joiner_done.wait(timeout=2.0)
    assert calls == 2

    # 3. Errors from track_match are surfaced as ERROR status.
    def failing_track_match(*_args: object, **_kwargs: object) -> CameraMotion:
        raise RuntimeError("corrupt stream")

    monkeypatch.setattr(service.cache, "track_match", failing_track_match)
    errored = service.trigger(match_id, video, segments, cal_b, wait=True)
    assert errored.status is CameraMotionStatus.ERROR
    assert errored.error == "corrupt stream"


# --- CLI ----------------------------------------------------------------------------------


def test_annotate_needs_an_existing_database(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(["annotate", "--no-browser", "--db", str(tmp_path / "missing.duckdb")])

    assert code == 1
    assert "Rally Log database not found" in capsys.readouterr().err


def test_annotate_refuses_to_start_without_a_built_front_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "log.duckdb"
    add_match(db)
    monkeypatch.setattr("pb_tokei.annotate.server.STATIC_DIR", tmp_path / "no-build")

    code = main(["annotate", "--no-browser", "--db", str(db)])

    assert code == 1
    assert "bun install && bun run build" in capsys.readouterr().err
