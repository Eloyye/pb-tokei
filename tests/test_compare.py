from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from pb_tokei.annotate.app import create_app
from pb_tokei.demo_match import DEMO_MLP_DATE, DEMO_MLP_TOURNAMENT, write_demo_matches
from pb_tokei.events.compare import compare_stats, intervals_separated
from pb_tokei.events.report import (
    ReportCount,
    ReportDimension,
    ReportGroup,
    ReportKind,
    ReportMix,
    ReportRate,
    ReportSplit,
    ReportStat,
    ReportSubject,
    ReportSubRow,
)
from pb_tokei.rally_log import RallyLog

type Json = dict[str, Any]


def _rate(low: float | None, high: float | None, *, of: int = 10) -> ReportRate:
    estimate = None if low is None or high is None else (low + high) / 2
    return ReportRate(count=0, of=of, estimate=estimate, low=low, high=high, left_out=0)


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    db = tmp_path_factory.mktemp("compare") / "demo.duckdb"
    with RallyLog.open(db) as log:
        write_demo_matches(log)
    with TestClient(create_app(db), base_url="http://127.0.0.1") as client:
        yield client


def _ids(client: TestClient, kind: str) -> dict[str, str]:
    choices = client.get("/api/compare", params={"kind": kind}).json()["choices"]
    if kind == "player":
        return {choice["name"]: choice["id"] for choice in choices}
    return {" / ".join(p["name"] for p in choice["players"]): choice["id"] for choice in choices}


def _compare(client: TestClient, kind: str, a: str, b: str, **params: str) -> Json:
    ids = _ids(client, kind)
    response = client.get("/api/compare", params={"kind": kind, "a": ids[a], "b": ids[b], **params})
    assert response.status_code == 200, response.text
    return response.json()


def _stat(result: Json, stat_id: str) -> Json:
    return next(stat for stat in result["stats"] if stat["id"] == stat_id)


@pytest.mark.parametrize(
    ("a", "b", "separated"),
    [
        (_rate(0.1, 0.3), _rate(0.4, 0.6), True),
        (_rate(0.4, 0.6), _rate(0.1, 0.3), True),
        (_rate(0.1, 0.4), _rate(0.4, 0.6), False),
        (_rate(0.1, 0.5), _rate(0.4, 0.6), False),
        (_rate(0.1, 0.9), _rate(0.4, 0.6), False),
        (_rate(None, None, of=0), _rate(0.4, 0.6), False),
        (_rate(None, None, of=0), _rate(None, None, of=0), False),
        (_rate(0.1, 0.3), None, False),
        (ReportCount(count=1, left_out=0), ReportCount(count=9, left_out=0), False),
        (ReportMix(categories=[], of=0, left_out=0), _rate(0.4, 0.6), False),
    ],
    ids=[
        "separated",
        "separated-reversed",
        "touching",
        "overlapping",
        "nested",
        "zero-of-zero",
        "both-zero-of-zero",
        "missing",
        "counts",
        "mix",
    ],
)
def test_only_disjoint_rate_intervals_are_clearly_different(
    a: ReportRate | ReportCount | ReportMix | None,
    b: ReportRate | ReportCount | ReportMix | None,
    separated: bool,
) -> None:
    assert intervals_separated(a, b) is separated


def _sub_row(row_id: str, subject: UUID, value: ReportRate) -> ReportSubRow:
    return ReportSubRow(
        id=row_id,
        label=row_id,
        values={subject: value},
        breakdowns={ReportSplit.OPENING: {"In": {subject: value}}},
    )


def _report_stat(stat_id: str, rows: list[ReportSubRow]) -> ReportStat:
    return ReportStat(
        id=stat_id,
        label=stat_id,
        group=ReportGroup.OTHER,
        kind=ReportKind.RATE,
        applies_to=ReportSubject.BOTH,
        splits_by=(ReportSplit.OPENING,),
        sub_rows=ReportDimension.SHOT_TYPE,
        rows=rows,
        values={},
        breakdowns={},
    )


