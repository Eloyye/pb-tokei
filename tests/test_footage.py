import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest

from pb_tokei import main
from pb_tokei.footage import (
    FORMAT_SELECTOR,
    FORMAT_SORT,
    FootageDownloadError,
    download_footage,
    find_existing_footage,
    probe_video_id,
)
from pb_tokei.rally_log import (
    Handedness,
    Match,
    MatchId,
    Player,
    PlayerId,
    RallyLog,
    SourceVideo,
    Team,
    TeamId,
    Tour,
    Tournament,
    TournamentId,
    new_id,
)

SAMPLE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
SAMPLE_SHORT_URL = "https://youtu.be/dQw4w9WgXcQ?t=15"
SAMPLE_ID = "dQw4w9WgXcQ"


class FakeYtDlp:
    """Test double for yt-dlp (and optional ffprobe/ffmpeg) CLI invocations."""

    def __init__(
        self,
        *,
        video_id: str = SAMPLE_ID,
        ext: str = "mkv",
        content: bytes = b"fake-60fps-video-bytes",
        print_absolute_path: bool = False,
        audio_codec: str = "opus",
        converted_content: bytes = b"fake-converted-60fps-mp4",
        convert_error: str | None = None,
    ) -> None:
        self.video_id = video_id
        self.ext = ext
        self.content = content
        self.print_absolute_path = print_absolute_path
        self.audio_codec = audio_codec
        self.converted_content = converted_content
        self.convert_error = convert_error
        self.calls: list[list[str]] = []

    @property
    def probe_calls(self) -> list[list[str]]:
        return [call for call in self.calls if call[0] == "yt-dlp" and "--skip-download" in call]

    @property
    def download_calls(self) -> list[list[str]]:
        return [
            call for call in self.calls if call[0] == "yt-dlp" and "--skip-download" not in call
        ]

    @property
    def convert_calls(self) -> list[list[str]]:
        return [call for call in self.calls if call[0] == "ffmpeg"]

    def __call__(self, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        cmd = list(args)
        self.calls.append(cmd)
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{self.audio_codec}\n", stderr="")
        if cmd[0] == "ffmpeg":
            if self.convert_error is not None:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=self.convert_error)
            Path(cmd[-1]).write_bytes(self.converted_content)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        if "--skip-download" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{self.video_id}\n", stderr="")

        output_dir = Path(cmd[cmd.index("-P") + 1])
        target = output_dir / f"{self.video_id}.{self.ext}"
        target.write_bytes(self.content)
        printed = target.resolve() if self.print_absolute_path else target
        return subprocess.CompletedProcess(cmd, 0, stdout=f"{printed}\n", stderr="")


def _create_match_in_db(db_path: Path) -> Match:
    tournament = Tournament(TournamentId(new_id()), "Test Open", Tour.PPA)
    players = [Player(PlayerId(new_id()), f"Player {i}", Handedness.RIGHT) for i in range(1, 5)]
    team_a = Team(TeamId(new_id()), (players[0].id, players[1].id))
    team_b = Team(TeamId(new_id()), (players[2].id, players[3].id))
    match = Match(
        id=MatchId(new_id()),
        tournament_id=tournament.id,
        team_a_id=team_a.id,
        team_b_id=team_b.id,
    )
    with RallyLog.open(db_path) as log:
        log.save_tournament(tournament)
        for player in players:
            log.save_player(player)
        log.save_team(team_a)
        log.save_team(team_b)
        log.save_match(match)
    return match


# --- download_footage ---------------------------------------------------------------------


def test_download_footage_prefers_highest_fps_and_returns_path(tmp_path: Path) -> None:
    footage_dir = tmp_path / "footage"
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")

    result = download_footage(SAMPLE_URL, footage_dir, run=fake)

    expected_path = footage_dir / f"{SAMPLE_ID}.mkv"
    assert result.already_downloaded is False
    assert result.source_video == SourceVideo(
        url=SAMPLE_URL, video_id=SAMPLE_ID, path=expected_path
    )
    assert expected_path.is_file()

    assert len(fake.download_calls) == 1
    dl_cmd = fake.download_calls[0]
    assert dl_cmd[0] == "yt-dlp"
    assert "--no-playlist" in dl_cmd
    assert "--no-overwrites" in dl_cmd
    assert "--no-simulate" in dl_cmd
    assert dl_cmd[dl_cmd.index("-f") + 1] == FORMAT_SELECTOR
    assert dl_cmd[dl_cmd.index("-S") + 1] == FORMAT_SORT
    assert dl_cmd[dl_cmd.index("-P") + 1] == str(footage_dir)
    assert dl_cmd[dl_cmd.index("-o") + 1] == "%(id)s.%(ext)s"
    assert dl_cmd[-2:] == ["--", SAMPLE_URL]
    for cmd in (fake.probe_calls[0], dl_cmd):
        assert not any(arg.startswith(("--cookies", "--no-cookies")) for arg in cmd)


