from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import asdict, replace
from datetime import date
from pathlib import Path
from threading import Barrier, BrokenBarrierError
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from test_footage_jobs import LOCAL, URL_A, FakeStreamRunner
from test_roster import DALLAS_VS_MIAMI, MLP, roster_toml

from pb_tokei.annotate.app import create_app
from pb_tokei.annotate.footage_jobs import FootageJobService
from pb_tokei.rally_log import (
    Discipline,
    Gender,
    Handedness,
    MatchId,
    Player,
    PlayerId,
    RallyLog,
    Tour,
)
from pb_tokei.roster import (
    Roster,
    RosterError,
    RosterPlayer,
    create_match,
    parse_roster,
    set_up_match,
)
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


def form(
    roster: Roster | None = None,
    *,
    existing_ids: dict[str, PlayerId] | None = None,
) -> dict[str, Any]:
    roster = roster or parse_roster(roster_toml())
    ids = existing_ids or {}

    def slot(player: RosterPlayer) -> str | dict[str, Any]:
        if player.name in ids:
            return str(ids[player.name])
        return asdict(player)

    body: dict[str, Any] = {
        "date": roster.date.isoformat(),
        "tournament": roster.tournament,
        "tour": roster.tour,
        "team_a": [slot(player) for player in roster.team_a],
        "team_b": [slot(player) for player in roster.team_b],
    }
    if roster.franchise_match is not None:
        fm = roster.franchise_match
        body["franchise_match"] = {"franchise_a": fm.franchise_a, "franchise_b": fm.franchise_b}
        if fm.id is not None:
            body["franchise_match"]["id"] = str(fm.id)
    return body


def stored_player_ids(db: Path) -> dict[str, PlayerId]:
    with RallyLog.open(db) as log:
        return {player.name: player.id for player in log.list_players()}


def test_create_match_mixes_existing_player_ids_and_new_players(
    client: TestClient, db: Path
) -> None:
    with RallyLog.open(db) as log:
        first = set_up_match(log, parse_roster(roster_toml()))
    ids = stored_player_ids(db)
    roster = parse_roster(
        roster_toml(team_b=(("Eve Park", "left", "female"), ("Dan Kim", "right", "male")))
    )
    body = form(roster, existing_ids=ids)
    body["tournament"] += " "
    body["team_b"][0]["name"] = "  Eve Park  "

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
        assert set(log.get_team(match.team_b_id).player_ids) == {eve.id, ids["Dan Kim"]}
        assert len(log.list_players()) == 5
        expected = set_up_match(log, roster)
        assert replace(match, id=expected.id) == expected


@pytest.mark.parametrize(
    "colliding_name",
    ["Anna Bright", "  Anna Bright  ", "anna   BRIGHT"],
)
def test_create_match_rejects_new_player_colliding_with_existing_without_writing(
    client: TestClient, db: Path, colliding_name: str
) -> None:
    with RallyLog.open(db) as log:
        set_up_match(log, parse_roster(roster_toml()))
    ids = stored_player_ids(db)
    body = {
        "date": "2026-04-15",
        "tournament": "Brand New Open 2026",
        "tour": "ppa",
        "team_a": [
            {"name": colliding_name, "handedness": "right", "gender": "female"},
            {"name": "Zoe Fresh", "handedness": "left", "gender": "male"},
        ],
        "team_b": [str(ids["Cara Lee"]), str(ids["Dan Kim"])],
    }

    response = client.post("/api/matches", json=body)

    assert response.status_code == 422
    assert response.json()["detail"] == "Player 'Anna Bright' already exists"
    with RallyLog.open(db) as log:
        assert len(log.list_matches()) == 1
        assert len(log.list_players()) == 4
        assert log.find_player("Zoe Fresh") is None
        assert log.find_tournament("Brand New Open 2026", Tour.PPA) is None


def test_create_match_rejects_unknown_player_uuid_without_writing(
    client: TestClient, db: Path
) -> None:
    missing_id = uuid4()
    body = {
        "date": "2026-04-15",
        "tournament": "PPA Atlanta Open 2026",
        "tour": "ppa",
        "team_a": [
            str(missing_id),
            {"name": "New One", "handedness": "right", "gender": "female"},
        ],
        "team_b": [
            {"name": "New Two", "handedness": "left", "gender": "female"},
            {"name": "New Three", "handedness": "right", "gender": "male"},
        ],
    }

    response = client.post("/api/matches", json=body)

    assert response.status_code == 422
    assert str(missing_id) in response.json()["detail"]
    with RallyLog.open(db) as log:
        assert not log.list_matches()
        assert not log.list_players()
        assert not log.list_tournaments()