def test_compare_stats_marks_sub_rows_and_keeps_rows_only_one_side_has() -> None:
    a, b = uuid4(), uuid4()
    low, high = _rate(0.1, 0.3), _rate(0.6, 0.8)
    compared = compare_stats(
        [
            _report_stat(
                "shots",
                [_sub_row("dink", a, low), _sub_row("drive", a, low), _sub_row("Unknown", a, low)],
            ),
            _report_stat("only_a", [_sub_row("dink", a, low)]),
        ],
        [_report_stat("shots", [_sub_row("dink", b, high), _sub_row("drive", b, _rate(0.2, 0.7))])],
        a,
        b,
    )

    assert [stat.id for stat in compared] == ["shots", "only_a"]
    shots, only_a = compared
    assert [row.id for row in shots.rows] == ["dink", "drive", "Unknown"]
    assert shots.rows[0].values == {a: low, b: high}
    assert shots.row_marks["dink"].clearly_different is True
    assert shots.row_marks["dink"].breakdowns == {ReportSplit.OPENING: ["In"]}
    assert shots.row_marks["drive"].clearly_different is False
    assert shots.row_marks["Unknown"].clearly_different is False
    assert shots.rows[2].values == {a: low}
    assert only_a.rows[0].values == {a: low}
    assert only_a.row_marks["dink"].clearly_different is False


def test_endpoint_lists_choices_and_waits_for_two_subjects(client: TestClient) -> None:
    response = client.get("/api/compare")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    result = response.json()
    assert result["kind"] == "player"
    assert [choice["name"] for choice in result["choices"]] == [
        "Alex One",
        "Avery Two",
        "Blake One",
        "Brook Two",
        "Casey Three",
        "Devon Five",
        "Drew Four",
    ]
    assert (result["a"], result["b"], result["stats"]) == (None, None, [])
    assert result["filter_options"] == {"tournaments": []}

    alex = result["choices"][0]["id"]
    one_side = client.get("/api/compare", params={"a": alex}).json()
    assert one_side["a"]["subject"] == {"id": alex, "name": "Alex One"}
    assert one_side["a"]["header"]["match_count"] == 4
    assert one_side["b"] is None
    assert one_side["stats"] == []
    assert one_side["filter_options"]["tournaments"]

    teams = client.get("/api/compare", params={"kind": "team"}).json()
    assert teams["kind"] == "team"
    assert all(len(choice["players"]) == 2 for choice in teams["choices"])


def test_players_compare_side_by_side_with_marks_only_on_disjoint_rates(
    client: TestClient,
) -> None:
    result = _compare(client, "player", "Alex One", "Avery Two")
    a, b = result["a"]["subject"]["id"], result["b"]["subject"]["id"]
    assert result["a"]["subject"]["name"] == "Alex One"
    assert (result["a"]["header"]["match_count"], result["b"]["header"]["match_count"]) == (4, 2)

    # Player compare hides the team-only stats.
    assert result["stats"]
    assert all(stat["applies_to"] != "team" for stat in result["stats"])

    initiative = _stat(result, "initiative_share")
    assert initiative["marks"]["clearly_different"] is True
    assert intervals_separated(
        ReportRate.model_validate(initiative["values"][a]),
        ReportRate.model_validate(initiative["values"][b]),
    )
    hit_share = _stat(result, "hit_share")
    assert set(hit_share["values"]) == {a, b}
    assert hit_share["marks"]["clearly_different"] is False

    for stat in result["stats"]:
        rows = [(stat["values"], stat["marks"]["clearly_different"])]
        rows += [
            (values, bucket in stat["marks"]["breakdowns"].get(split, []))
            for split, buckets in stat["breakdowns"].items()
            for bucket, values in buckets.items()
        ]
        for row in stat["rows"]:
            marks = stat["row_marks"][row["id"]]
            rows.append((row["values"], marks["clearly_different"]))
            rows += [
                (values, bucket in marks["breakdowns"].get(split, []))
                for split, buckets in row["breakdowns"].items()
                for bucket, values in buckets.items()
            ]
        for values, marked in rows:
            assert set(values) <= {a, b}
            if stat["kind"] not in ("rate", "per100"):
                assert not marked, stat["id"]
                continue
            first, second = values.get(a), values.get(b)
            expected = (
                first is not None
                and second is not None
                and intervals_separated(
                    ReportRate.model_validate(first), ReportRate.model_validate(second)
                )
            )
            assert marked is expected, stat["id"]

    # The marker also applies to each breakdown bucket.
    assert "3" in hit_share["marks"]["breakdowns"]["shot_number"]
    assert "1" not in hit_share["marks"]["breakdowns"]["shot_number"]


