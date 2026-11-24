"""Tests for per-user Rally Log state, CLI fallback order, and path-recording rules."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID, uuid4

import platformdirs
import pytest
import uvicorn
from test_footage import SAMPLE_ID, SAMPLE_URL, FakeYtDlp
from test_roster import roster_toml

from pb_tokei import main
from pb_tokei.rally_log import MatchId, RallyLog, SourceVideo, resolve_video_path, stored_video_path
from pb_tokei.roster import parse_roster, set_up_match
from pb_tokei.state import (
    STATE_DIR_ENV,
    STATE_FILENAME,
    RallyLogNotFoundError,
    read_last_rally_log,
    resolve_rally_log,
    state_dir,
    state_file,
    write_last_rally_log,
)


def _add_match(db: Path, *, tournament: str = "PPA Atlanta Open 2026") -> str:
    roster = parse_roster(roster_toml(tournament={"name": tournament, "tour": "ppa"}))
    with RallyLog.open(db) as log:
        return str(set_up_match(log, roster).id)


def _make_static_dir(tmp_path: Path) -> Path:
    static = tmp_path / "static"
    static.mkdir(parents=True, exist_ok=True)
    (static / "index.html").write_text("<!doctype html><title>app</title>")
    return static


# --- State file reading & writing ---------------------------------------------------------


def test_state_dir_respects_env_and_falls_back_to_platformdirs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    custom = tmp_path / "custom-state"
    monkeypatch.setenv(STATE_DIR_ENV, str(custom))
    assert state_dir() == custom
    assert state_file() == custom / STATE_FILENAME

    monkeypatch.delenv(STATE_DIR_ENV)
    monkeypatch.setattr(platformdirs, "user_state_dir", lambda app: str(tmp_path / "pd" / app))
    assert state_dir() == tmp_path / "pd" / "pb-tokei"


def test_write_and_read_last_rally_log_is_atomic_and_stores_absolute_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    db = tmp_path / "sub" / "demo.duckdb"
    db.parent.mkdir()
    db.write_bytes(b"")

    assert write_last_rally_log(Path("sub/demo.duckdb")) is True
    assert read_last_rally_log() == db.resolve()

    raw = json.loads(state_file().read_text(encoding="utf-8"))
    assert raw == {"last_rally_log": str(db.resolve())}
    # Atomic write leaves only state.json, no leftover temp files.
    assert [p.name for p in state_dir().iterdir()] == [STATE_FILENAME]


@pytest.mark.parametrize(
    "content",
    [
        b"{not valid json",
        b"\xff\xfe\xfd",
        b"[]",
        b'"just a string"',
        b"{}",
        b'{"last_rally_log": null}',
        b'{"last_rally_log": 123}',
        b'{"last_rally_log": ""}',
        b'{"last_rally_log": "   "}',
        b'{"last_rally_log": "relative/path.duckdb"}',
    ],
    ids=[
        "bad-json",
        "bad-utf8",
        "list",
        "string",
        "missing-key",
        "null-value",
        "int-value",
        "empty-string",
        "whitespace",
        "relative-path",
    ],
)
def test_corrupt_state_file_counts_as_nothing_remembered(content: bytes) -> None:
    state_dir().mkdir(parents=True, exist_ok=True)
    state_file().write_bytes(content)

    assert read_last_rally_log() is None


def test_unreadable_state_file_directory_counts_as_nothing_remembered() -> None:
    state_file().mkdir(parents=True)

    assert read_last_rally_log() is None


def test_failed_state_write_warns_and_carries_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("file blocking mkdir")
    monkeypatch.setenv(STATE_DIR_ENV, str(blocker))

    ok = write_last_rally_log(tmp_path / "demo.duckdb")

    assert ok is False
    assert "warning:" in capsys.readouterr().err


# --- Fallback order -----------------------------------------------------------------------


def test_resolution_fallback_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    work = tmp_path / "work"
    other = tmp_path / "other"
    work.mkdir()
    other.mkdir()
    monkeypatch.chdir(work)

    explicit_db = other / "explicit.duckdb"
    remembered_db = other / "remembered.duckdb"
    local_db = work / "rally_log.duckdb"
    explicit_db.write_bytes(b"")
    remembered_db.write_bytes(b"")
    local_db.write_bytes(b"")
    write_last_rally_log(remembered_db)

    # 1. --db wins over remembered and ./rally_log.duckdb.
    assert resolve_rally_log(explicit_db) == explicit_db.resolve()

    # 1b. Missing --db is still an error even when remembered and ./rally_log.duckdb exist.
    with pytest.raises(RallyLogNotFoundError, match="typo.duckdb"):
        resolve_rally_log(other / "typo.duckdb")

    # 2. Remembered wins over ./rally_log.duckdb.
    assert resolve_rally_log(None) == remembered_db.resolve()

    # 3. Missing remembered falls back to ./rally_log.duckdb.
    remembered_db.unlink()
    assert resolve_rally_log(None) == local_db.resolve()

    # 4. When neither exists, error names both paths it tried.
    local_db.unlink()
    with pytest.raises(RallyLogNotFoundError) as exc_info:
        resolve_rally_log(None)
    msg = str(exc_info.value)
    assert str(remembered_db.resolve()) in msg
    assert str(local_db.resolve()) in msg


# --- CLI integration ----------------------------------------------------------------------


def test_annotate_remembers_rally_log_and_reopens_from_any_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    proj = tmp_path / "project"
    elsewhere = tmp_path / "elsewhere"
    proj.mkdir()
    elsewhere.mkdir()
    db = proj / "demo.duckdb"
    match_id = _add_match(db)
    (proj / "footage").mkdir()
    (proj / "footage" / "clip.webm").write_bytes(b"orig")
    (proj / "footage" / "clip.60fps.mp4").write_bytes(b"video-data")
    with RallyLog.open(db) as log:
        log.set_match_source_video(
            MatchId(UUID(match_id)),
            SourceVideo(SAMPLE_URL, "clip", Path("footage/clip.webm")),
        )

    opened_dbs: list[Path] = []
    video_bodies: list[bytes] = []
    monkeypatch.setattr("pb_tokei.annotate.server.STATIC_DIR", _make_static_dir(tmp_path))

    def fake_run(self: uvicorn.Server) -> None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        assert isinstance(self.config.app, FastAPI)
        client = TestClient(self.config.app, base_url="http://127.0.0.1")
        opened_dbs.append(Path(client.get("/api/rally-log").json()["path"]))
        video = client.get(f"/api/matches/{match_id}/video")
        assert video.status_code == 200
        video_bodies.append(video.content)

    monkeypatch.setattr(uvicorn.Server, "run", fake_run)

    # First run with --db records state.
    monkeypatch.chdir(proj)
    code1 = main(["annotate", "--no-browser", "--db", "demo.duckdb"])
    err1 = capsys.readouterr().err
    assert code1 == 0
    assert f"Rally Log: {db.resolve()}" in err1
    assert read_last_rally_log() == db.resolve()

    # Second run from a different directory with no flags reopens the remembered Rally Log,
    # with its relative-path video playing.
    monkeypatch.chdir(elsewhere)
    code2 = main(["annotate", "--no-browser"])
    err2 = capsys.readouterr().err
    assert code2 == 0
    assert f"Rally Log: {db.resolve()}" in err2
    assert opened_dbs == [db.resolve(), db.resolve()]
    assert video_bodies == [b"video-data", b"video-data"]


def test_annotate_carries_on_when_state_write_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "demo.duckdb"
    _add_match(db)
    blocker = tmp_path / "state-blocker"
    blocker.write_text("cannot mkdir here")
    monkeypatch.setenv(STATE_DIR_ENV, str(blocker))
    monkeypatch.setattr("pb_tokei.annotate.server.STATIC_DIR", _make_static_dir(tmp_path))

    ran = False

    def fake_run(_self: uvicorn.Server) -> None:
        nonlocal ran
        ran = True

    monkeypatch.setattr(uvicorn.Server, "run", fake_run)

    code = main(["annotate", "--no-browser", "--db", str(db)])
    err = capsys.readouterr().err

    assert code == 0
    assert ran is True
    assert f"Rally Log: {db.resolve()}" in err
    assert "warning:" in err


def test_other_commands_use_remembered_rally_log_without_updating_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    proj = tmp_path / "project"
    elsewhere = tmp_path / "elsewhere"
    proj.mkdir()
    elsewhere.mkdir()
    remembered = proj / "demo.duckdb"
    _add_match(remembered, tournament="PPA Atlanta Open 2026")
    write_last_rally_log(remembered)

    # Run from an unrelated directory with no --db.
    monkeypatch.chdir(elsewhere)

    # 1. match add uses remembered and prints it to stderr.
    roster_file = elsewhere / "new.toml"
    roster_file.write_text(roster_toml(tournament={"name": "APP Chicago 2026", "tour": "app"}))
    code = main(["match", "add", str(roster_file)])
    captured = capsys.readouterr()
    assert code == 0
    added_id = captured.out.strip()
    assert f"Rally Log: {remembered.resolve()}" in captured.err

    # 2. match list uses remembered and prints it to stderr.
    code = main(["match", "list"])
    captured = capsys.readouterr()
    assert code == 0
    assert "APP Chicago 2026" in captured.out
    assert f"Rally Log: {remembered.resolve()}" in captured.err

    # 3. download --match uses remembered, defaults --footage-dir to <Rally Log dir>/footage,
    #    and records a relative path.
    fake = FakeYtDlp(video_id=SAMPLE_ID, ext="mkv")
    code = main(["download", SAMPLE_URL, "--match", added_id], run=fake)
    captured = capsys.readouterr()
    assert code == 0
    assert f"Rally Log: {remembered.resolve()}" in captured.err
    assert (proj / "footage" / f"{SAMPLE_ID}.mkv").is_file()
    assert (proj / "footage" / f"{SAMPLE_ID}.60fps.mp4").is_file()
    with RallyLog.open(remembered) as log:
        loaded = log.load_match(MatchId(UUID(added_id)))
    assert loaded.source_video == SourceVideo(
        url=SAMPLE_URL, video_id=SAMPLE_ID, path=Path("footage") / f"{SAMPLE_ID}.mkv"
    )

    # Passing --db to another command does NOT change what annotate remembered.
    other_db = elsewhere / "other.duckdb"
    roster_other = elsewhere / "other.toml"
    roster_other.write_text(roster_toml())
    assert main(["match", "add", str(roster_other), "--db", str(other_db)]) == 0
    assert main(["match", "list", "--db", str(other_db)]) == 0
    capsys.readouterr()
    assert read_last_rally_log() == remembered.resolve()


def test_commands_error_naming_both_paths_when_remembered_and_default_are_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.chdir(work)
    gone = (tmp_path / "gone.duckdb").resolve()
    write_last_rally_log(gone)
    local_default = (work / "rally_log.duckdb").resolve()

    roster_file = work / "match.toml"
    roster_file.write_text(roster_toml())

    commands = [
        ["annotate", "--no-browser"],
        ["match", "list"],
        ["match", "add", str(roster_file)],
        ["download", SAMPLE_URL, "--match", str(uuid4())],
    ]
    for argv in commands:
        code = main(argv)
        err = capsys.readouterr().err
        assert code == 1, argv
        assert str(gone) in err, argv
        assert str(local_default) in err, argv


def test_bare_cli_still_prints_help_and_exits_with_error(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        main([])
    assert exc_info.value.code == 2
    assert "usage: pb-tokei" in capsys.readouterr().err


# --- Path helpers (ADR 0007) --------------------------------------------------------------


def test_stored_and_resolved_video_path_rules(tmp_path: Path) -> None:
    proj = tmp_path / "proj"
    proj.mkdir()
    db = proj / "rally_log.duckdb"
    inside = proj / "footage" / "clip.mp4"
    outside = tmp_path / "external" / "clip.mp4"

    assert stored_video_path(inside, db) == Path("footage/clip.mp4")
    assert stored_video_path(outside, db) == outside.resolve()
    assert resolve_video_path(Path("footage/clip.mp4"), db) == inside.resolve()
    assert resolve_video_path(outside.resolve(), db) == outside.resolve()
