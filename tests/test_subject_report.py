from dataclasses import replace
from datetime import date
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from pb_tokei import main
from pb_tokei.annotate.app import create_app
from pb_tokei.demo_match import DEMO_DATE, DEMO_MLP_DATE, DEMO_MLP_TOURNAMENT, write_demo_matches
from pb_tokei.rally_log import (
    FranchiseMatchId,
    Game,
    Gender,
    Handedness,
    Match,
    MatchId,
    Player,
    PlayerId,
    Rally,
    RallyLog,
    RallyStatus,
    Team,
    TeamId,
    Tour,
    TournamentId,
    new_id,
)

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
        assert [
            (p["name"], p["handedness"], p["gender"], p["match_count"]) for p in players.json()
        ] == [
            ("Alex One", "right", "male", 4),
            ("Avery Two", "left", "female", 2),
            ("Blake One", "right", "male", 3),
            ("Brook Two", "right", "female", 3),
            ("Casey Three", "left", "female", 2),
            ("Devon Five", "left", "female", 1),
            ("Drew Four", "right", "male", 1),
        ]
        assert [
            (
                [player["name"] for player in team["players"]],
                team["discipline"],
                team["match_count"],
            )
            for team in teams.json()
        ] == [
            (["Alex One", "Avery Two"], "mixed_doubles", 2),
            (["Alex One", "Casey Three"], "mixed_doubles", 2),
            (["Blake One", "Brook Two"], "mixed_doubles", 3),
            (["Devon Five", "Drew Four"], "mixed_doubles", 1),
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
                "matches": 1,
                "average": 1,
            }
            shots = faults["breakdowns"]["shot_number"]
            assert shots["1"][subject_id]["matches"] == shots["3"][subject_id]["matches"] == 1
            assert shots["1"][subject_id]["average"] == 0
            assert shots["3"][subject_id]["average"] == 1

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


def test_player_filters_select_whole_matches_and_pool_only_their_stats(
    demo_db: tuple[Path, tuple[MatchId, ...]],
) -> None:
    db, (first, mlp, undated, empty) = demo_db
    app_match_id = MatchId(new_id())
    with RallyLog.open(db) as log, log.transaction():
        original = log.load_match(first)
        ppa = log.get_tournament(original.tournament_id)
        app = replace(ppa, id=TournamentId(new_id()), tour=Tour.APP)
        log.save_tournament(app)
        log.save_match(
            replace(original, id=app_match_id, tournament_id=app.id, date=date(2026, 5, 5))
        )
        mlp_tournament = log.load_match(mlp).tournament_id

    with TestClient(create_app(db), base_url=LOCAL) as client:
        players = {player["name"]: player["id"] for player in client.get("/api/players").json()}
        alex = players["Alex One"]
        endpoint = f"/api/players/{alex}"
        all_matches = client.get(endpoint).json()
        options = all_matches["filter_options"]
        assert {item["id"]: item["tour"] for item in options["tournaments"]} == {
            str(ppa.id): "ppa",
            str(app.id): "app",
            str(mlp_tournament): "mlp",
        }
        assert [p["name"] for p in options["partners"]] == ["Avery Two", "Casey Three"]
        assert [p["name"] for p in options["opponents"]] == [
            "Blake One",
            "Brook Two",
            "Devon Five",
            "Drew Four",
        ]
        both_tournaments = [str(ppa.id), str(mlp_tournament)]
        cases = [
            ({"tournament": [str(ppa.id)]}, [empty, first, undated], 12, 0),
            ({"tournament": both_tournaments}, [mlp, empty, first, undated], 16, 0),
            ({"tour": "mlp"}, [mlp], 4, 0),
            ({"tour": "app"}, [app_match_id], 10, 0),
            ({"date_from": str(DEMO_MLP_DATE)}, [mlp], 4, 1),
            ({"date_to": str(DEMO_DATE)}, [first], 10, 1),
            ({"partner": players["Casey Three"]}, [mlp, undated], 6, 0),
            ({"partner": players["Blake One"]}, [], 0, 0),
            ({"opponent": players["Casey Three"]}, [], 0, 0),
            ({"opponent": players["Brook Two"]}, [mlp, app_match_id, first, undated], 26, 0),
            ({"opponent": players["Drew Four"]}, [empty], 0, 0),
        ]
        combined = {
            "tournament": both_tournaments,
            "tour": "ppa",
            "date_from": str(DEMO_DATE),
            "date_to": str(DEMO_DATE),
            "partner": players["Avery Two"],
            "opponent": players["Blake One"],
        }
        cases += [
            (combined, [first], 10, 0),
            ({**combined, "partner": players["Casey Three"]}, [], 0, 1),
        ]
        for query, match_ids, counted, excluded in cases:
            response = client.get(endpoint, params=query)
            assert response.status_code == 200, response.text
            report = response.json()
            assert [m["id"] for m in report["matches"]] == list(map(str, match_ids)), query
            assert report["header"]["match_count"] == len(match_ids), query
            assert report["header"]["rallies"]["counted"] == counted, query
            assert report["undated_matches_excluded"] == excluded, query
            assert report["filter_options"] == options
            assert bool(report["stats"]) == bool(counted), query

        filtered = client.get(endpoint, params=combined).json()
        for report, expected_serves in ((all_matches, 14), (filtered, 6)):
            serve_in = next(s for s in report["stats"] if s["id"] == "serve_in")
            assert (
                serve_in["values"][alex]["count"]
                == serve_in["values"][alex]["of"]
                == expected_serves
            )