def test_create_match_rejects_duplicate_uuids_and_duplicate_normalized_new_names(
    client: TestClient, db: Path
) -> None:
    with RallyLog.open(db) as log:
        set_up_match(log, parse_roster(roster_toml()))
    ids = stored_player_ids(db)

    duplicate_uuid = {
        "date": "2026-04-15",
        "tournament": "PPA Atlanta Open 2026",
        "tour": "ppa",
        "team_a": [str(ids["Anna Bright"]), str(ids["Ben Johns"])],
        "team_b": [str(ids["Cara Lee"]), str(ids["Anna Bright"])],
    }
    resp_uuid = client.post("/api/matches", json=duplicate_uuid)
    assert resp_uuid.status_code == 422
    assert resp_uuid.json()["detail"] == "a Player can't appear twice in a Match"

    duplicate_new = {
        "date": "2026-04-15",
        "tournament": "Brand New Open 2026",
        "tour": "ppa",
        "team_a": [
            {"name": "Eve Park", "handedness": "left", "gender": "female"},
            str(ids["Ben Johns"]),
        ],
        "team_b": [
            {"name": "  eve   PARK ", "handedness": "right", "gender": "female"},
            str(ids["Dan Kim"]),
        ],
    }
    resp_new = client.post("/api/matches", json=duplicate_new)
    assert resp_new.status_code == 422
    assert resp_new.json()["detail"] == "a Player can't appear twice in a Match"

    blank_new = {
        "date": "2026-04-15",
        "tournament": "Brand New Open 2026",
        "tour": "ppa",
        "team_a": [
            {"name": "   ", "handedness": "left", "gender": "female"},
            str(ids["Ben Johns"]),
        ],
        "team_b": [str(ids["Cara Lee"]), str(ids["Dan Kim"])],
    }
    resp_blank = client.post("/api/matches", json=blank_new)
    assert resp_blank.status_code == 422
    assert resp_blank.json()["detail"] == "each Player needs a name"

    with RallyLog.open(db) as log:
        assert len(log.list_matches()) == 1
        assert len(log.list_players()) == 4
        assert log.find_tournament("Brand New Open 2026", Tour.PPA) is None


def test_create_match_disambiguates_legacy_duplicate_name_players_by_id(
    client: TestClient, db: Path
) -> None:
    first_id = PlayerId(uuid4())
    second_id = PlayerId(uuid4())
    p3 = PlayerId(uuid4())
    p4 = PlayerId(uuid4())
    with RallyLog.open(db) as log:
        log.save_player(Player(first_id, "Anna Bright", Handedness.RIGHT, Gender.FEMALE))
        log.save_player(Player(second_id, "Anna Bright", Handedness.LEFT, Gender.FEMALE))
        log.save_player(Player(p3, "Cara Lee", Handedness.LEFT, Gender.MALE))
        log.save_player(Player(p4, "Dan Kim", Handedness.RIGHT, Gender.MALE))

    # Selecting the second duplicate-name row by UUID uses that exact id, and both ids are distinct.
    response = client.post(
        "/api/matches",
        json={
            "date": "2026-04-16",
            "tournament": "PPA Atlanta Open 2026",
            "tour": "ppa",
            "team_a": [str(second_id), str(p3)],
            "team_b": [str(first_id), str(p4)],
        },
    )

    assert response.status_code == 201, response.text
    with RallyLog.open(db) as log:
        match = log.load_match(MatchId(UUID(response.json()["id"])))
        assert set(log.get_team(match.team_a_id).player_ids) == {second_id, p3}
        assert set(log.get_team(match.team_b_id).player_ids) == {first_id, p4}


def test_create_mlp_match_can_pick_or_create_a_franchise_match(
    client: TestClient, db: Path
) -> None:
    roster = parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
    first = client.post("/api/matches", json=form(roster))
    assert first.status_code == 201, first.text
    with RallyLog.open(db) as log:
        initial = log.load_match(MatchId(UUID(first.json()["id"])))
        assert initial.franchise_match_id is not None

    # Subsequent matches reference the stored Players by UUID.
    body = form(roster, existing_ids=stored_player_ids(db))

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


