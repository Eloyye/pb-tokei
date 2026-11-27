"""The Match report's rollups and the JSON served from the current Rally Log."""

from collections import Counter
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from pb_tokei import main
from pb_tokei.annotate.app import create_app
from pb_tokei.demo_match import DEMO_DATE, DEMO_TOURNAMENT, write_demo_match
from pb_tokei.events import (
    CourtHalf,
    ExchangeOutcome,
    OutcomeReason,
    RallyPhase,
    ShotType,
    Stat,
    StatRow,
    SubjectKind,
    compute_stats,
    wilson_interval,
)
from pb_tokei.events.report import (
    STAT_DEFINITIONS,
    ReportCount,
    ReportGroup,
    ReportKind,
    ReportMix,
    ReportRate,
    ReportSplit,
    build_report,
)
from pb_tokei.events.stats import ShotBreakdown, StatBreakdown, StatSubject
from pb_tokei.rally_log import (
    UNKNOWN,
    Game,
    Match,
    MatchId,
    MatchRoster,
    ObservationGap,
    Parity,
    Rally,
    RallyLog,
    RallyStatus,
    Score,
    Shot,
    observed,
)

OVERALL = StatBreakdown()


@pytest.fixture(scope="module")
def demo() -> tuple[Match, MatchRoster]:
    with RallyLog.open(":memory:") as log:
        match_id = write_demo_match(log)
        return log.load_match(match_id), log.get_match_roster(match_id)


def tally(
    stat: Stat,
    subject: StatSubject,
    count: int,
    total: int | None = None,
    excluded: int = 0,
    *,
    breakdown: StatBreakdown = OVERALL,
) -> StatRow:
    return StatRow(
        stat,
        subject,
        breakdown,
        count,
        total,
        excluded,
        None if total is None else wilson_interval(count, total),
    )


def test_every_stat_has_a_label_and_group() -> None:
    assert set(STAT_DEFINITIONS) == set(Stat)
    for definition in STAT_DEFINITIONS.values():
        assert definition.label.strip()
        assert isinstance(definition.group, ReportGroup)


def score_for(demo: tuple[Match, MatchRoster], *rallies: Rally) -> tuple[int, int] | None:
    match, roster = demo
    report = build_report(replace(match, games=(Game(1, rallies),)), roster, DEMO_TOURNAMENT, ())
    return report.header.games[0].score


@pytest.mark.parametrize("opening_hitter", ["serve", "return_after_gap", "recorded_returner"])
def test_game_score_resolves_the_serving_team_from_opening_hitters(
    demo: tuple[Match, MatchRoster], opening_hitter: str
) -> None:
    _, roster = demo
    rally = Rally(1, score=observed(Score(6, 8, 1)), winner_id=observed(roster.team_b_id))
    returner = roster.team_a_players[0].id
    if opening_hitter == "serve":
        # A known Shot 1 hitter provides the Serving Team even with the Server field Unknown.
        rally = replace(rally, entries=(Shot(hitter_id=observed(roster.team_b_players[0].id)),))
    elif opening_hitter == "return_after_gap":
        rally = replace(
            rally,
            entries=(
                ObservationGap(Parity.ODD),
                Shot(shot_number=observed(2), hitter_id=observed(returner)),
            ),
        )
    else:
        rally = replace(rally, returner_id=observed(returner))
    assert score_for(demo, rally) == (8, 7)


def test_game_score_swaps_a_team_b_call_and_advances_only_for_serving_wins(
    demo: tuple[Match, MatchRoster],
) -> None:
    _, roster = demo
    side_out = Rally(
        1,
        score=observed(Score(6, 8, 2)),
        serving_team_id=observed(roster.team_b_id),
        winner_id=observed(roster.team_a_id),
    )
    a_scores = Rally(
        2, serving_team_id=observed(roster.team_a_id), winner_id=observed(roster.team_a_id)
    )
    assert score_for(demo, side_out) == (8, 6)
    assert score_for(demo, side_out, a_scores) == (9, 6)


