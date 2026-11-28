from dataclasses import asdict, replace
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from test_footage_jobs import LOCAL, URL_A, FakeStreamRunner
from test_roster import DALLAS_VS_MIAMI, MLP, roster_toml

from pb_tokei.annotate.app import create_app
from pb_tokei.annotate.footage_jobs import FootageJobService
from pb_tokei.rally_log import Handedness, MatchId, RallyLog
from pb_tokei.roster import Roster, parse_roster, set_up_match
from pb_tokei.state import read_cookies_from_browser, write_cookies_from_browser


@pytest.fixture
def db(tmp_path: Path) -> Path:
    db = tmp_path / "log.duckdb"
    with RallyLog.open(db):
        pass
    return db


@pytest.fixture
def client(db: Path) -> TestClient:
    return TestClient(create_app(db), base_url=LOCAL, headers={"Origin": LOCAL})


def form(roster: Roster | None = None) -> dict[str, Any]:
    roster = roster or parse_roster(roster_toml())
    body: dict[str, Any] = {
        "date": roster.date.isoformat(),
        "tournament": roster.tournament,
        "tour": roster.tour,
        "team_a": [asdict(player) for player in roster.team_a],
        "team_b": [asdict(player) for player in roster.team_b],
    }
    if roster.franchise_match is not None:
        fm = roster.franchise_match
        body["franchise_match"] = {"franchise_a": fm.franchise_a, "franchise_b": fm.franchise_b}
        if fm.id is not None:
            body["franchise_match"]["id"] = str(fm.id)
    return body


def test_create_match_is_equivalent_to_its_roster_file(client: TestClient, db: Path) -> None:
    with RallyLog.open(db) as log:
        first = set_up_match(log, parse_roster(roster_toml()))
    roster = parse_roster(roster_toml(team_b=(("Eve Park", "left"), ("Dan Kim", "right"))))
    body = form(roster)
    body["tournament"] += " "
    body["team_a"][0]["name"] += " "

    response = client.post("/api/matches", json=body)

    assert response.status_code == 201, response.text
    match_id = MatchId(UUID(response.json()["id"]))
    assert match_id not in {first.id, roster.match_id}
    with RallyLog.open(db) as log:
        match = log.load_match(match_id)
        assert match.tournament_id == first.tournament_id
        assert match.team_a_id == first.team_a_id
        eve = log.find_player("Eve Park")
        assert eve is not None and eve.handedness is Handedness.LEFT
        assert len(log.list_players()) == 5
        expected = set_up_match(log, roster)
        assert replace(match, id=expected.id) == expected


def test_create_mlp_match_can_pick_or_create_a_franchise_match(
    client: TestClient, db: Path
) -> None:
    roster = parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
    body = form(roster)
    first = client.post("/api/matches", json=body)
    assert first.status_code == 201, first.text
    with RallyLog.open(db) as log:
        initial = log.load_match(MatchId(UUID(first.json()["id"])))
        assert initial.franchise_match_id is not None

    # A form opened before the first request omits the id and reuses the meeting it created.
    automatic = client.post("/api/matches", json=body)
    assert automatic.status_code == 201, automatic.text

    explicitly_new = client.post(
        "/api/matches", json={**body, "franchise_match": {**body["franchise_match"], "id": None}}
    )
    assert explicitly_new.status_code == 201, explicitly_new.text
    reverse = {
        **body,
        "franchise_match": {
            "franchise_a": DALLAS_VS_MIAMI["franchise_b"] + " ",
            "franchise_b": DALLAS_VS_MIAMI["franchise_a"],
            "id": str(initial.franchise_match_id),
        },
    }
    selected = client.post("/api/matches", json=reverse)
    assert selected.status_code == 201, selected.text

    ambiguous = client.post("/api/matches", json=body)
    assert ambiguous.status_code == 422
    assert "met more than once" in ambiguous.json()["detail"]
    assert str(initial.franchise_match_id) not in ambiguous.json()["detail"]

    with RallyLog.open(db) as log:
        reused = log.load_match(MatchId(UUID(automatic.json()["id"])))
        fresh = log.load_match(MatchId(UUID(explicitly_new.json()["id"])))
        existing = log.load_match(MatchId(UUID(selected.json()["id"])))
        assert reused.franchise_match_id == initial.franchise_match_id
        assert fresh.franchise_match_id != initial.franchise_match_id
        assert existing.franchise_match_id == initial.franchise_match_id
        assert existing.team_a_id == initial.team_b_id
        assert len(log.list_franchise_matches()) == 2
        assert len(log.list_matches()) == 4