def test_concurrent_explicit_match_creation_prevents_duplicate_players(
    db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with RallyLog.open(db) as log:
        set_up_match(log, parse_roster(roster_toml()))
    ids = stored_player_ids(db)
    start = Barrier(2)
    reads = Barrier(2)
    original_list_players = RallyLog.list_players

    def read_players_together(log: RallyLog) -> list[Player]:
        players = original_list_players(log)
        with suppress(BrokenBarrierError):
            reads.wait(timeout=1.0)
        return players

    monkeypatch.setattr(RallyLog, "list_players", read_players_together)

    def create(new_name: str) -> MatchId:
        with RallyLog.open(db) as log:
            start.wait(timeout=5)
            return create_match(
                log,
                date=date(2026, 4, 15),
                tournament="PPA Atlanta Open 2026",
                tour=Tour.PPA,
                team_a=(
                    ids["Anna Bright"],
                    RosterPlayer(new_name, Handedness.LEFT, Gender.MALE),
                ),
                team_b=(ids["Cara Lee"], ids["Dan Kim"]),
            ).id

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(create, "Eve Park")
        second = pool.submit(create, "  eve   park ")
        outcomes: list[MatchId | Exception] = []
        for future in (first, second):
            try:
                outcomes.append(future.result())
            except RosterError as exc:
                outcomes.append(exc)

    succeeded = [item for item in outcomes if isinstance(item, UUID)]
    failed = [item for item in outcomes if isinstance(item, RosterError)]
    assert len(succeeded) == 1
    assert len(failed) == 1
    assert "already exists" in str(failed[0])
    with RallyLog.open(db) as log:
        assert len(log.list_matches()) == 2
        assert len(log.list_players()) == 5


def test_match_creation_reports_roster_errors_without_writing(client: TestClient, db: Path) -> None:
    body = form()
    body["team_b"][1] = {**body["team_a"][0], "name": body["team_a"][0]["name"] + " "}

    response = client.post("/api/matches", json=body)

    assert response.status_code == 422
    assert response.json()["detail"] == "a Player can't appear twice in a Match"
    with RallyLog.open(db) as log:
        assert not log.list_matches()
        assert not log.list_players()


@pytest.mark.parametrize(
    ("overrides", "expected_detail"),
    [
        ({"foo": 1}, None),
        (
            {
                "team_a": [
                    {"name": "Anna Bright", "handedness": "right", "extra": True},
                    {"name": "Ben Johns", "handedness": "right"},
                ]
            },
            None,
        ),
        (
            {"team_a": ["not-a-uuid", {"name": "Ben Johns", "handedness": "right"}]},
            None,
        ),
        ({"tournament": "   "}, "Tournament name must be non-empty text"),
        ({"tour": "mlp"}, "an MLP Match needs a Franchise Match"),
        (
            {"tour": "ppa", "franchise_match": DALLAS_VS_MIAMI},
            "only MLP Matches have a Franchise Match",
        ),
        (
            {
                "tour": "mlp",
                "franchise_match": {"franchise_a": "   ", "franchise_b": "Miami Pickleball Club"},
            },
            "each Franchise needs a name",
        ),
        (
            {
                "tour": "mlp",
                "franchise_match": {
                    "franchise_a": "Dallas Flash",
                    "franchise_b": "Dallas Flash ",
                },
            },
            "a Franchise can't play itself",
        ),
    ],
)
def test_create_match_rejects_extra_fields_malformed_slots_and_metadata_errors(
    client: TestClient, db: Path, overrides: dict[str, Any], expected_detail: str | None
) -> None:
    body = {**form(), **overrides}

    response = client.post("/api/matches", json=body)

    assert response.status_code == 422
    if expected_detail is not None:
        assert response.json()["detail"] == expected_detail
    with RallyLog.open(db) as log:
        assert not log.list_matches()
        assert not log.list_players()
        assert not log.list_tournaments()
        assert not log.list_franchises()


def test_match_creation_rejects_foreign_origin_and_stale_rally_log(
    client: TestClient, db: Path, tmp_path: Path
) -> None:
    response = client.post("/api/matches", json=form(), headers={"Origin": "https://example.com"})
    assert response.status_code == 403

    other = tmp_path / "other.duckdb"
    assert (
        client.post("/api/rally-log", json={"path": str(other), "create": True}).status_code == 200
    )
    stale = client.post(
        "/api/matches",
        json=form(),
        headers={"X-Rally-Log": quote(str(db.resolve()))},
    )
    assert stale.status_code == 409
    with RallyLog.open(db) as log:
        assert not log.list_matches()
    with RallyLog.open(other) as log:
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
    assert [
        {"name": p["name"], "handedness": p["handedness"], "gender": p["gender"]}
        for p in catalog["players"]
    ] == [
        {"name": "Anna Bright", "handedness": "right", "gender": "female"},
        {"name": "Ben Johns", "handedness": "right", "gender": "male"},
        {"name": "Cara Lee", "handedness": "left", "gender": "female"},
        {"name": "Dan Kim", "handedness": "right", "gender": "male"},
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
                {
                    "team_a": ["Anna Bright", "Ben Johns"],
                    "team_b": ["Cara Lee", "Dan Kim"],
                    "discipline": "mixed_doubles",
                }
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


def test_match_creation_validates_gender_and_discipline_without_writing(
    client: TestClient, db: Path
) -> None:
    missing_gender = form()
    del missing_gender["team_a"][0]["gender"]
    assert client.post("/api/matches", json=missing_gender).status_code == 422

    bad_gender = form()
    bad_gender["team_a"][0]["gender"] = "other"
    assert client.post("/api/matches", json=bad_gender).status_code == 422

    for team_a_genders, team_b_genders in (
        (("male", "male"), ("female", "male")),
        (("male", "male"), ("female", "female")),
        (("female", "female"), ("female", "male")),
    ):
        body = form()
        body["team_a"][0]["gender"], body["team_a"][1]["gender"] = team_a_genders
        body["team_b"][0]["gender"], body["team_b"][1]["gender"] = team_b_genders
        resp = client.post("/api/matches", json=body)
        assert resp.status_code == 422
        assert "Invalid Match lineup" in resp.json()["detail"]

    with RallyLog.open(db) as log:
        assert not log.list_matches()
        assert not log.list_players()


def test_match_creation_backfills_legacy_null_gender_and_refuses_conflicts(
    client: TestClient, db: Path
) -> None:
    with RallyLog.open(db) as log:
        first = set_up_match(log, parse_roster(roster_toml()))
        anna = log.find_player("Anna Bright")
        assert anna is not None
        log.save_player(replace(anna, gender=None))
    ids = stored_player_ids(db)

    assert client.get(f"/api/matches/{first.id}").json()["discipline"] is None

    # Picking legacy Anna by bare UUID without supplying gender is rejected with 422.
    bare_uuid = {
        "date": "2026-04-15",
        "tournament": "PPA Atlanta Open 2026",
        "tour": "ppa",
        "team_a": [str(ids["Anna Bright"]), str(ids["Ben Johns"])],
        "team_b": [str(ids["Cara Lee"]), str(ids["Dan Kim"])],
    }
    missing = client.post("/api/matches", json=bare_uuid)
    assert missing.status_code == 422
    assert "missing gender" in missing.json()["detail"]

    # Supplying a conflicting gender for legacy Anna (would turn `first` into M+M vs F+M) is 422.
    conflicting = {
        "date": "2026-04-15",
        "tournament": "PPA Atlanta Open 2026",
        "tour": "ppa",
        "team_a": [{"id": str(ids["Anna Bright"]), "gender": "male"}, str(ids["Ben Johns"])],
        "team_b": [
            str(ids["Dan Kim"]),
            {"name": "New Guy", "handedness": "right", "gender": "male"},
        ],
    }
    bad = client.post("/api/matches", json=conflicting)
    assert bad.status_code == 422
    assert "PPA Atlanta Open 2026" in bad.json()["detail"]
    with RallyLog.open(db) as log:
        assert log.get_player(anna.id).gender is None
        assert log.find_player("New Guy") is None

    # Compatible backfill succeeds atomically and derives Discipline on both Matches.
    compatible = {
        "date": "2026-04-15",
        "tournament": "PPA Atlanta Open 2026",
        "tour": "ppa",
        "team_a": [{"id": str(ids["Anna Bright"]), "gender": "female"}, str(ids["Ben Johns"])],
        "team_b": [
            {"name": "Eve Park", "handedness": "left", "gender": "female"},
            str(ids["Dan Kim"]),
        ],
    }
    ok = client.post("/api/matches", json=compatible)
    assert ok.status_code == 201, ok.text
    with RallyLog.open(db) as log:
        assert log.get_player(anna.id).gender is Gender.FEMALE
        assert log.get_match_summary(first.id).discipline is Discipline.MIXED_DOUBLES

    # Once set, a disagreeing gender on Match setup is rejected with 422, while bare UUID succeeds.
    disagree = client.post("/api/matches", json=conflicting)
    assert disagree.status_code == 422
    assert "Anna Bright is stored as female" in disagree.json()["detail"]
    assert client.post("/api/matches", json=bare_uuid).status_code == 201