def test_running_download_again_for_same_video_does_not_download_twice(tmp_path: Path) -> None:
    footage_dir = tmp_path / "footage"
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="webm")

    first = download_footage(SAMPLE_URL, footage_dir, run=fake)
    second = download_footage(SAMPLE_SHORT_URL, footage_dir, run=fake)

    assert first.already_downloaded is False
    assert second.already_downloaded is True
    assert second.source_video.path == first.source_video.path
    assert second.source_video.video_id == SAMPLE_ID
    assert second.source_video.url == SAMPLE_SHORT_URL
    assert len(fake.download_calls) == 1


def test_existing_footage_ignores_partial_converted_and_empty_files(tmp_path: Path) -> None:
    footage_dir = tmp_path / "footage"
    footage_dir.mkdir()
    (footage_dir / f"{SAMPLE_ID}.mp4.part").write_bytes(b"partial")
    (footage_dir / f"{SAMPLE_ID}.f299.mp4").write_bytes(b"video-only-stream")
    (footage_dir / f"{SAMPLE_ID}.60fps.mp4").write_bytes(b"converted-file")
    (footage_dir / f"{SAMPLE_ID}.json").write_text("{}")
    (footage_dir / f"{SAMPLE_ID}.mp4").write_bytes(b"")  # empty file

    assert find_existing_footage(footage_dir, SAMPLE_ID) is None

    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mp4")
    result = download_footage(SAMPLE_URL, footage_dir, run=fake)
    assert result.already_downloaded is False
    assert len(fake.download_calls) == 1
    assert find_existing_footage(footage_dir, SAMPLE_ID) == footage_dir / f"{SAMPLE_ID}.mp4"


def test_download_returns_consistent_relative_path_across_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mp4", print_absolute_path=True)

    first = download_footage(SAMPLE_URL, Path("footage"), run=fake)
    second = download_footage(SAMPLE_URL, Path("footage"), run=fake)

    assert first.source_video.path == Path("footage") / f"{SAMPLE_ID}.mp4"
    assert second.source_video.path == first.source_video.path


@pytest.mark.parametrize(
    "bad_url",
    [
        "",
        "   ",
        "not-a-url",
        "--exec=rm -rf /",
        "file:///etc/passwd",
        "https://example.com/watch?v=1\n--exec=bad",
        "https://",
    ],
)
def test_rejects_invalid_urls_without_running_yt_dlp(tmp_path: Path, bad_url: str) -> None:
    fake = FakeYtDlp()

    with pytest.raises(FootageDownloadError, match="http\\(s\\) URL"):
        download_footage(bad_url, tmp_path / "footage", run=fake)

    assert fake.calls == []


def test_rejects_playlist_resolving_to_multiple_videos(tmp_path: Path) -> None:
    def multi_id_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 0, stdout="id_one\nid_two\n", stderr="")

    with pytest.raises(FootageDownloadError, match="multiple videos"):
        download_footage(
            "https://www.youtube.com/playlist?list=PL123", tmp_path, run=multi_id_runner
        )


@pytest.mark.parametrize("bad_id", ["..", ".", "../escape", "sub/id", "sub\\id", ".hidden"])
def test_rejects_path_traversal_video_ids(tmp_path: Path, bad_id: str) -> None:
    def bad_id_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 0, stdout=f"{bad_id}\n", stderr="")

    with pytest.raises(FootageDownloadError, match="Invalid video ID"):
        download_footage(SAMPLE_URL, tmp_path / "footage", run=bad_id_runner)