def test_teams_compare_team_columns_only(client: TestClient) -> None:
    result = _compare(client, "team", "Alex One / Avery Two", "Blake One / Brook Two")
    a, b = result["a"]["subject"]["id"], result["b"]["subject"]["id"]
    # Team compare hides the player-only stats.
    assert {stat["applies_to"] for stat in result["stats"]} == {"both", "team"}
    opening_win = _stat(result, "opening_win")
    assert opening_win["rows"]
    for stat in result["stats"]:
        assert set(stat["values"]) <= {a, b}
        for row in stat["rows"]:
            assert set(row["values"]) <= {a, b}
    assert set(_stat(result, "serve_in")["values"]) == {a, b}
    court_half = _stat(result, "serve_in")["breakdowns"].get("court_half", {})
    assert not any(court_half.values())


def test_shared_filters_apply_to_both_sides(client: TestClient) -> None:
    tournaments = _compare(client, "player", "Blake One", "Brook Two")["filter_options"][
        "tournaments"
    ]
    mlp = next(t["id"] for t in tournaments if t["name"] == DEMO_MLP_TOURNAMENT)
    filters = {"tournament": mlp, "date_from": str(DEMO_MLP_DATE), "date_to": str(DEMO_MLP_DATE)}
    result = _compare(client, "player", "Blake One", "Brook Two", **filters)
    for side in ("a", "b"):
        subject = result[side]["subject"]["id"]
        report = client.get(f"/api/players/{subject}", params=filters).json()
        assert result[side]["header"] == report["header"]
        assert result[side]["header"]["match_count"] == 1
        hit_share = next(stat for stat in report["stats"] if stat["id"] == "hit_share")
        assert _stat(result, "hit_share")["values"][subject] == hit_share["values"][subject]
    assert result["filter_options"]["tournaments"] == tournaments

    undated = _compare(client, "player", "Alex One", "Blake One", date_from="2000-01-01")
    assert undated["a"]["undated_matches_excluded"] > 0
    assert undated["a"]["header"]["match_count"] < 4


def test_a_side_without_rallies_lines_up_empty_against_the_other(client: TestClient) -> None:
    result = _compare(client, "player", "Devon Five", "Alex One")
    devon, alex = result["a"]["subject"]["id"], result["b"]["subject"]["id"]
    assert result["a"]["header"]["match_count"] == 1
    assert result["a"]["header"]["rallies"]["counted"] == 0
    assert result["b"]["header"]["rallies"]["counted"] > 0
    assert result["stats"]
    assert all(stat["applies_to"] != "team" for stat in result["stats"])
    assert alex in _stat(result, "hit_share")["values"]
    for stat in result["stats"]:
        assert devon not in stat["values"]
        assert stat["marks"]["clearly_different"] is False
        assert not any(stat["marks"]["breakdowns"].values())
        for marks in stat["row_marks"].values():
            assert marks["clearly_different"] is False
            assert not any(marks["breakdowns"].values())


@pytest.mark.parametrize(
    "params",
    [
        {"kind": "coach"},
        {"a": "not-a-uuid"},
        {"date_from": "2026-06-02", "date_to": "2026-06-01"},
        {"partner": "x", "a": "also-not-a-uuid"},
    ],
)
def test_rejects_invalid_parameters(client: TestClient, params: dict[str, str]) -> None:
    assert client.get("/api/compare", params=params).status_code == 422


def test_rejects_the_same_subject_twice_and_unknown_subjects(client: TestClient) -> None:
    alex = _ids(client, "player")["Alex One"]
    assert client.get("/api/compare", params={"a": alex, "b": alex}).status_code == 422
    missing = client.get("/api/compare", params={"a": alex, "b": str(uuid4())})
    assert missing.status_code == 404
    assert missing.json()["detail"].startswith("Player not found")
    # A Player id is not a Team.
    team = client.get("/api/compare", params={"kind": "team", "a": alex})
    assert team.status_code == 404
    assert team.json()["detail"].startswith("Team not found")