@pytest.mark.parametrize("missing", ["rally", "winner", "serving_team"])
def test_game_score_keeps_the_last_known_score_until_a_new_call(
    demo: tuple[Match, MatchRoster], missing: str
) -> None:
    _, roster = demo
    team = observed(roster.team_a_id)
    first = Rally(1, score=observed(Score(7, 3, 1)), serving_team_id=team, winner_id=team)
    next_known = Rally(3, serving_team_id=team, winner_id=team)
    rallies = [first]
    if missing == "winner":
        rallies.append(Rally(2, serving_team_id=team))
    elif missing == "serving_team":
        rallies.append(Rally(2, winner_id=team))
    rallies.append(next_known)

    assert score_for(demo, *rallies) == (8, 3)
    fresh_call = Rally(4, score=observed(Score(9, 4, 1)), serving_team_id=team, winner_id=team)
    assert score_for(demo, *rallies, fresh_call) == (10, 4)


def test_game_score_handles_tied_unknown_calls_and_games_without_scores(
    demo: tuple[Match, MatchRoster],
) -> None:
    _, roster = demo
    tied = Rally(1, score=observed(Score(4, 4, 2)))
    assert score_for(demo, tied) == (4, 4)
    assert score_for(demo, replace(tied, score=observed(Score(4, 5, 2)))) is None
    team = observed(roster.team_a_id)
    assert (
        score_for(demo, replace(tied, score=UNKNOWN, serving_team_id=team, winner_id=team)) is None
    )
    assert score_for(demo) is None


def test_one_dimension_pools_shot_rows_and_recomputes_the_interval(
    demo: tuple[Match, MatchRoster],
) -> None:
    match, roster = demo
    player = roster.team_a_players[0].id
    subject = StatSubject(SubjectKind.PLAYER, roster.team_a_id, player)
    rows = (
        tally(Stat.DINK_ERRORS, subject, 4, 10, 4),
        tally(
            Stat.DINK_ERRORS,
            subject,
            2,
            3,
            1,
            breakdown=StatBreakdown(
                shot=ShotBreakdown(
                    6, RallyPhase.FRONTCOURT_BATTLE, False, ShotType.DINK, CourtHalf.LEFT
                ),
            ),
        ),
        tally(
            Stat.DINK_ERRORS,
            subject,
            1,
            5,
            2,
            breakdown=StatBreakdown(
                shot=ShotBreakdown(
                    10, RallyPhase.FRONTCOURT_BATTLE, False, ShotType.DINK, CourtHalf.RIGHT
                ),
            ),
        ),
        tally(
            Stat.DINK_ERRORS,
            subject,
            1,
            2,
            1,
            breakdown=StatBreakdown(
                shot=ShotBreakdown(None, None, None, ShotType.DINK),
            ),
        ),
    )
    report = build_report(match, roster, DEMO_TOURNAMENT, rows)
    stat = next(stat for stat in report.stats if stat.id == Stat.DINK_ERRORS)
    assert stat.kind is ReportKind.PER100
    assert isinstance(overall := stat.values[player], ReportRate)
    assert (overall.count, overall.of, overall.estimate, overall.left_out) == (4, 10, 40, 4)

    assert (interval := wilson_interval(3, 8)) is not None
    expected = ReportRate(
        count=3, of=8, estimate=37.5, low=interval[0] * 100, high=interval[1] * 100, left_out=3
    )
    assert stat.breakdowns[ReportSplit.RALLY_PHASE]["Frontcourt Battle"][player] == expected
    assert stat.breakdowns[ReportSplit.SHOT_NUMBER]["6–10"][player] == expected
    assert stat.breakdowns[ReportSplit.OPENING]["After the Opening (6+)"][player] == expected
    for split in ReportSplit:
        assert isinstance(unknown := stat.breakdowns[split]["Unknown"][player], ReportRate)
        assert (unknown.count, unknown.of, unknown.left_out) == (1, 2, 1)
    assert isinstance(left := stat.breakdowns[ReportSplit.COURT_HALF]["Left"][player], ReportRate)
    assert (left.count, left.of) == (2, 3)
    serves = next(stat for stat in report.stats if stat.id == Stat.SERVES)
    assert "Unknown" not in serves.breakdowns[ReportSplit.SHOT_NUMBER]