def test_team_filters_use_the_opposing_team_and_exclude_undated_matches(
    demo_db: tuple[Path, tuple[MatchId, ...]],
) -> None:
    db, (_, mlp, undated, _) = demo_db
    with RallyLog.open(db) as log:
        mlp_match = log.load_match(mlp)

    with TestClient(create_app(db), base_url=LOCAL) as client:
        endpoint = f"/api/teams/{mlp_match.team_b_id}"
        players = {player["name"]: player["id"] for player in client.get("/api/players").json()}
        unfiltered = client.get(endpoint).json()
        assert [m["id"] for m in unfiltered["matches"]] == list(map(str, (mlp, undated)))
        options = unfiltered["filter_options"]
        assert options["partners"] == []
        assert [p["name"] for p in options["opponents"]] == ["Blake One", "Brook Two"]

        dated = client.get(endpoint, params={"date_to": str(DEMO_MLP_DATE)}).json()
        assert [m["id"] for m in dated["matches"]] == [str(mlp)]
        assert dated["undated_matches_excluded"] == 1

        response = client.get(
            endpoint,
            params={
                "tournament": [item["id"] for item in options["tournaments"]],
                "tour": "mlp",
                "date_from": str(DEMO_MLP_DATE),
                "date_to": str(DEMO_MLP_DATE),
                "opponent": players["Brook Two"],
            },
        )
        assert response.status_code == 200
        report = response.json()
        assert [m["id"] for m in report["matches"]] == [str(mlp)]
        assert report["header"]["match_count"] == 1
        assert report["header"]["rallies"]["counted"] == 4
        assert report["undated_matches_excluded"] == 0
        assert any(stat["applies_to"] == "team" for stat in report["stats"])
        same_team = client.get(endpoint, params={"opponent": players["Casey Three"]}).json()
        assert same_team["matches"] == same_team["stats"] == []


def test_details_validate_filter_query_parameters(
    demo_db: tuple[Path, tuple[MatchId, ...]],
) -> None:
    db, _ = demo_db
    with TestClient(create_app(db), base_url=LOCAL) as client:
        for collection in ("players", "teams"):
            subject = client.get(f"/api/{collection}").json()[0]
            endpoint = f"/api/{collection}/{subject['id']}"
            queries = [
                ("tournament", "no-id"),
                ("tour", "other"),
                ("date_to", "2026-02-30"),
                ("opponent", "no-id"),
            ]
            if collection == "players":
                queries.extend([("partner", "no-id"), ("discipline", "singles")])
            for key, value in queries:
                response = client.get(endpoint, params={key: value})
                assert response.status_code == 422
                assert response.json()["detail"][0]["loc"][:2] == ["query", key]
            reversed_range = client.get(
                endpoint, params={"date_from": str(DEMO_MLP_DATE), "date_to": str(DEMO_DATE)}
            )
            assert reversed_range.status_code == 422
            detail = reversed_range.json()["detail"][0]
            assert "Date from must be on or before Date to." in detail["msg"]


@pytest.mark.parametrize("status", [RallyStatus.EMPTY, RallyStatus.IN_PROGRESS])
def test_per_match_denominator_updates_as_soon_as_a_match_has_a_rally(
    demo_db: tuple[Path, tuple[MatchId, ...]], status: RallyStatus
) -> None:
    db, (_, _, _, empty) = demo_db
    with TestClient(create_app(db), base_url=LOCAL) as client:
        avery = next(p for p in client.get("/api/players").json() if p["name"] == "Avery Two")
        endpoint = f"/api/players/{avery['id']}"

        def faults() -> tuple[int, int, float]:
            report = client.get(endpoint).json()
            assert report["header"]["match_count"] == 2
            stat = next(s for s in report["stats"] if s["id"] == "kitchen_faults_per_match")
            value = stat["values"][avery["id"]]
            return value["count"], value["matches"], value["average"]

        assert faults() == (1, 1, 1.0)
        with RallyLog.open(db) as log:
            log.replace_games(empty, (Game(1, (Rally(1, status=status),)),))
        assert faults() == (1, 2, 0.5)


