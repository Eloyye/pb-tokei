from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from pb_tokei.annotate.app import create_app
from pb_tokei.demo_match import (
    DEMO_MLP_DATE,
    DEMO_MLP_TOURNAMENT,
    DEMO_TOURNAMENT,
    write_demo_matches,
)
from pb_tokei.events.stats import wilson_interval
from pb_tokei.rally_log import RallyLog


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    db = tmp_path_factory.mktemp("leaderboard") / "demo.duckdb"
    with RallyLog.open(db) as log:
        write_demo_matches(log)
    with TestClient(create_app(db), base_url="http://127.0.0.1") as client:
        yield client


def test_default_endpoint_lists_rankable_stats_and_hides_small_samples(client: TestClient) -> None:
    response = client.get("/api/leaderboard")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    result = response.json()
    assert result["stat"] == "serve_in"
    assert result["bucket"] is None
    assert result["hidden_count"] == 7
    assert result["match_count"] == 4
    assert result["rows"] == []
    assert set(result["filter_options"]) == {"tournaments"}
    assert result["buckets"]["shot_number"] == ["1", "2", "3", "4", "5", "6–10", "11+", "Unknown"]

    options = {stat["id"]: stat for stat in result["stats"]}
    assert options["serve_in"] == {
        "id": "serve_in",
        "label": "Serves in",
        "group": "Serve & Return",
        "kind": "rate",
        "applies_to": "both",
        "splits_by": ["rally_phase", "shot_number", "opening", "court_half"],
    }
    assert options["dink_errors"]["kind"] == "per100"
    assert options["hit_share"]["applies_to"] == "player"
    assert options["opening_win"]["applies_to"] == "team"
    assert options["challenge_success"]["splits_by"] == []
    assert {stat["kind"] for stat in options.values()} == {"rate", "per100"}
    assert (
        not {
            "serves",
            "speedup_success",
            "shot_advantage",
            "shot_disadvantage",
            "kitchen_faults_per_match",
        }
        & options.keys()
    )


def test_players_rank_by_pooled_estimate_and_include_the_exact_minimum(client: TestClient) -> None:
    result = client.get("/api/leaderboard", params={"stat": "hit_share", "minimum": 15}).json()
    assert result["hidden_count"] == 3
    assert {row["kind"] for row in result["rows"]} == {"player"}
    assert [
        (row["rank"], row["subject"]["name"], row["value"]["count"], row["value"]["of"])
        for row in result["rows"]
    ] == [
        (1, "Avery Two", 9, 15),
        (2, "Blake One", 10, 18),
        (3, "Alex One", 9, 20),
        (4, "Brook Two", 8, 18),
    ]


def test_single_bucket_pools_attempts_before_calculating_the_interval(client: TestClient) -> None:
    result = client.get(
        "/api/leaderboard",
        params={"stat": "hit_share", "minimum": 1, "by": "shot_number", "bucket": "3"},
    ).json()
    assert result["bucket"] == "3"
    assert result["hidden_count"] == 2
    assert [row["rank"] for row in result["rows"]] == [1, 1, 1, 4, 4]
    alex = next(row for row in result["rows"] if row["subject"]["name"] == "Alex One")["value"]
    assert alex == {
        "count": 0,
        "of": 6,
        "estimate": 0,
        "low": 0,
        "high": pytest.approx(0.310784),
        "left_out": 0,
    }

    per100 = client.get(
        "/api/leaderboard",
        params={
            "stat": "dink_errors",
            "minimum": 1,
            "by": "opening",
            "bucket": "After the Opening (6+)",
        },
    ).json()
    brook = next(row for row in per100["rows"] if row["subject"]["name"] == "Brook Two")["value"]
    interval = wilson_interval(0, 3)
    assert interval is not None
    assert brook["of"] == 3
    assert (brook["low"], brook["high"]) == pytest.approx([bound * 100 for bound in interval])


def test_buckets_account_for_every_attempt_including_unknown_court_half(client: TestClient) -> None:
    params = {"stat": "hit_share", "minimum": 1}
    overall = client.get("/api/leaderboard", params=params).json()
    alex = next(row for row in overall["rows"] if row["subject"]["name"] == "Alex One")
    values_by_bucket = {}
    for bucket in overall["buckets"]["court_half"]:
        result = client.get(
            "/api/leaderboard", params={**params, "by": "court_half", "bucket": bucket}
        ).json()
        for row in result["rows"]:
            if row["subject"]["id"] == alex["subject"]["id"]:
                values_by_bucket[bucket] = row["value"]

    assert values_by_bucket["Unknown"]["of"] == 1
    assert values_by_bucket["Left"]["of"] == 19
    for field in ("count", "of"):
        assert sum(value[field] for value in values_by_bucket.values()) == alex["value"][field]


def test_team_only_rate_pools_disjoint_serving_and_receiving_rows(client: TestClient) -> None:
    result = client.get(
        "/api/leaderboard", params={"kind": "team", "stat": "opening_win", "minimum": 1}
    ).json()
    assert result["hidden_count"] == 1
    assert {row["kind"] for row in result["rows"]} == {"team"}
    assert [(row["value"]["count"], row["value"]["of"]) for row in result["rows"]] == [
        (2, 3),
        (4, 8),
        (2, 5),
    ]
    first = result["rows"][0]["subject"]
    assert [player["name"] for player in first["players"]] == ["Alex One", "Casey Three"]


def test_team_bucket_applies_tournament_tour_and_inclusive_dates(client: TestClient) -> None:
    tournaments = client.get("/api/leaderboard").json()["filter_options"]["tournaments"]
    tournament = {option["name"]: option["id"] for option in tournaments}
    result = client.get(
        "/api/leaderboard",
        params={
            "kind": "team",
            "minimum": 1,
            "by": "shot_number",
            "tour": "mlp",
            "tournament": list(tournament.values()),
            "date_from": str(DEMO_MLP_DATE),
            "date_to": str(DEMO_MLP_DATE),
        },
    ).json()
    assert result["bucket"] == "1"
    assert result["match_count"] == 1
    assert result["hidden_count"] == 1
    [row] = result["rows"]
    assert [p["name"] for p in row["subject"]["players"]] == ["Blake One", "Brook Two"]
    assert (row["value"]["count"], row["value"]["of"]) == (2, 2)
    assert result["filter_options"]["tournaments"] == tournaments

    ppa = client.get(
        "/api/leaderboard",
        params={
            "minimum": 1,
            "tournament": tournament[DEMO_TOURNAMENT],
            "date_from": str(DEMO_MLP_DATE),
        },
    ).json()
    assert (ppa["match_count"], ppa["undated_matches_excluded"], ppa["hidden_count"]) == (0, 1, 0)
    mlp = client.get(
        "/api/leaderboard", params={"tournament": tournament[DEMO_MLP_TOURNAMENT]}
    ).json()
    assert mlp["match_count"] == 1


@pytest.mark.parametrize(
    "params",
    [
        {"stat": "serves"},
        {"stat": "speedup_success"},
        {"stat": "kitchen_faults_per_match"},
        {"stat": "opening_win"},
        {"kind": "team", "stat": "hit_share"},
        {"stat": "challenge_success", "by": "shot_number"},
        {"kind": "team", "by": "court_half"},
        {"bucket": "3"},
        {"by": "shot_number", "bucket": "6"},
        {"minimum": 0},
        {"date_from": "2026-06-02", "date_to": "2026-06-01"},
    ],
)
def test_rejects_incompatible_ranking_and_filter_parameters(
    client: TestClient, params: dict[str, str | int]
) -> None:
    assert client.get("/api/leaderboard", params=params).status_code == 422