def test_rejects_downloaded_file_outside_footage_dir(tmp_path: Path) -> None:
    footage_dir = tmp_path / "footage"
    escaped = tmp_path / f"{SAMPLE_ID}.mp4"
    escaped.write_bytes(b"escaped")

    def escaping_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        cmd = list(args)
        if "--skip-download" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{SAMPLE_ID}\n", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout=f"{escaped}\n", stderr="")

    with pytest.raises(FootageDownloadError, match="not a file inside"):
        download_footage(SAMPLE_URL, footage_dir, run=escaping_runner)


def test_rejects_empty_downloaded_file(tmp_path: Path) -> None:
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mp4", content=b"")

    with pytest.raises(FootageDownloadError, match="empty"):
        download_footage(SAMPLE_URL, tmp_path / "footage", run=fake)


def test_surfaces_yt_dlp_failure_message(tmp_path: Path) -> None:
    def failing_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            list(args), 1, stdout="", stderr="ERROR: Video unavailable"
        )

    with pytest.raises(FootageDownloadError, match="Video unavailable"):
        download_footage(SAMPLE_URL, tmp_path / "footage", run=failing_runner)


def test_falls_back_to_exit_status_when_yt_dlp_stderr_is_empty(tmp_path: Path) -> None:
    def silent_failure_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 2, stdout="", stderr="   ")

    with pytest.raises(FootageDownloadError, match="exit status 2"):
        download_footage(SAMPLE_URL, tmp_path / "footage", run=silent_failure_runner)


def test_rejects_empty_video_id_from_probe(tmp_path: Path) -> None:
    def empty_probe_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 0, stdout="\n", stderr="")

    with pytest.raises(FootageDownloadError, match="did not return a video ID"):
        download_footage(SAMPLE_URL, tmp_path / "footage", run=empty_probe_runner)


@pytest.mark.parametrize("download_stdout", ["", "   \n", "/tmp/one.mp4\n/tmp/two.mp4\n"])
def test_rejects_unexpected_filepath_output_from_download(
    tmp_path: Path, download_stdout: str
) -> None:
    def bad_filepath_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        cmd = list(args)
        if "--skip-download" in cmd:
            return subprocess.CompletedProcess(cmd, 0, stdout=f"{SAMPLE_ID}\n", stderr="")
        return subprocess.CompletedProcess(cmd, 0, stdout=download_stdout, stderr="")

    with pytest.raises(FootageDownloadError, match="unexpected filepath output"):
        download_footage(SAMPLE_URL, tmp_path / "footage", run=bad_filepath_runner)


def test_raises_clear_error_when_yt_dlp_binary_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def missing_binary(*args: object, **kwargs: object) -> subprocess.Popen[bytes]:
        raise FileNotFoundError("No such file or directory: 'yt-dlp'")

    monkeypatch.setattr(subprocess, "Popen", missing_binary)

    with pytest.raises(FootageDownloadError, match="yt-dlp is not installed"):
        download_footage(SAMPLE_URL, tmp_path / "footage")


def test_rejects_footage_dir_that_is_a_file(tmp_path: Path) -> None:
    not_a_dir = tmp_path / "footage"
    not_a_dir.write_text("not a directory")
    fake = FakeYtDlp()

    with pytest.raises(FootageDownloadError, match="not a directory"):
        download_footage(SAMPLE_URL, not_a_dir, run=fake)

    assert fake.calls == []


def test_download_footage_forwards_cookies_file_to_probe_and_download(tmp_path: Path) -> None:
    footage_dir = tmp_path / "footage"
    cookies_file = tmp_path / "cookies.txt"
    cookies_file.write_text("# Netscape HTTP Cookie File\n")
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")

    result = download_footage(SAMPLE_URL, footage_dir, cookies=cookies_file, run=fake)

    assert result.already_downloaded is False
    assert len(fake.probe_calls) == 1
    assert len(fake.download_calls) == 1
    for cmd in (fake.probe_calls[0], fake.download_calls[0]):
        assert "--no-cookies-from-browser" in cmd
        assert cmd[cmd.index("--cookies") + 1] == str(cookies_file)
        assert cmd[-2:] == ["--", SAMPLE_URL]


def test_download_footage_forwards_cookies_from_browser_to_probe_and_download(
    tmp_path: Path,
) -> None:
    footage_dir = tmp_path / "footage"
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")

    result = download_footage(
        SAMPLE_URL,
        footage_dir,
        cookies_from_browser=" chrome:Profile 1 ",
        run=fake,
    )

    assert result.already_downloaded is False
    assert len(fake.probe_calls) == 1
    assert len(fake.download_calls) == 1
    for cmd in (fake.probe_calls[0], fake.download_calls[0]):
        assert "--no-cookies" in cmd
        assert cmd[cmd.index("--cookies-from-browser") + 1] == "chrome:Profile 1"
        assert cmd[-2:] == ["--", SAMPLE_URL]