def test_match_creation_reports_roster_errors_without_writing(client: TestClient, db: Path) -> None:
    body = form()
    body["team_b"][1] = {**body["team_a"][0], "name": body["team_a"][0]["name"] + " "}

    response = client.post("/api/matches", json=body)

    assert response.status_code == 422
    assert response.json()["detail"] == "a Player can't appear twice in a Match"
    with RallyLog.open(db) as log:
        assert not log.list_matches()
        assert not log.list_players()


def test_match_creation_rejects_a_foreign_origin(client: TestClient, db: Path) -> None:
    response = client.post("/api/matches", json=form(), headers={"Origin": "https://example.com"})

    assert response.status_code == 403
    with RallyLog.open(db) as log:
        assert not log.list_matches()


def test_roster_catalog_includes_matches_grouped_by_franchise_match(
    client: TestClient, db: Path
) -> None:
    with RallyLog.open(db) as log:
        set_up_match(log, parse_roster(roster_toml()))
        mlp = set_up_match(
            log, parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
        )

    response = client.get("/api/roster")

    assert response.status_code == 200, response.text
    catalog = response.json()
    assert [{"name": p["name"], "handedness": p["handedness"]} for p in catalog["players"]] == [
        {"name": "Anna Bright", "handedness": "right"},
        {"name": "Ben Johns", "handedness": "right"},
        {"name": "Cara Lee", "handedness": "left"},
        {"name": "Dan Kim", "handedness": "right"},
    ]
    assert all(UUID(p["id"]) for p in catalog["players"])
    assert {item["tour"] for item in catalog["tournaments"]} == {"ppa", "mlp"}
    franchises = {item["name"]: item["id"] for item in catalog["franchises"]}
    assert catalog["franchise_matches"] == [
        {
            "id": str(mlp.franchise_match_id),
            "tournament_id": str(mlp.tournament_id),
            "franchise_a_id": franchises["Dallas Flash"],
            "franchise_b_id": franchises["Miami Pickleball Club"],
            "matches": [
                {"team_a": ["Anna Bright", "Ben Johns"], "team_b": ["Cara Lee", "Dan Kim"]}
            ],
        }
    ]


def test_create_match_queues_footage_with_remembered_cookies(db: Path) -> None:
    write_cookies_from_browser("chrome:Profile 1")
    runner = FakeStreamRunner()
    app = create_app(db, footage_runner=runner)
    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as client:
        response = client.post("/api/matches", json={**form(), "footage_url": URL_A})

        assert response.status_code == 201, response.text
        match_id = MatchId(UUID(response.json()["id"]))
        assert app.state.rally_logs.current.footage.wait_for(match_id)
        assert len(runner.download_calls) == 1
        assert "chrome:Profile 1" in runner.download_calls[0]
        assert URL_A in runner.download_calls[0]
        assert read_cookies_from_browser() == "chrome:Profile 1"
        assert client.get(f"/api/matches/{match_id}").json()["video_status"] == "ready"