def test_report_keeps_category_intervals_and_computes_neutral(
    demo: tuple[Match, MatchRoster],
) -> None:
    match, roster = demo
    team = roster.team_a_id
    subject = StatSubject(SubjectKind.TEAM, team)
    dink = StatBreakdown(shot_type=ShotType.DINK)
    rows = (
        tally(Stat.SHOT_ADVANTAGE, subject, 4, 10, 2, breakdown=dink),
        tally(Stat.SHOT_DISADVANTAGE, subject, 3, 10, 2, breakdown=dink),
        tally(
            Stat.OUTCOME_REASON, subject, 4, breakdown=replace(dink, category=OutcomeReason.WINNER)
        ),
        tally(
            Stat.OUTCOME_REASON, subject, 3, breakdown=replace(dink, category=OutcomeReason.NO_GAIN)
        ),
        tally(Stat.OUTCOME_REASON, subject, 0, excluded=2, breakdown=dink),
        *(
            tally(
                Stat.SPEEDUP_RECEIVED,
                subject,
                count,
                10,
                2,
                breakdown=StatBreakdown(category=category),
            )
            for category, count in zip(ExchangeOutcome, (2, 3, 5), strict=True)
        ),
    )
    report = {stat.id: stat for stat in build_report(match, roster, DEMO_TOURNAMENT, rows).stats}
    outcome = next(row for row in report["shot_outcome"].rows if row.id == ShotType.DINK)
    assert isinstance(mix := outcome.values[team], ReportMix)
    assert (mix.of, mix.left_out) == (10, 2)
    assert [c.id for c in mix.categories] == ["advantage", "neutral", "disadvantage"]
    for category, count in zip(mix.categories, (4, 3, 3), strict=True):
        assert (category.count, category.estimate) == (count, count / 10)
        assert (category.low, category.high) == wilson_interval(count, 10)

    reasons = next(row for row in report[Stat.OUTCOME_REASON].rows if row.id == ShotType.DINK)
    assert reasons.values[team].model_dump(exclude_unset=True) == {
        "categories": [
            {"id": "winner", "label": "Winner", "count": 4},
            {"id": "no_gain", "label": "No gain", "count": 3},
        ],
        "of": 7,
        "left_out": 2,
    }
    assert isinstance(exchanges := report[Stat.SPEEDUP_RECEIVED].values[team], ReportMix)
    assert [(c.id, c.count) for c in exchanges.categories] == [
        ("won", 2),
        ("lost", 3),
        ("neutral", 5),
    ]
    assert (exchanges.categories[2].low, exchanges.categories[2].high) == wilson_interval(5, 10)


def test_uncredited_observations_do_not_duplicate_team_player_categories_or_shot_rows(
    demo: tuple[Match, MatchRoster],
) -> None:
    match, roster = demo
    team = roster.team_a_id
    unknown = StatSubject(SubjectKind.PLAYER, None)
    known = StatSubject(SubjectKind.TEAM, team)
    rows = (
        tally(Stat.SERVES, known, 1),
        tally(Stat.SERVES, StatSubject(SubjectKind.PLAYER, team), 0, excluded=1),
        tally(Stat.SERVES, unknown, 0, excluded=2),
        tally(Stat.SERVES, StatSubject(SubjectKind.TEAM, None), 0, excluded=2),
        tally(
            Stat.SERVES,
            unknown,
            0,
            excluded=2,
            breakdown=StatBreakdown(
                shot=ShotBreakdown(1, RallyPhase.SERVE, True, ShotType.SERVE),
            ),
        ),
        *(
            tally(
                Stat.SPEEDUP_INITIATED, unknown, 0, 0, 1, breakdown=StatBreakdown(category=category)
            )
            for category in ExchangeOutcome
        ),
        tally(Stat.HIT_SHARE, unknown, 0, 0, 4),
    )
    report = build_report(match, roster, DEMO_TOURNAMENT, rows)
    assert report.header.uncredited == 7
    assert report.stats[0].values == {team: ReportCount(count=1, left_out=0)}
    assert report.stats[0].breakdowns[ReportSplit.SHOT_NUMBER]["1"] == {}