def test_probe_video_id_forwards_cookie_options(tmp_path: Path) -> None:
    cookies_file = tmp_path / "cookies.txt"
    cookies_file.write_text("# Netscape HTTP Cookie File\n")
    fake = FakeYtDlp(video_id=SAMPLE_ID)

    assert probe_video_id(SAMPLE_URL, cookies=cookies_file, run=fake) == SAMPLE_ID
    assert probe_video_id(SAMPLE_URL, cookies_from_browser="firefox", run=fake) == SAMPLE_ID

    assert fake.probe_calls[0][fake.probe_calls[0].index("--cookies") + 1] == str(cookies_file)
    assert fake.probe_calls[1][fake.probe_calls[1].index("--cookies-from-browser") + 1] == "firefox"


def test_download_footage_prefixes_relative_cookies_file_starting_with_dash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    dash_file = Path("-cookies.txt")
    dash_file.write_text("# Netscape HTTP Cookie File\n")
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mp4")

    download_footage(SAMPLE_URL, Path("footage"), cookies=dash_file, run=fake)

    for cmd in (fake.probe_calls[0], fake.download_calls[0]):
        assert cmd[cmd.index("--cookies") + 1] == "./-cookies.txt"


def test_rejects_both_cookies_and_cookies_from_browser(tmp_path: Path) -> None:
    cookies_file = tmp_path / "cookies.txt"
    cookies_file.write_text("# Netscape HTTP Cookie File\n")
    fake = FakeYtDlp()

    with pytest.raises(FootageDownloadError, match="not both"):
        download_footage(
            SAMPLE_URL,
            tmp_path / "footage",
            cookies=cookies_file,
            cookies_from_browser="chrome",
            run=fake,
        )

    assert fake.calls == []


def test_rejects_missing_cookies_file(tmp_path: Path) -> None:
    fake = FakeYtDlp()

    with pytest.raises(FootageDownloadError, match="Cookies file not found"):
        download_footage(
            SAMPLE_URL,
            tmp_path / "footage",
            cookies=tmp_path / "missing.txt",
            run=fake,
        )

    assert fake.calls == []


def test_rejects_cookies_path_that_is_a_directory(tmp_path: Path) -> None:
    cookies_dir = tmp_path / "cookies_dir"
    cookies_dir.mkdir()
    fake = FakeYtDlp()

    with pytest.raises(FootageDownloadError, match="not a file"):
        download_footage(
            SAMPLE_URL,
            tmp_path / "footage",
            cookies=cookies_dir,
            run=fake,
        )

    assert fake.calls == []


def test_probe_video_id_rejects_invalid_cookie_options(tmp_path: Path) -> None:
    cookies_file = tmp_path / "cookies.txt"
    cookies_file.write_text("# Netscape HTTP Cookie File\n")
    fake = FakeYtDlp(video_id=SAMPLE_ID)

    with pytest.raises(FootageDownloadError, match="not both"):
        probe_video_id(SAMPLE_URL, cookies=cookies_file, cookies_from_browser="chrome", run=fake)

    with pytest.raises(FootageDownloadError, match="Cookies file not found"):
        probe_video_id(SAMPLE_URL, cookies=tmp_path / "missing.txt", run=fake)

    with pytest.raises(FootageDownloadError, match="Invalid --cookies-from-browser"):
        probe_video_id(SAMPLE_URL, cookies_from_browser="--exec=bad", run=fake)

    assert fake.calls == []


def test_rejects_cookies_path_with_nul_byte(tmp_path: Path) -> None:
    fake = FakeYtDlp()

    with pytest.raises(FootageDownloadError, match="contains NUL byte"):
        download_footage(
            SAMPLE_URL,
            tmp_path / "footage",
            cookies=Path("cookies\x00.txt"),
            run=fake,
        )

    assert fake.calls == []


