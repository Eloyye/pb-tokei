"""Tests for streaming footage progress, FootageJobService, API endpoints, and Origin checks."""

from __future__ import annotations

import json
import subprocess
import threading
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from pb_tokei import main
from pb_tokei.annotate.app import create_app
from pb_tokei.annotate.footage_jobs import (
    FootageJobService,
    FootageJobState,
    footage_error_hint,
)
from pb_tokei.convert import ConvertProgress, convert_footage
from pb_tokei.footage import (
    PROGRESS_PREFIX,
    CommandCancelledError,
    DownloadProgress,
    download_footage,
    parse_yt_dlp_progress,
)
from pb_tokei.process import LineCallback
from pb_tokei.rally_log import MatchId, RallyLog, SourceVideo
from pb_tokei.roster import parse_roster, set_up_match
from pb_tokei.state import read_cookies_from_browser, write_cookies_from_browser

LOCAL = "http://127.0.0.1"
URL_A = "https://www.youtube.com/watch?v=vidAAAAAAA"
URL_B = "https://www.youtube.com/watch?v=vidBBBBBBB"
URL_C = "https://www.youtube.com/watch?v=vidCCCCCCC"


def _add_match(db: Path, *, tournament: str = "PPA Test Open") -> MatchId:
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


def _video_id_for_url(url: str) -> str:
    if "v=" in url:
        return url.split("v=", 1)[1].split("&", 1)[0]
    return "vidDEFAULT"


class FakeStreamRunner:
    """Fake `StreamRunner` that feeds recorded yt-dlp and ffmpeg progress lines and supports
    blocking gates and cancellation."""

    def __init__(
        self,
        *,
        ext: str = "mkv",
        duration_s: float = 100.0,
        audio_codec: str = "opus",
        download_lines: Sequence[str] = (
            f"{PROGRESS_PREFIX} 25.0%|  4.50MiB/s|00:30",
            f"{PROGRESS_PREFIX} 75.5%|  5.20MiB/s|00:10",
            f"{PROGRESS_PREFIX}100.0%|  5.10MiB/s|00:00",
        ),
        ffmpeg_lines: Sequence[str] = (
            "frame=1500",
            "out_time_us=25000000",
            "progress=continue",
            "frame=4500",
            "out_time_us=75000000",
            "progress=continue",
            "frame=6000",
            "out_time_us=100000000",
            "progress=end",
        ),
        download_error: str | None = None,
        convert_error: str | None = None,
        on_download_start: Callable[[str, Path, threading.Event | None], None] | None = None,
        on_convert_start: Callable[[Path, Path, threading.Event | None], None] | None = None,
    ) -> None:
        self.ext = ext
        self.duration_s = duration_s
        self.audio_codec = audio_codec
        self.download_lines = list(download_lines)
        self.ffmpeg_lines = list(ffmpeg_lines)
        self.download_error = download_error
        self.convert_error = convert_error
        self.on_download_start = on_download_start
        self.on_convert_start = on_convert_start
        self.calls: list[list[str]] = []
        self._lock = threading.Lock()

    @property
    def download_calls(self) -> list[list[str]]:
        with self._lock:
            return [c for c in self.calls if c[0] == "yt-dlp" and "--skip-download" not in c]

    @property
    def convert_calls(self) -> list[list[str]]:
        with self._lock:
            return [c for c in self.calls if c[0] == "ffmpeg"]

    def __call__(
        self,
        args: Sequence[str],
        *,
        on_stdout_line: LineCallback | None = None,
        on_stderr_line: LineCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> subprocess.CompletedProcess[str]:
        cmd = list(args)
        with self._lock:
            self.calls.append(cmd)

        if cancel is not None and cancel.is_set():
            raise CommandCancelledError("cancelled")

        if cmd[0] == "yt-dlp" and "--skip-download" in cmd:
            if self.download_error is not None:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=self.download_error)
            url = cmd[-1]
            vid = _video_id_for_url(url)
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{vid}\n", stderr="")

        if cmd[0] == "yt-dlp":
            url = cmd[-1]
            vid = _video_id_for_url(url)
            footage_dir = Path(cmd[cmd.index("-P") + 1])
            part_file = footage_dir / f"{vid}.{self.ext}.part"
            part_file.write_bytes(b"partial-download-data")

            if self.download_lines and on_stdout_line is not None:
                on_stdout_line(self.download_lines[0])
            if self.on_download_start is not None:
                self.on_download_start(vid, part_file, cancel)
            if cancel is not None and cancel.is_set():
                raise CommandCancelledError("cancelled during download")
            if self.download_error is not None:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=self.download_error)
            for line in self.download_lines[1:]:
                if cancel is not None and cancel.is_set():
                    raise CommandCancelledError("cancelled during download")
                if on_stdout_line is not None:
                    on_stdout_line(line)
            target = footage_dir / f"{vid}.{self.ext}"
            part_file.unlink(missing_ok=True)
            target.write_bytes(b"downloaded-video-bytes")
            stdout = "\n".join([*self.download_lines, str(target)]) + "\n"
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

        if cmd[0] == "ffprobe":
            payload = {
                "streams": [
                    {"codec_type": "video", "codec_name": "h264", "duration": str(self.duration_s)},
                    {"codec_type": "audio", "codec_name": self.audio_codec},
                ],
                "format": {"duration": str(self.duration_s)},
            }
            return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(payload), stderr="")

        if cmd[0] == "ffmpeg":
            source_path = Path(cmd[cmd.index("-i") + 1])
            temp_out = Path(cmd[-1])
            temp_out.write_bytes(b"partial-encode-bytes")

            if self.ffmpeg_lines and on_stdout_line is not None:
                for line in self.ffmpeg_lines[:3]:
                    on_stdout_line(line)
            if self.on_convert_start is not None:
                self.on_convert_start(source_path, temp_out, cancel)
            if cancel is not None and cancel.is_set():
                raise CommandCancelledError("cancelled during convert")
            if self.convert_error is not None:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=self.convert_error)
            for line in self.ffmpeg_lines[3:]:
                if cancel is not None and cancel.is_set():
                    raise CommandCancelledError("cancelled during convert")
                if on_stdout_line is not None:
                    on_stdout_line(line)
            temp_out.write_bytes(b"converted-60fps-mp4-bytes")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        raise AssertionError(f"Unexpected command: {cmd}")


