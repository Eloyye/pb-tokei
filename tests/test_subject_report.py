from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from pb_tokei import main
from pb_tokei.annotate.app import create_app
from pb_tokei.demo_match import DEMO_DATE, DEMO_MLP_DATE, DEMO_MLP_TOURNAMENT, write_demo_matches
from pb_tokei.rally_log import FranchiseMatchId, MatchId, RallyLog, TournamentId, new_id

LOCAL = "http://127.0.0.1"


@pytest.fixture
def demo_db(tmp_path: Path) -> tuple[Path, tuple[MatchId, ...]]:
    db = tmp_path / "demo.duckdb"
    with RallyLog.open(db) as log:
        return db, write_demo_matches(log)


def test_indexes_and_detail_endpoints_open_the_whole_demo(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "demo.duckdb"
    assert main(["demo-match", "--many", "--db", str(db)]) == 0
    assert len(set(capsys.readouterr().out.splitlines())) == 4
    with TestClient(create_app(db), base_url=LOCAL) as client:
        players = client.get("/api/players")
        teams = client.get("/api/teams")
        assert players.status_code == teams.status_code == 200
        assert players.headers["Cache-Control"] == teams.headers["Cache-Control"] == "no-store"
        assert [(p["name"], p["handedness"], p["match_count"]) for p in players.json()] == [
            ("Alex One", "right", 4),
            ("Avery Two", "left", 2),
            ("Blake One", "right", 3),
            ("Brook Two", "right", 3),
            ("Casey Three", "left", 2),
            ("Devon Five", "left", 1),
            ("Drew Four", "right", 1),
        ]
        assert [
            ([player["name"] for player in team["players"]], team["match_count"])
            for team in teams.json()
        ] == [
            (["Alex One", "Avery Two"], 2),
            (["Alex One", "Casey Three"], 2),
            (["Blake One", "Brook Two"], 3),
            (["Devon Five", "Drew Four"], 1),
        ]

        for path, entries in (("/api/players", players.json()), ("/api/teams", teams.json())):
            for entry in entries:
                response = client.get(f"{path}/{entry['id']}")
                assert response.status_code == 200
                assert response.headers["Cache-Control"] == "no-store"
                report = response.json()
                count = entry["match_count"]
                assert len(report["matches"]) == report["header"]["match_count"] == count
                assert report["profile"] == {
                    key: value for key, value in entry.items() if key != "match_count"
                }
                assert ("partners" in report) == (path == "/api/players")
                if count == 1:
                    assert report["stats"] == []
                    assert report["header"]["rallies"]["counted"] == 0
                    assert report["matches"][0]["games"] == []
                else:
                    assert report["stats"]
            assert client.get(f"{path}/{uuid4()}").status_code == 404
            assert client.get(f"{path}/not-an-id").status_code == 422


def test_player_history_and_stats_pool_matches_across_teams(
    demo_db: tuple[Path, tuple[MatchId, ...]],
) -> None:
    db, (first, mlp, undated, empty) = demo_db
    with TestClient(create_app(db), base_url=LOCAL) as client:
        alex, avery, *_ = client.get("/api/players").json()
        response = client.get(f"/api/players/{alex['id']}")
        report = response.json()
        assert report["header"]["rallies"] == {
            "counted": 16,
            "done": 12,
            "in_progress": 2,
            "empty": 2,
        }
        assert "tournament" not in report["header"]
        assert "games" not in report["header"]
        assert [m["id"] for m in report["matches"]] == list(map(str, (mlp, empty, first, undated)))
        latest, no_rallies, original, legacy = report["matches"]
        assert latest["date"] == str(DEMO_MLP_DATE)
        assert latest["partner"]["name"] == "Casey Three"
        assert [p["name"] for p in latest["opponents"]["players"]] == ["Blake One", "Brook Two"]
        assert latest["games"] == [{"number": 1, "score": [10, 9]}]
        assert latest["rallies"] == {"counted": 4, "done": 2, "in_progress": 1, "empty": 1}
        assert no_rallies["rallies"]["counted"] == 0
        assert original["date"] == str(DEMO_DATE)
        assert legacy["date"] is None
        assert [(p["player"]["name"], p["match_count"]) for p in report["partners"]] == [
            ("Avery Two", 2),
            ("Casey Three", 2),
        ]
        stats = {stat["id"]: stat for stat in report["stats"]}
        assert all(stat["applies_to"] != "team" for stat in stats.values())
        assert all(set(stat["values"]) <= {alex["id"]} for stat in stats.values())
        serves = stats["serve_in"]["values"][alex["id"]]
        assert (serves["count"], serves["of"], serves["estimate"]) == (8, 8, 1)
        returns = stats["return_in"]["values"][alex["id"]]
        assert (returns["count"], returns["of"], returns["estimate"]) == (2, 2, 1)

        avery_report = client.get(f"/api/players/{avery['id']}").json()
        assert avery_report["played_for"] == []
        team_id = avery_report["partners"][0]["team"]["id"]
        team_report = client.get(f"/api/teams/{team_id}").json()
        assert [m["id"] for m in team_report["matches"]] == list(map(str, (empty, first)))
        assert team_report["header"]["rallies"]["counted"] == 10
        assert any(stat["applies_to"] == "team" for stat in team_report["stats"])

        for subject_report, subject_id in ((avery_report, avery["id"]), (team_report, team_id)):
            faults = next(
                s for s in subject_report["stats"] if s["id"] == "kitchen_faults_per_match"
            )
            assert faults["kind"] == "per_match"
            assert faults["values"][subject_id] == {
                "count": 1,
                "left_out": 0,
                "matches": 2,
                "average": 0.5,
            }
            shots = faults["breakdowns"]["shot_number"]
            assert shots["1"][subject_id]["matches"] == shots["3"][subject_id]["matches"] == 2
            assert shots["1"][subject_id]["average"] == 0
            assert shots["3"][subject_id]["average"] == 0.5

        match_report = client.get(f"/api/matches/{first}/report").json()
        faults = next(s for s in match_report["stats"] if s["id"] == "kitchen_faults_per_match")
        assert faults["kind"] == "count"
        assert faults["values"][team_id] == {"count": 1, "left_out": 0}

        with RallyLog.open(db) as log:
            log.replace_games(mlp, ())
        refreshed = client.get(f"/api/players/{alex['id']}").json()
        assert refreshed["header"]["match_count"] == 4
        assert refreshed["header"]["rallies"]["counted"] == 12
        assert refreshed["matches"][0]["rallies"]["counted"] == 0


def test_played_for_groups_by_franchise_and_tournament_in_both_team_positions(
    demo_db: tuple[Path, tuple[MatchId, ...]],
) -> None:
    db, (_, mlp_id, _, _) = demo_db
    with RallyLog.open(db) as log, log.transaction():
        match = log.load_match(mlp_id)
        same_tournament = MatchId(new_id())
        log.save_match(replace(match, id=same_tournament, games=()))
        assert match.franchise_match_id is not None
        franchise_match = log.get_franchise_match(match.franchise_match_id)
        tournament = log.get_tournament(match.tournament_id)
        finals = replace(tournament, id=TournamentId(new_id()), name="Finals")
        log.save_tournament(finals)
        finals_franchise_match = replace(
            franchise_match,
            id=FranchiseMatchId(new_id()),
            tournament_id=finals.id,
            franchise_a_id=franchise_match.franchise_b_id,
            franchise_b_id=franchise_match.franchise_a_id,
        )
        log.save_franchise_match(finals_franchise_match)
        finals_match = MatchId(new_id())
        log.save_match(
            replace(
                match,
                id=finals_match,
                tournament_id=finals.id,
                team_a_id=match.team_b_id,
                team_b_id=match.team_a_id,
                franchise_match_id=finals_franchise_match.id,
                games=(),
            )
        )

    with TestClient(create_app(db), base_url=LOCAL) as client:
        alex = client.get("/api/players").json()[0]
        report = client.get(f"/api/players/{alex['id']}").json()
        assert report["matches"][0]["id"] == str(finals_match)  # Same day, earlier name.
        assert report["played_for"] == [
            {
                "id": str(franchise_match.franchise_b_id),
                "name": "Synthetic Volleys",
                "tournaments": [
                    {"id": str(finals.id), "name": "Finals", "match_count": 1},
                    {
                        "id": str(tournament.id),
                        "name": DEMO_MLP_TOURNAMENT,
                        "match_count": 2,
                    },
                ],
            }
        ]