def test_demo_exercises_every_display_kind_and_split_bucket(
    demo: tuple[Match, MatchRoster],
) -> None:
    match, roster = demo
    report = build_report(match, roster, DEMO_TOURNAMENT, compute_stats(((match, roster),)))
    assert {stat.kind for stat in report.stats} == set(ReportKind)
    assert {stat.group for stat in report.stats} == set(ReportGroup)
    assert report.header.uncredited > 0
    left_out = Counter()
    buckets = {split: set() for split in ReportSplit}
    for stat in report.stats:
        for row in (stat, *stat.rows):
            left_out[stat.kind] += sum(value.left_out for value in row.values.values())
            for split, values in row.breakdowns.items():
                buckets[split].update(bucket for bucket, subjects in values.items() if subjects)
                if split is ReportSplit.COURT_HALF:
                    assert all(roster.team_a_id not in subjects for subjects in values.values())
                    assert all(roster.team_b_id not in subjects for subjects in values.values())
    assert left_out.total() > 0
    assert buckets == {
        ReportSplit.RALLY_PHASE: {
            "Serve",
            "Return",
            "Transition",
            "Frontcourt Battle",
            "Scramble",
            "Unknown",
        },
        ReportSplit.SHOT_NUMBER: {"1", "2", "3", "4", "5", "6–10", "11+", "Unknown"},
        ReportSplit.OPENING: {"In the Opening (Shots 1–5)", "After the Opening (6+)", "Unknown"},
        ReportSplit.COURT_HALF: {"Left", "Right", "Unknown"},
    }
    assert [
        row.id for row in next(stat for stat in report.stats if stat.id == Stat.RETURNER_ZONE).rows
    ] == ["3", "5"]
    assert [
        row.id
        for row in next(stat for stat in report.stats if stat.id == "shot_outcome").rows[
            : len(ShotType)
        ]
    ] == list(ShotType)


def test_report_endpoint_reads_the_current_saved_match(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "demo.duckdb"
    assert main(["demo-match", "--db", str(db)]) == 0
    match_id = capsys.readouterr().out.strip()
    endpoint = f"/api/matches/{match_id}/report"
    local = "http://127.0.0.1"

    with TestClient(create_app(db), base_url=local) as client:
        response = client.get(endpoint)
        assert response.status_code == 200
        assert response.headers["Cache-Control"] == "no-store"
        body = response.json()
        header = body["header"]
        assert header["tournament"] == DEMO_TOURNAMENT
        assert header["games"] == [
            {"number": 1, "score": [11, 8]},
            {"number": 2, "score": [7, 11]},
            {"number": 3, "score": [9, 10]},
        ]
        assert header["rallies"] == {"counted": 10, "done": 8, "in_progress": 1, "empty": 1}
        team_a = header["teams"][0]
        assert [player["name"] for player in team_a["players"]] == ["Alex One", "Avery Two"]
        team = team_a["id"]
        stats = {stat["id"]: stat for stat in body["stats"]}
        assert stats["serves"]["values"][team] == {"count": 6, "left_out": 0}
        serve_in = stats["serve_in"]["values"][team]
        assert (serve_in["count"], serve_in["of"], serve_in["estimate"], serve_in["high"]) == (
            6,
            6,
            1,
            1,
        )
        assert "estimate" not in stats["outcome_reason"]["rows"][0]["values"][team]["categories"][0]

        path = f"/api/matches/{match_id}/games"
        games = client.get(path).json()
        games[0]["rallies"][0]["status"] = RallyStatus.IN_PROGRESS
        assert client.put(path, json=games, headers={"Origin": local}).status_code == 200
        edited = client.get(endpoint).json()
        assert edited["header"]["rallies"] == {
            "counted": 10,
            "done": 7,
            "in_progress": 2,
            "empty": 1,
        }
        assert edited["stats"] == body["stats"]

        games[0]["rallies"].pop()
        assert client.put(path, json=games, headers={"Origin": local}).status_code == 200
        edited = client.get(endpoint).json()
        assert edited["stats"][0]["values"][team] == {"count": 5, "left_out": 0}

        assert client.put(path, json=[], headers={"Origin": local}).status_code == 200
        empty = client.get(endpoint).json()
        assert empty["stats"] == []
        assert empty["header"]["rallies"]["counted"] == 0
        assert client.get(f"/api/matches/{uuid4()}/report").status_code == 404

    assert main(["demo-match", "--db", str(db)]) == 0
    second_id = capsys.readouterr().out.strip()
    assert second_id != match_id
    with RallyLog.open(db) as log:
        assert len(log.list_matches()) == 2
        assert log.load_match(MatchId(UUID(second_id))).date == DEMO_DATE
        assert len(log.get_games(MatchId(UUID(second_id)))) == 3