def _wait_until(predicate: Callable[[], bool], *, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Timed out waiting for condition")


# --- Streaming progress & CLI output ------------------------------------------------------


def test_parse_yt_dlp_progress_handles_ansi_and_unknown_values() -> None:
    assert parse_yt_dlp_progress("not a progress line") is None
    assert parse_yt_dlp_progress(
        f"\x1b[0;32m{PROGRESS_PREFIX} 42.3%|  5.23MiB/s|00:42\x1b[0m"
    ) == DownloadProgress(percent=42.3, speed="5.23MiB/s", eta="00:42")
    assert parse_yt_dlp_progress(f"{PROGRESS_PREFIX}  N/A|Unknown B/s|Unknown") == DownloadProgress(
        percent=None, speed=None, eta=None
    )


def test_streaming_runner_reports_download_and_convert_progress_and_cli_prints_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    footage_dir = tmp_path / "footage"
    runner = FakeStreamRunner()

    dl_events: list[DownloadProgress] = []
    dl = download_footage(URL_A, footage_dir, run=runner, on_progress=dl_events.append)
    assert dl_events == [
        DownloadProgress(percent=25.0, speed="4.50MiB/s", eta="00:30"),
        DownloadProgress(percent=75.5, speed="5.20MiB/s", eta="00:10"),
        DownloadProgress(percent=100.0, speed="5.10MiB/s", eta="00:00"),
    ]

    cv_events: list[ConvertProgress] = []
    convert_footage(dl.source_video.path, run=runner, on_progress=cv_events.append)
    assert cv_events == [
        ConvertProgress(percent=25.0),
        ConvertProgress(percent=75.0),
        ConvertProgress(percent=100.0),
    ]

    # CLI `pb-tokei download` prints updating download and convert progress lines to stderr.
    cli_dir = tmp_path / "cli_footage"
    code = main(["download", URL_B, "--footage-dir", str(cli_dir)], run=FakeStreamRunner())
    captured = capsys.readouterr()
    assert code == 0
    assert "Downloading 25.0% (4.50MiB/s, ETA 00:30)" in captured.err
    assert "Downloading 100.0% (5.10MiB/s, ETA 00:00)" in captured.err
    assert "Converting 25.0%" in captured.err
    assert "Converting 100.0%" in captured.err


# --- FootageJobService: queue, cancel, failure, shared broadcast --------------------------


def test_footage_queue_runs_one_at_a_time_in_fifo_order(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    m1, m2, m3 = _add_match(db), _add_match(db), _add_match(db)

    order: list[str] = []
    first_entered = threading.Event()
    release_first = threading.Event()

    def on_dl(vid: str, _part: Path, _cancel: threading.Event | None) -> None:
        order.append(vid)
        if vid == _video_id_for_url(URL_A):
            first_entered.set()
            release_first.wait(timeout=5.0)

    service = FootageJobService(db, runner=FakeStreamRunner(on_download_start=on_dl))
    try:
        service.enqueue(m1, url=URL_A)
        assert first_entered.wait(timeout=2.0)

        s2 = service.enqueue(m2, url=URL_B)
        s3 = service.enqueue(m3, url=URL_C)

        assert service.status(m1).state is FootageJobState.DOWNLOADING
        assert service.status(m1).percent == 25.0
        assert service.status(m1).speed == "4.50MiB/s"
        assert service.status(m1).eta == "00:30"
        assert s2.state is FootageJobState.QUEUED and s2.queue_position == 1
        assert s3.state is FootageJobState.QUEUED and s3.queue_position == 2

        release_first.set()
        assert service.wait_for(m1)
        assert service.wait_for(m2)
        assert service.wait_for(m3)

        assert order == [
            _video_id_for_url(URL_A),
            _video_id_for_url(URL_B),
            _video_id_for_url(URL_C),
        ]
        assert service.status(m1).state is FootageJobState.IDLE
        assert service.status(m2).state is FootageJobState.IDLE
        assert service.status(m3).state is FootageJobState.IDLE
    finally:
        release_first.set()
        service.close()


def test_cancel_while_queued_removes_from_queue_and_shifts_positions(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    m1, m2, m3 = _add_match(db), _add_match(db), _add_match(db)

    order: list[str] = []
    first_entered = threading.Event()
    release_first = threading.Event()

    def on_dl(vid: str, _part: Path, _cancel: threading.Event | None) -> None:
        order.append(vid)
        if vid == _video_id_for_url(URL_A):
            first_entered.set()
            release_first.wait(timeout=5.0)

    service = FootageJobService(db, runner=FakeStreamRunner(on_download_start=on_dl))
    try:
        service.enqueue(m1, url=URL_A)
        assert first_entered.wait(timeout=2.0)
        service.enqueue(m2, url=URL_B)
        service.enqueue(m3, url=URL_C)
        assert service.status(m3).queue_position == 2

        cancelled = service.cancel(m2)
        assert cancelled.state is FootageJobState.IDLE
        assert service.status(m2).state is FootageJobState.IDLE
        assert service.status(m3).queue_position == 1

        release_first.set()
        assert service.wait_for(m1)
        assert service.wait_for(m3)
        assert order == [_video_id_for_url(URL_A), _video_id_for_url(URL_C)]
    finally:
        release_first.set()
        service.close()


def test_cancel_while_downloading_keeps_part_file_and_advances_queue(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    m1, m2 = _add_match(db), _add_match(db)

    entered = threading.Event()
    part_paths: list[Path] = []

    def on_dl(vid: str, part: Path, cancel: threading.Event | None) -> None:
        if vid == _video_id_for_url(URL_A):
            part_paths.append(part)
            entered.set()
            assert cancel is not None
            cancel.wait(timeout=5.0)

    service = FootageJobService(db, runner=FakeStreamRunner(on_download_start=on_dl))
    try:
        service.enqueue(m1, url=URL_A)
        assert entered.wait(timeout=2.0)
        service.enqueue(m2, url=URL_B)

        cancelled = service.cancel(m1)
        assert cancelled.state is FootageJobState.IDLE
        assert service.wait_for(m2)

        # .part file was preserved so a subsequent fetch resumes; m1 has no SourceVideo recorded.
        assert len(part_paths) == 1 and part_paths[0].is_file()
        with RallyLog.open(db) as log:
            assert log.load_match(m1).source_video is None
            assert log.load_match(m2).source_video is not None
        assert (tmp_path / "footage" / f"{_video_id_for_url(URL_B)}.60fps.mp4").is_file()
    finally:
        service.close()


def test_cancel_while_converting_deletes_temp_file_and_advances_queue(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    m1, m2 = _add_match(db), _add_match(db)

    convert_entered = threading.Event()
    temp_paths: list[Path] = []

    def on_cv(source: Path, temp_out: Path, cancel: threading.Event | None) -> None:
        if _video_id_for_url(URL_A) in source.name:
            temp_paths.append(temp_out)
            convert_entered.set()
            assert cancel is not None
            cancel.wait(timeout=5.0)

    service = FootageJobService(db, runner=FakeStreamRunner(on_convert_start=on_cv))
    try:
        service.enqueue(m1, url=URL_A)
        assert convert_entered.wait(timeout=2.0)
        assert service.status(m1).state is FootageJobState.CONVERTING
        assert service.status(m1).percent == 25.0

        service.enqueue(m2, url=URL_B)
        service.cancel(m1)
        assert service.wait_for(m2)

        # ffmpeg temp file was deleted; SourceVideo was already recorded before conversion.
        assert len(temp_paths) == 1 and not temp_paths[0].exists()
        assert not (tmp_path / "footage" / f"{_video_id_for_url(URL_A)}.60fps.mp4").exists()
        with RallyLog.open(db) as log:
            assert log.load_match(m1).source_video is not None
        assert (tmp_path / "footage" / f"{_video_id_for_url(URL_B)}.60fps.mp4").is_file()
    finally:
        service.close()


def test_failure_mid_conversion_leaves_source_video_recorded_and_retries_convert_only(
    tmp_path: Path,
) -> None:
    db = tmp_path / "log.duckdb"
    match_id = _add_match(db)
    runner = FakeStreamRunner(convert_error="x264 encoder crashed\ndisk full")
    client = TestClient(
        create_app(db, footage_runner=runner),
        base_url=LOCAL,
        headers={"Origin": LOCAL},
    )

    started = client.post(f"/api/matches/{match_id}/footage/fetch", json={"url": URL_A})
    assert started.status_code == 200

    _wait_until(lambda: client.get(f"/api/matches/{match_id}/footage").json()["state"] == "error")

    err = client.get(f"/api/matches/{match_id}/footage").json()
    assert err["state"] == "error"
    assert "x264 encoder crashed" in err["error"]
    assert err["stderr_tail"] is not None and "disk full" in err["stderr_tail"]

    # SourceVideo was recorded before conversion, so Match is not_converted with original on disk.
    detail = client.get(f"/api/matches/{match_id}").json()
    assert detail["video_status"] == "not_converted"
    assert detail["original_present"] is True
    assert detail["source_url"] == URL_A
    assert detail["fix_command"].startswith("pb-tokei convert ")
    assert detail["footage_job"] == {"state": "error", "queue_position": None, "percent": None}

    with RallyLog.open(db) as log:
        assert log.load_match(match_id).source_video == SourceVideo(
            url=URL_A,
            video_id=_video_id_for_url(URL_A),
            path=Path("footage") / f"{_video_id_for_url(URL_A)}.mkv",
        )

    # Retrying with no URL goes straight to conversion without calling yt-dlp again.
    dl_count_before = len(runner.download_calls)
    runner.convert_error = None
    retry = client.post(f"/api/matches/{match_id}/footage/fetch", json={})
    assert retry.status_code == 200
    _wait_until(lambda: client.get(f"/api/matches/{match_id}").json()["video_status"] == "ready")

    assert len(runner.download_calls) == dl_count_before
    assert client.get(f"/api/matches/{match_id}/footage").json()["state"] == "idle"


def test_replacing_url_only_updates_source_video_after_download_succeeds(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    match_id = _add_match(db)
    footage_dir = tmp_path / "footage"
    footage_dir.mkdir()
    old_orig = footage_dir / f"{_video_id_for_url(URL_A)}.mkv"
    old_conv = footage_dir / f"{_video_id_for_url(URL_A)}.60fps.mp4"
    old_orig.write_bytes(b"old-orig")
    old_conv.write_bytes(b"old-conv")
    with RallyLog.open(db) as log:
        log.set_match_source_video(
            match_id,
            SourceVideo(URL_A, _video_id_for_url(URL_A), Path(f"footage/{old_orig.name}")),
        )

    runner = FakeStreamRunner(download_error="ERROR: Video unavailable")
    client = TestClient(
        create_app(db, footage_runner=runner),
        base_url=LOCAL,
        headers={"Origin": LOCAL},
    )

    # Failed download for a new URL leaves the existing SourceVideo untouched.
    client.post(f"/api/matches/{match_id}/footage/fetch", json={"url": URL_B})
    _wait_until(lambda: client.get(f"/api/matches/{match_id}/footage").json()["state"] == "error")
    with RallyLog.open(db) as log:
        assert log.load_match(match_id).source_video == SourceVideo(
            URL_A, _video_id_for_url(URL_A), Path(f"footage/{old_orig.name}")
        )

    # Successful download for URL_B replaces SourceVideo and leaves old files on disk alone.
    runner.download_error = None
    client.post(f"/api/matches/{match_id}/footage/fetch", json={"url": URL_B})
    _wait_until(lambda: client.get(f"/api/matches/{match_id}").json()["source_url"] == URL_B)
    _wait_until(lambda: client.get(f"/api/matches/{match_id}/footage").json()["state"] == "idle")

    assert old_orig.is_file()
    assert old_conv.is_file()
    assert (footage_dir / f"{_video_id_for_url(URL_B)}.60fps.mp4").is_file()


def test_two_matches_sharing_video_id_share_one_file_and_skip_redownload(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    m1, m2 = _add_match(db), _add_match(db)
    runner = FakeStreamRunner()
    client = TestClient(
        create_app(db, footage_runner=runner),
        base_url=LOCAL,
        headers={"Origin": LOCAL},
    )

    assert client.post(f"/api/matches/{m1}/footage/fetch", json={"url": URL_A}).status_code == 200
    assert client.post(f"/api/matches/{m2}/footage/fetch", json={"url": URL_A}).status_code == 200

    _wait_until(
        lambda: (
            client.get(f"/api/matches/{m1}").json()["video_status"] == "ready"
            and client.get(f"/api/matches/{m2}").json()["video_status"] == "ready"
        )
    )

    # Only one yt-dlp download and one ffmpeg encode happened across both Matches.
    assert len(runner.download_calls) == 1
    assert len(runner.convert_calls) == 1
    with RallyLog.open(db) as log:
        assert log.load_match(m1).source_video == log.load_match(m2).source_video


# --- Endpoints, cookies state, hints, Rally Log switch ------------------------------------


def test_footage_endpoints_cookies_validation_and_match_list_summary(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    match_id = _add_match(db)
    entered = threading.Event()
    release = threading.Event()

    def on_dl(_vid: str, _part: Path, _cancel: threading.Event | None) -> None:
        entered.set()
        release.wait(timeout=5.0)

    runner = FakeStreamRunner(on_download_start=on_dl)
    client = TestClient(
        create_app(db, footage_runner=runner),
        base_url=LOCAL,
        headers={"Origin": LOCAL},
    )

    # 404 for unknown Match.
    unknown = uuid4()
    assert client.get(f"/api/matches/{unknown}/footage").status_code == 404
    assert (
        client.post(f"/api/matches/{unknown}/footage/fetch", json={"url": URL_A}).status_code == 404
    )
    assert client.post(f"/api/matches/{unknown}/footage/cancel").status_code == 404

    # 422 for missing URL on Match without SourceVideo, bad URL, bad cookies spec.
    assert client.post(f"/api/matches/{match_id}/footage/fetch", json={}).status_code == 422
    assert (
        client.post(f"/api/matches/{match_id}/footage/fetch", json={"url": "not-a-url"}).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/matches/{match_id}/footage/fetch",
            json={"url": URL_A, "cookies_from_browser": "--exec=bad"},
        ).status_code
        == 422
    )
    assert read_cookies_from_browser() is None

    # Fetch with cookies_from_browser persists to state.json and passes it to yt-dlp.
    resp = client.post(
        f"/api/matches/{match_id}/footage/fetch",
        json={"url": URL_A, "cookies_from_browser": "chrome:Profile 1"},
    )
    assert resp.status_code == 200
    assert read_cookies_from_browser() == "chrome:Profile 1"
    assert entered.wait(timeout=2.0)

    # MatchOut in GET /api/matches includes short footage_job summary while active.
    listing = client.get("/api/matches").json()
    assert listing[0]["footage_job"] == {
        "state": "downloading",
        "queue_position": None,
        "percent": 25.0,
    }

    # Conflicting fetch with different URL while active gets 409.
    conflict = client.post(f"/api/matches/{match_id}/footage/fetch", json={"url": URL_B})
    assert conflict.status_code == 409

    # GET /api/matches/{id}/footage returns full progress and remembered cookies.
    status = client.get(f"/api/matches/{match_id}/footage").json()
    assert status["state"] == "downloading"
    assert status["percent"] == 25.0
    assert status["speed"] == "4.50MiB/s"
    assert status["eta"] == "00:30"
    assert status["cookies_from_browser"] == "chrome:Profile 1"

    # Cancel stops it and returns idle; clearing cookies to null persists null.
    release.set()
    cancel_resp = client.post(f"/api/matches/{match_id}/footage/cancel")
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["state"] == "idle"
    assert "--cookies-from-browser" in runner.download_calls[0]
    assert "chrome:Profile 1" in runner.download_calls[0]

    # Stale X-Rally-Log header is rejected with 409.
    stale_headers = {"X-Rally-Log": quote(str((tmp_path / "other.duckdb").resolve()))}
    assert client.get(f"/api/matches/{match_id}/footage", headers=stale_headers).status_code == 409


@pytest.mark.parametrize(
    ("error_message", "expected_substring"),
    [
        ("yt-dlp failed: ERROR: Sign in to confirm you're not a bot", "Cookies from"),
        ("yt-dlp failed: Use --cookies-from-browser to authenticate", "Cookies from"),
        (
            "yt-dlp is not installed or not on PATH; install yt-dlp and try again",
            "https://github.com/yt-dlp/yt-dlp",
        ),
        (
            "ffmpeg is not installed or not on PATH; install ffmpeg and try again",
            "https://ffmpeg.org/download.html",
        ),
        (
            "ffprobe is not installed or not on PATH; install ffmpeg and try again",
            "https://ffmpeg.org/download.html",
        ),
        ("yt-dlp failed: ERROR: Unsupported URL: https://example.com", "brew upgrade yt-dlp"),
        ("yt-dlp failed: ERROR: HTTP Error 403: Forbidden", "yt-dlp -U"),
        ("yt-dlp failed: ERROR: Video unavailable", "yt-dlp -U"),
        (
            "URL resolved to multiple videos; pass a single video URL: https://example.com",
            "single video URL",
        ),
    ],
)
def test_error_hints_cover_all_known_failures(error_message: str, expected_substring: str) -> None:
    hint = footage_error_hint(error_message)
    assert hint is not None
    assert expected_substring in hint


def test_duplicate_stem_error_keeps_existing_message_without_extra_hint() -> None:
    msg = (
        "Multiple source videos share output name clip.60fps.mp4: clip.mkv, clip.mp4; "
        "remove or rename duplicates before converting"
    )
    assert footage_error_hint(msg) is None


def test_switching_rally_log_cancels_footage_jobs(tmp_path: Path) -> None:
    db = tmp_path / "one.duckdb"
    other = tmp_path / "two.duckdb"
    match_id = _add_match(db)
    _add_match(other)

    entered = threading.Event()
    cancelled_seen = threading.Event()

    def on_dl(_vid: str, _part: Path, cancel: threading.Event | None) -> None:
        entered.set()
        assert cancel is not None
        if cancel.wait(timeout=5.0):
            cancelled_seen.set()

    client = TestClient(
        create_app(db, footage_runner=FakeStreamRunner(on_download_start=on_dl)),
        base_url=LOCAL,
        headers={"Origin": LOCAL},
    )
    assert (
        client.post(f"/api/matches/{match_id}/footage/fetch", json={"url": URL_A}).status_code
        == 200
    )
    assert entered.wait(timeout=2.0)

    switched = client.post("/api/rally-log", json={"path": str(other), "create": False})
    assert switched.status_code == 200
    assert cancelled_seen.wait(timeout=2.0)


def test_cookies_preference_is_remembered_in_state_and_cleared_on_null(tmp_path: Path) -> None:
    db = tmp_path / "log.duckdb"
    match_id = _add_match(db)
    write_cookies_from_browser("firefox")

    client = TestClient(
        create_app(db, footage_runner=FakeStreamRunner()),
        base_url=LOCAL,
        headers={"Origin": LOCAL},
    )
    assert (
        client.get(f"/api/matches/{match_id}/footage").json()["cookies_from_browser"] == "firefox"
    )

    client.post(
        f"/api/matches/{match_id}/footage/fetch",
        json={"url": URL_A, "cookies_from_browser": None},
    )
    assert read_cookies_from_browser() is None


# --- Cross-site Origin check --------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_origin",
    [
        None,
        "https://evil.example",
        "http://evil.example:8000",
        "http://127.0.0.1:9999",
        "http://localhost:9999",
        "https://127.0.0.1:8000",
        "null",
    ],
)
def test_origin_check_rejects_foreign_and_missing_origin_on_post_put_delete(
    tmp_path: Path, bad_origin: str | None
) -> None:
    db = tmp_path / "log.duckdb"
    match_id = _add_match(db)
    raw_client = TestClient(
        create_app(db, footage_runner=FakeStreamRunner()),
        base_url="http://127.0.0.1:8000",
    )
    headers = {} if bad_origin is None else {"Origin": bad_origin}

    post_fetch = raw_client.post(
        f"/api/matches/{match_id}/footage/fetch",
        json={"url": URL_A},
        headers=headers,
    )
    put_segments = raw_client.put(
        f"/api/matches/{match_id}/play-segments",
        json=[],
        headers=headers,
    )
    delete_req = raw_client.delete(
        f"/api/matches/{match_id}/play-segments",
        headers=headers,
    )

    assert post_fetch.status_code == 403
    assert put_segments.status_code == 403
    assert delete_req.status_code == 403


@pytest.mark.parametrize(
    ("host", "origin"),
    [
        ("127.0.0.1:8000", "http://127.0.0.1:8000"),
        ("127.0.0.1:8000", "http://localhost:8000"),
        ("localhost:5173", "http://localhost:5173"),
        ("localhost:5173", "http://127.0.0.1:5173"),
    ],
)
def test_origin_check_allows_app_origins_and_get_without_origin(
    tmp_path: Path, host: str, origin: str
) -> None:
    db = tmp_path / "log.duckdb"
    match_id = _add_match(db)
    raw_client = TestClient(
        create_app(db, footage_runner=FakeStreamRunner()),
        base_url=f"http://{host}",
    )

    assert raw_client.get("/api/matches", headers={"Host": host}).status_code == 200
    put_resp = raw_client.put(
        f"/api/matches/{match_id}/play-segments",
        json=[],
        headers={"Host": host, "Origin": origin},
    )
    assert put_resp.status_code == 200