def test_batch_game_reads_keep_rallies_shots_and_positions_separate_across_matches(
    demo_db: tuple[Path, tuple[MatchId, ...]],
) -> None:
    db, (first, _, undated, empty) = demo_db
    with RallyLog.open(db) as log, log.transaction():
        selected = (undated, first, empty)
        snapshots = log.load_match_games(selected)
        metadata = log.load_match_metadata(selected)
        assert log.load_match_games_from_metadata(metadata.values()) == snapshots
        assert set(snapshots) == set(selected)
        for match_id in selected:
            assert snapshots[match_id].games == log.get_games(match_id)
        assert snapshots[undated].date is None
        assert snapshots[first].date == DEMO_DATE
        assert snapshots[empty].games == ()


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


def test_discipline_filter_on_player_report_excludes_unclassified_and_respects_other_filters(
    demo_db: tuple[Path, tuple[MatchId, ...]],
) -> None:
    db, (first, mlp, undated, empty) = demo_db
    mens_match_id = MatchId(new_id())
    legacy_match_id = MatchId(new_id())
    with RallyLog.open(db) as log, log.transaction():
        alex = log.find_player("Alex One")
        blake = log.find_player("Blake One")
        assert alex is not None and blake is not None
        original = log.load_match(first)
        # Add a Men's Doubles Match with Alex + a male partner vs Blake + a male partner.
        m_partner = Player(PlayerId(new_id()), "Max Partner", Handedness.RIGHT, Gender.MALE)
        m_opp = Player(PlayerId(new_id()), "Leo Opp", Handedness.RIGHT, Gender.MALE)
        log.save_player(m_partner)
        log.save_player(m_opp)
        mens_a = Team(TeamId(new_id()), (alex.id, m_partner.id))
        mens_b = Team(TeamId(new_id()), (blake.id, m_opp.id))
        log.save_team(mens_a)
        log.save_team(mens_b)
        log.save_match(
            Match(
                id=mens_match_id,
                tournament_id=original.tournament_id,
                team_a_id=mens_a.id,
                team_b_id=mens_b.id,
                date=date(2026, 5, 1),
            )
        )
        # Add a legacy unclassified Match where Alex's partner has gender=None (and no date).
        legacy_partner = Player(PlayerId(new_id()), "Pat Legacy", Handedness.LEFT, None)
        log.save_player(legacy_partner)
        legacy_a = Team(TeamId(new_id()), (alex.id, legacy_partner.id))
        log.save_team(legacy_a)
        log.save_match(
            Match(
                id=legacy_match_id,
                tournament_id=original.tournament_id,
                team_a_id=legacy_a.id,
                team_b_id=mens_b.id,
                date=None,
            )
        )

    with TestClient(create_app(db), base_url=LOCAL) as client:
        # Match report exposes derived Discipline (and None for legacy Match).
        assert client.get(f"/api/matches/{first}/report").json()["header"]["discipline"] == (
            "mixed_doubles"
        )
        assert client.get(f"/api/matches/{mens_match_id}/report").json()["header"][
            "discipline"
        ] == ("mens_doubles")
        assert (
            client.get(f"/api/matches/{legacy_match_id}/report").json()["header"]["discipline"]
            is None
        )

        # Unfiltered Player report includes all 6 Matches with 0 unclassified excluded.
        all_report = client.get(f"/api/players/{alex.id}").json()
        assert len(all_report["matches"]) == 6
        assert all_report["unclassified_matches_excluded"] == 0
        by_id = {m["id"]: m["discipline"] for m in all_report["matches"]}
        assert by_id[str(first)] == "mixed_doubles"
        assert by_id[str(mens_match_id)] == "mens_doubles"
        assert by_id[str(legacy_match_id)] is None

        # Filtering by mens_doubles picks only mens_match_id and reports 1 unclassified excluded
        # (NOT the 4 Mixed Doubles Matches, which are definite mismatches).
        mens = client.get(f"/api/players/{alex.id}", params={"discipline": "mens_doubles"}).json()
        assert [m["id"] for m in mens["matches"]] == [str(mens_match_id)]
        assert mens["unclassified_matches_excluded"] == 1
        assert mens["undated_matches_excluded"] == 0

        # Filtering by mixed_doubles picks the 4 demo Mixed Doubles Matches and excludes 1 legacy.
        mixed = client.get(f"/api/players/{alex.id}", params={"discipline": "mixed_doubles"}).json()
        assert [m["id"] for m in mixed["matches"]] == list(map(str, (mlp, empty, first, undated)))
        assert mixed["unclassified_matches_excluded"] == 1

        # Combining discipline=mens_doubles + date_from=2026-04-01:
        # the 4 Mixed Doubles Matches (including undated!) are definite Discipline mismatches,
        # so undated_matches_excluded is ONLY 1 (legacy_match_id, which is both undated and
        # unclassified), NOT 2!
        combined = client.get(
            f"/api/players/{alex.id}",
            params={"discipline": "mens_doubles", "date_from": "2026-04-01"},
        ).json()
        assert [m["id"] for m in combined["matches"]] == [str(mens_match_id)]
        assert combined["undated_matches_excluded"] == 1
        assert combined["unclassified_matches_excluded"] == 1