@pytest.mark.parametrize("url", ["http://[broken", URL_A])
def test_footage_enqueue_failure_keeps_the_match_and_shows_the_error(
    client: TestClient, url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def cannot_start(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("Could not start the footage worker")

    monkeypatch.setattr(FootageJobService, "enqueue", cannot_start)

    response = client.post("/api/matches", json={**form(), "footage_url": url})

    assert response.status_code == 201, response.text
    match_url = f"/api/matches/{response.json()['id']}"
    assert client.get(match_url).status_code == 200
    footage = client.get(f"{match_url}/footage").json()
    assert footage["state"] == "error"
    assert footage["requested_url"] == url
    expected = "Could not start" if url == URL_A else "Expected an http(s) URL"
    assert expected in footage["error"]


@pytest.mark.parametrize(
    "bad_date",
    [None, "", "2026-02-30", "0026-04-12", "20260412", "2026-04-12T00:00:00Z", 0],
)
def test_match_creation_rejects_missing_or_malformed_date(
    client: TestClient, db: Path, bad_date: object
) -> None:
    body = form()
    if bad_date is None:
        del body["date"]
    else:
        body["date"] = bad_date

    response = client.post("/api/matches", json=body)

    assert response.status_code == 422
    with RallyLog.open(db) as log:
        assert not log.list_matches()


def test_patch_match_date_updates_summary_and_persists(client: TestClient, db: Path) -> None:
    with RallyLog.open(db) as log:
        match = set_up_match(log, parse_roster(roster_toml(match_date="2026-03-01")))
        log.save_match(replace(match, date=None))

    assert client.get(f"/api/matches/{match.id}").json()["date"] is None

    updated = client.patch(f"/api/matches/{match.id}", json={"date": "2026-04-18"})
    assert updated.status_code == 200, updated.text
    assert updated.json()["id"] == str(match.id)
    assert updated.json()["date"] == "2026-04-18"
    assert client.get(f"/api/matches/{match.id}").json()["date"] == "2026-04-18"
    assert client.get("/api/matches").json()[0]["date"] == "2026-04-18"

    changed = client.patch(f"/api/matches/{match.id}", json={"date": "2026-05-02"})
    assert changed.status_code == 200
    assert changed.json()["date"] == "2026-05-02"
    with RallyLog.open(db) as log:
        assert log.load_match(match.id).date == date(2026, 5, 2)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"date": None},
        {"date": ""},
        {"date": "2026-02-30"},
        {"date": "0026-04-12"},
        {"date": "20260412"},
        {"date": "2026-04-12T10:00:00Z"},
        {"date": 1700000000},
        {"date": "2026-04-18", "tournament": "Other Open"},
    ],
)
def test_patch_match_date_rejects_malformed_body(
    client: TestClient, db: Path, payload: dict[str, object]
) -> None:
    with RallyLog.open(db) as log:
        match = set_up_match(log, parse_roster(roster_toml(match_date="2026-03-01")))

    response = client.patch(f"/api/matches/{match.id}", json=payload)

    assert response.status_code == 422
    with RallyLog.open(db) as log:
        assert log.load_match(match.id).date == date(2026, 3, 1)


def test_patch_match_date_checks_existence_origin_and_rally_log(
    client: TestClient, db: Path, tmp_path: Path
) -> None:
    with RallyLog.open(db) as log:
        match = set_up_match(log, parse_roster(roster_toml(match_date="2026-03-01")))

    assert client.patch(f"/api/matches/{uuid4()}", json={"date": "2026-04-18"}).status_code == 404

    no_origin = TestClient(create_app(db), base_url=LOCAL)
    assert (
        no_origin.patch(f"/api/matches/{match.id}", json={"date": "2026-04-18"}).status_code == 403
    )
    assert (
        client.patch(
            f"/api/matches/{match.id}",
            json={"date": "2026-04-18"},
            headers={"Origin": "https://example.com"},
        ).status_code
        == 403
    )

    other = tmp_path / "other.duckdb"
    assert (
        client.post("/api/rally-log", json={"path": str(other), "create": True}).status_code == 200
    )
    assert (
        client.patch(
            f"/api/matches/{match.id}",
            json={"date": "2026-04-18"},
            headers={"X-Rally-Log": quote(str(db.resolve()))},
        ).status_code
        == 409
    )
    with RallyLog.open(db) as log:
        assert log.load_match(match.id).date == date(2026, 3, 1)