@pytest.mark.parametrize(
    "bad_browser",
    [
        "",
        "   ",
        "-chrome",
        "--exec=rm -rf /",
        "chrome\n--exec=bad",
        "chrome\r",
        "chrome\x00",
    ],
)
def test_rejects_invalid_cookies_from_browser(tmp_path: Path, bad_browser: str) -> None:
    fake = FakeYtDlp()

    with pytest.raises(FootageDownloadError, match="Invalid --cookies-from-browser"):
        download_footage(
            SAMPLE_URL,
            tmp_path / "footage",
            cookies_from_browser=bad_browser,
            run=fake,
        )

    assert fake.calls == []


# --- CLI ----------------------------------------------------------------------------------


def test_cli_download_prints_converted_path_and_skips_second_run(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    footage_dir = tmp_path / "footage"
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")

    code1 = main(["download", SAMPLE_URL, "--footage-dir", str(footage_dir)], run=fake)
    out1 = capsys.readouterr()
    code2 = main(["download", SAMPLE_URL, "--footage-dir", str(footage_dir)], run=fake)
    out2 = capsys.readouterr()

    expected = f"{footage_dir / f'{SAMPLE_ID}.60fps.mp4'}\n"
    assert code1 == 0
    assert code2 == 0
    assert out1.out == expected
    assert out1.err == ""
    assert out2.out == expected
    assert out2.err == ""
    assert (footage_dir / f"{SAMPLE_ID}.mkv").is_file()
    assert (footage_dir / f"{SAMPLE_ID}.60fps.mp4").is_file()
    assert len(fake.download_calls) == 1
    assert len(fake.convert_calls) == 1


def test_cli_download_converts_when_original_already_exists_without_converted_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    footage_dir = tmp_path / "footage"
    footage_dir.mkdir()
    original = footage_dir / f"{SAMPLE_ID}.mkv"
    original.write_bytes(b"previously-downloaded")
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")

    code = main(["download", SAMPLE_URL, "--footage-dir", str(footage_dir)], run=fake)
    captured = capsys.readouterr()

    expected_converted = footage_dir / f"{SAMPLE_ID}.60fps.mp4"
    assert code == 0
    assert captured.out == f"{expected_converted}\n"
    assert captured.err == ""
    assert expected_converted.is_file()
    assert len(fake.download_calls) == 0
    assert len(fake.convert_calls) == 1


def test_cli_download_records_original_source_video_and_prints_converted_path(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "rally_log.duckdb"
    footage_dir = tmp_path / "footage"
    match = _create_match_in_db(db_path)
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mp4")

    code = main(
        [
            "download",
            SAMPLE_URL,
            "--footage-dir",
            str(footage_dir),
            "--match",
            str(match.id),
            "--db",
            str(db_path),
        ],
        run=fake,
    )
    captured = capsys.readouterr()

    converted_path = footage_dir / f"{SAMPLE_ID}.60fps.mp4"
    assert code == 0
    assert captured.out == f"{converted_path}\n"
    assert f"Rally Log: {db_path.resolve()}" in captured.err
    with RallyLog.open(db_path) as log:
        loaded = log.load_match(match.id)
    assert loaded.source_video == SourceVideo(
        url=SAMPLE_URL, video_id=SAMPLE_ID, path=Path("footage") / f"{SAMPLE_ID}.mp4"
    )


def test_cli_download_records_absolute_path_when_footage_is_outside_rally_log_dir(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    proj = tmp_path / "proj"
    proj.mkdir()
    db_path = proj / "rally_log.duckdb"
    external_dir = tmp_path / "external_footage"
    match = _create_match_in_db(db_path)
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mp4")

    code = main(
        [
            "download",
            SAMPLE_URL,
            "--footage-dir",
            str(external_dir),
            "--match",
            str(match.id),
            "--db",
            str(db_path),
        ],
        run=fake,
    )
    capsys.readouterr()

    assert code == 0
    with RallyLog.open(db_path) as log:
        loaded = log.load_match(match.id)
    assert loaded.source_video == SourceVideo(
        url=SAMPLE_URL,
        video_id=SAMPLE_ID,
        path=(external_dir / f"{SAMPLE_ID}.mp4").resolve(),
    )


def test_cli_download_defaults_footage_dir_to_cwd_without_match_and_rally_log_dir_with_match(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    work = tmp_path / "work"
    proj = tmp_path / "proj"
    work.mkdir()
    proj.mkdir()
    monkeypatch.chdir(work)

    # Without --match, footage goes into ./footage.
    fake_plain = FakeYtDlp(video_id=SAMPLE_ID, ext="mp4")
    code = main(["download", SAMPLE_URL], run=fake_plain)
    captured = capsys.readouterr()
    assert code == 0
    assert captured.err == ""
    assert (work / "footage" / f"{SAMPLE_ID}.mp4").is_file()

    # With --match, footage defaults to <Rally Log dir>/footage and is recorded relatively.
    db_path = proj / "rally_log.duckdb"
    match = _create_match_in_db(db_path)
    fake_match = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")
    code = main(
        ["download", SAMPLE_URL, "--match", str(match.id), "--db", str(db_path)], run=fake_match
    )
    captured = capsys.readouterr()
    assert code == 0
    assert f"Rally Log: {db_path.resolve()}" in captured.err
    assert (proj / "footage" / f"{SAMPLE_ID}.mkv").is_file()
    with RallyLog.open(db_path) as log:
        loaded = log.load_match(match.id)
    assert loaded.source_video == SourceVideo(
        url=SAMPLE_URL, video_id=SAMPLE_ID, path=Path("footage") / f"{SAMPLE_ID}.mkv"
    )


def test_cli_download_keeps_original_and_records_match_when_conversion_fails(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "rally_log.duckdb"
    footage_dir = tmp_path / "footage"
    match = _create_match_in_db(db_path)
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv", convert_error="encoder crashed")

    code = main(
        [
            "download",
            SAMPLE_URL,
            "--footage-dir",
            str(footage_dir),
            "--match",
            str(match.id),
            "--db",
            str(db_path),
        ],
        run=fake,
    )
    captured = capsys.readouterr()

    original_path = footage_dir / f"{SAMPLE_ID}.mkv"
    assert code == 1
    assert captured.out == ""
    assert "encoder crashed" in captured.err
    assert f"pb-tokei convert {original_path}" in captured.err
    assert original_path.is_file()
    assert not (footage_dir / f"{SAMPLE_ID}.60fps.mp4").exists()
    with RallyLog.open(db_path) as log:
        loaded = log.load_match(match.id)
    assert loaded.source_video == SourceVideo(
        url=SAMPLE_URL, video_id=SAMPLE_ID, path=Path("footage") / f"{SAMPLE_ID}.mkv"
    )


def test_cli_download_fails_before_downloading_when_match_is_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db_path = tmp_path / "rally_log.duckdb"
    _create_match_in_db(db_path)
    fake = FakeYtDlp()
    missing_id = str(new_id())

    code = main(
        [
            "download",
            SAMPLE_URL,
            "--footage-dir",
            str(tmp_path / "footage"),
            "--match",
            missing_id,
            "--db",
            str(db_path),
        ],
        run=fake,
    )
    captured = capsys.readouterr()

    assert code == 1
    assert captured.out == ""
    assert missing_id in captured.err
    assert fake.calls == []


def test_cli_download_fails_without_creating_missing_db(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    missing_db = tmp_path / "does_not_exist.duckdb"
    fake = FakeYtDlp()

    code = main(
        [
            "download",
            SAMPLE_URL,
            "--footage-dir",
            str(tmp_path / "footage"),
            "--match",
            str(new_id()),
            "--db",
            str(missing_db),
        ],
        run=fake,
    )
    captured = capsys.readouterr()

    assert code == 1
    assert captured.out == ""
    assert "not found" in captured.err
    assert not missing_db.exists()
    assert fake.calls == []


def test_cli_download_rejects_db_without_match(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeYtDlp()

    with pytest.raises(SystemExit) as exc_info:
        main(["download", SAMPLE_URL, "--db", str(tmp_path / "rally_log.duckdb")], run=fake)

    captured = capsys.readouterr()
    assert exc_info.value.code == 2
    assert "--db requires --match" in captured.err
    assert fake.calls == []


def test_cli_download_rejects_invalid_match_uuid(capsys: pytest.CaptureFixture[str]) -> None:
    fake = FakeYtDlp()

    with pytest.raises(SystemExit) as exc_info:
        main(["download", SAMPLE_URL, "--match", "not-a-uuid"], run=fake)

    captured = capsys.readouterr()
    assert exc_info.value.code == 2
    assert "Invalid --match UUID" in captured.err
    assert fake.calls == []


def test_cli_download_returns_nonzero_on_download_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def failing_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 1, stdout="", stderr="ERROR: network down")

    code = main(
        ["download", SAMPLE_URL, "--footage-dir", str(tmp_path / "footage")],
        run=failing_runner,
    )
    captured = capsys.readouterr()

    assert code == 1
    assert captured.out == ""
    assert "network down" in captured.err
    assert "Hint:" not in captured.err


def test_cli_download_passes_cookies_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    footage_dir = tmp_path / "footage"
    cookies_file = tmp_path / "cookies.txt"
    cookies_file.write_text("# Netscape HTTP Cookie File\n")
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")

    code = main(
        [
            "download",
            SAMPLE_URL,
            "--footage-dir",
            str(footage_dir),
            "--cookies",
            str(cookies_file),
        ],
        run=fake,
    )
    captured = capsys.readouterr()

    assert code == 0
    assert captured.out == f"{footage_dir / f'{SAMPLE_ID}.60fps.mp4'}\n"
    for cmd in (fake.probe_calls[0], fake.download_calls[0]):
        assert "--no-cookies-from-browser" in cmd
        assert cmd[cmd.index("--cookies") + 1] == str(cookies_file)


def test_cli_download_passes_cookies_from_browser(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    footage_dir = tmp_path / "footage"
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")

    code = main(
        [
            "download",
            SAMPLE_URL,
            "--footage-dir",
            str(footage_dir),
            "--cookies-from-browser",
            "chrome",
        ],
        run=fake,
    )
    captured = capsys.readouterr()

    assert code == 0
    assert captured.out == f"{footage_dir / f'{SAMPLE_ID}.60fps.mp4'}\n"
    for cmd in (fake.probe_calls[0], fake.download_calls[0]):
        assert "--no-cookies" in cmd
        assert cmd[cmd.index("--cookies-from-browser") + 1] == "chrome"


def test_cli_download_rejects_both_cookie_flags(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cookies_file = tmp_path / "cookies.txt"
    cookies_file.write_text("# Netscape HTTP Cookie File\n")
    fake = FakeYtDlp()

    with pytest.raises(SystemExit) as exc_info:
        main(
            [
                "download",
                SAMPLE_URL,
                "--cookies",
                str(cookies_file),
                "--cookies-from-browser",
                "chrome",
            ],
            run=fake,
        )

    captured = capsys.readouterr()
    assert exc_info.value.code == 2
    assert "not allowed with argument" in captured.err
    assert fake.calls == []


@pytest.mark.parametrize(
    "bot_error",
    [
        "ERROR: [youtube] 15GFTWAYeNE: Sign in to confirm you\u2019re not a bot.",
        "ERROR: Authentication required. Use --cookies-from-browser to authenticate.",
        "ERROR: SIGN IN TO CONFIRM YOU'RE NOT A BOT.",
    ],
)
def test_cli_download_prints_cookies_hint_on_youtube_bot_check(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], bot_error: str
) -> None:
    def bot_check_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 1, stdout="", stderr=bot_error)

    code = main(
        ["download", SAMPLE_URL, "--footage-dir", str(tmp_path / "footage")],
        run=bot_check_runner,
    )
    captured = capsys.readouterr()

    assert code == 1
    assert captured.out == ""
    assert bot_error in captured.err
    assert "Hint:" in captured.err
    assert "--cookies-from-browser" in captured.err
    assert "~/.config/yt-dlp/config" in captured.err


@pytest.mark.parametrize("use_file", [False, True])
def test_cli_download_omits_cookies_hint_when_cookies_already_supplied(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], use_file: bool
) -> None:
    bot_error = (
        "ERROR: [youtube] 15GFTWAYeNE: Sign in to confirm you\u2019re not a bot. "
        "Use --cookies-from-browser or --cookies for the authentication."
    )

    def bot_check_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(args), 1, stdout="", stderr=bot_error)

    if use_file:
        cookies_file = tmp_path / "cookies.txt"
        cookies_file.write_text("# Netscape HTTP Cookie File\n")
        cookie_flag = ["--cookies", str(cookies_file)]
    else:
        cookie_flag = ["--cookies-from-browser", "chrome"]

    code = main(
        ["download", SAMPLE_URL, "--footage-dir", str(tmp_path / "footage"), *cookie_flag],
        run=bot_check_runner,
    )
    captured = capsys.readouterr()

    assert code == 1
    assert "Sign in to confirm" in captured.err
    assert "Hint:" not in captured.err
