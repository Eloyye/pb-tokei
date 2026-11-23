from pathlib import Path
from uuid import uuid4

import duckdb
import pytest
from fastapi.testclient import TestClient

from pb_tokei import main
from pb_tokei.annotate.app import create_app
from pb_tokei.rally_log import MatchId, RallyLog, SourceVideo
from pb_tokei.roster import parse_roster, set_up_match

URL = "https://www.youtube.com/watch?v=abc123"
VIDEO_BYTES = bytes(range(256)) * 40


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
    return TestClient(create_app(db, base_dir=tmp_path, static_dir=static_dir))


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
        create_app(Path("rally_log.duckdb"), base_dir=tmp_path, static_dir=static_dir)
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


def test_files_outside_the_build_are_not_served(client: TestClient, tmp_path: Path) -> None:
    (tmp_path / "secret.txt").write_text("secret")

    response = client.get("/%2e%2e/secret.txt")

    assert "secret" not in response.text


def test_unknown_api_path_is_404_not_index_html(client: TestClient) -> None:
    response = client.get("/api/nope")

    assert response.status_code == 404
    assert "<title>" not in response.text


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
