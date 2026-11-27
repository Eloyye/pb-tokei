"""Team and Player stats on hand-built Rallies (issue #18)."""

from __future__ import annotations

from dataclasses import replace

import pytest

from pb_tokei.demo_match import demo_games
from pb_tokei.events import (
    CourtHalf,
    ExchangeOutcome,
    OutcomeReason,
    RallyPhase,
    RallyRole,
    ShotType,
    Stat,
    StatKind,
    StatRow,
    SubjectKind,
    TeamStatus,
    compute_stats,
    wilson_interval,
)
from pb_tokei.events.stats import StatCategory
from pb_tokei.rally_log import (
    UNKNOWN,
    Challenge,
    CourtPoint,
    Error,
    ErrorKind,
    Game,
    Handedness,
    Match,
    MatchId,
    MatchRoster,
    ObservationGap,
    Parity,
    Player,
    PlayerId,
    PlayerPosition,
    Rally,
    RallyStatus,
    Ruling,
    Shot,
    ShotClass,
    TeamId,
    TournamentId,
    Zone,
    new_id,
    observed,
)

A1 = Player(PlayerId(new_id()), "Alex One", Handedness.RIGHT)
A2 = Player(PlayerId(new_id()), "Avery Two", Handedness.LEFT)
B1 = Player(PlayerId(new_id()), "Blake One", Handedness.RIGHT)
B2 = Player(PlayerId(new_id()), "Brook Two", Handedness.RIGHT)
TEAM_A, TEAM_B = TeamId(new_id()), TeamId(new_id())
ROSTER = MatchRoster(MatchId(new_id()), TEAM_A, TEAM_B, (A1, A2), (B1, B2))
TOURNAMENT = TournamentId(new_id())
ODD, EVEN = ObservationGap(Parity.ODD), ObservationGap(Parity.EVEN)
SOFT, HARD, LOB, OVERHEAD = ShotClass.SOFT, ShotClass.HARD, ShotClass.LOB, ShotClass.OVERHEAD


def court(
    a1: tuple[float, float] = (-5, -7),
    a2: tuple[float, float] = (5, -7),
    b1: tuple[float, float] = (5, 7),
    b2: tuple[float, float] = (-5, 7),
) -> dict[PlayerId, PlayerPosition]:
    return {
        player.id: PlayerPosition(observed(CourtPoint(*point)))
        for player, point in zip(ROSTER.players, (a1, a2, b1, b2), strict=True)
    }


FRONTCOURT = court()
BASELINE = court(a1=(-5, -22), a2=(5, -22), b1=(5, 22))
SPLIT = court(a1=(-5, -15))
BACK = court(a1=(-5, -16), a2=(5, -17))


def hit(
    player: Player | None,
    shot_class: ShotClass | None = SOFT,
    positions: dict[PlayerId, PlayerPosition] | None = None,
    *,
    number: int | None = None,
    landing: CourtPoint | None = None,
    error: Error | None = None,
) -> Shot:
    return Shot(
        shot_number=UNKNOWN if number is None else observed(number),
        hitter_id=UNKNOWN if player is None else observed(player.id),
        shot_class=UNKNOWN if shot_class is None else observed(shot_class),
        positions=FRONTCOURT if positions is None else positions,
        landing=UNKNOWN if landing is None else observed(landing),
        error=error,
    )


def fault(kind: ErrorKind, player: Player) -> Error:
    return Error(observed(kind), observed(player.id))


SERVE = hit(A1, HARD, BASELINE, landing=CourtPoint(5, 20))
RETURN = hit(B1, SOFT, BASELINE, landing=CourtPoint(-5, -20))
START = (SERVE, RETURN)


def rally(
    *entries: Shot | ObservationGap,
    winner: TeamId | None = None,
    challenge: Challenge | None = None,
    status: RallyStatus = RallyStatus.IN_PROGRESS,
    serving_team: TeamId | None = TEAM_A,
    server: Player | None = A1,
    returner: Player | None = B1,
) -> Rally:
    return Rally(
        number=1,
        entries=entries,
        winner_id=UNKNOWN if winner is None else observed(winner),
        serving_team_id=UNKNOWN if serving_team is None else observed(serving_team),
        server_id=UNKNOWN if server is None else observed(server.id),
        returner_id=UNKNOWN if returner is None else observed(returner.id),
        challenge=challenge,
        status=status,
    )


def match(*games: tuple[Rally, ...], roster: MatchRoster = ROSTER) -> Match:
    return Match(
        roster.match_id,
        TOURNAMENT,
        roster.team_a_id,
        roster.team_b_id,
        games=tuple(
            Game(number, tuple(replace(r, number=i) for i, r in enumerate(rallies, start=1)))
            for number, rallies in enumerate(games, start=1)
        ),
    )


def stats(*rallies: Rally) -> tuple[StatRow, ...]:
    return compute_stats(((match(rallies), ROSTER),))


def row(
    rows: tuple[StatRow, ...],
    stat: Stat,
    *,
    team: TeamId | None = TEAM_A,
    player: Player | None = None,
    kind: SubjectKind | None = None,
    category: StatCategory | None = None,
    role: RallyRole | None = None,
    end_shot_number: int | None = None,
    shot_type: ShotType | None = None,
    number: int | None = None,
    shot_group: bool = False,
    phase: RallyPhase | None = None,
) -> StatRow:
    selected = [
        r
        for r in rows
        if r.stat is stat
        and r.subject.team_id == team
        and r.subject.player_id == (None if player is None else player.id)
        and r.subject.kind is (kind or (SubjectKind.PLAYER if player else SubjectKind.TEAM))
        and r.breakdown.category == category
        and r.breakdown.rally_role is role
        and r.breakdown.end_shot_number == end_shot_number
        and r.breakdown.shot_type is shot_type
        and (
            phase is None
            or (r.breakdown.shot is not None and r.breakdown.shot.rally_phase is phase)
        )
        and (
            r.breakdown.shot is not None and r.breakdown.shot.shot_number == number
            if shot_group or number is not None
            else r.breakdown.shot is None
        )
    ]
    assert len(selected) == 1, (stat, selected)
    return selected[0]


def tally(result: StatRow) -> tuple[int, int | None, int]:
    return result.count, result.total, result.excluded


def test_wilson_interval() -> None:
    assert wilson_interval(0, 0) is None
    assert wilson_interval(1, 2) == pytest.approx((0.1208663, 0.8791337))
    assert wilson_interval(50, 100) == pytest.approx((0.4188478, 0.5811522), abs=1e-5)
    low = wilson_interval(0, 2)
    high = wilson_interval(2, 2)
    assert low is not None and high is not None
    assert low[0] == 0 and high[1] == 1
    assert low[1] == pytest.approx(1 - high[0])


def test_no_matches_returns_no_rows() -> None:
    assert compute_stats(iter(())) == ()


def test_serve_and_return_counts_and_rates_respect_challenges_gaps_and_rally_status() -> None:
    out = replace(SERVE, error=fault(ErrorKind.OUT, A1))
    overturn = Challenge(observed(A1.id), ruling=observed(Ruling.OVERTURNED))
    rows = stats(
        rally(out, status=RallyStatus.EMPTY),
        rally(out, winner=TEAM_A, challenge=overturn, status=RallyStatus.DONE),
        rally(SERVE, replace(RETURN, error=fault(ErrorKind.NET, B1))),
        rally(*START, hit(A2), winner=TEAM_A),
        rally(ODD, replace(RETURN, shot_number=observed(2)), hit(A2)),
        rally(SERVE, ODD, hit(A2, number=3)),
        rally(),
    )
    assert tally(row(rows, Stat.SERVES, player=A1)) == (5, None, 2)
    assert tally(row(rows, Stat.SERVE_IN, player=A1)) == (4, 5, 2)
    assert tally(row(rows, Stat.SERVE_IN)) == (4, 5, 2)
    assert tally(row(rows, Stat.RETURNS, team=TEAM_B, player=B1)) == (2, None, 3)
    result = row(rows, Stat.RETURN_IN, team=TEAM_B, player=B1)
    assert tally(result) == (1, 2, 3)
    assert result.interval == wilson_interval(1, 2)
    groups = [
        r.breakdown.shot
        for r in rows
        if r.stat is Stat.RETURN_IN and r.subject == result.subject and r.breakdown.shot is not None
    ]
    assert groups
    assert {(g.shot_number, g.rally_phase, g.in_opening) for g in groups} == {
        (2, RallyPhase.RETURN, True)
    }


def test_turning_an_in_call_into_an_out_call_loses_the_return() -> None:
    rows = stats(
        rally(
            *START,
            winner=TEAM_A,
            challenge=Challenge(observed(A1.id), ruling=observed(Ruling.OVERTURNED)),
        )
    )
    assert tally(row(rows, Stat.RETURN_IN, team=TEAM_B)) == (0, 1, 0)


def test_missing_error_facts_exclude_the_rate_but_keep_the_attempt() -> None:
    rows = stats(rally(replace(SERVE, error=Error()), winner=TEAM_B))
    assert tally(row(rows, Stat.SERVES, player=A1)) == (1, None, 0)
    assert tally(row(rows, Stat.SERVE_IN, player=A1)) == (0, 0, 1)
    assert row(rows, Stat.SERVE_IN, player=A1).interval is None


def test_known_team_stats_survive_an_unknown_server_or_returner() -> None:
    unseen_server = replace(SERVE, hitter_id=UNKNOWN)
    unseen_returner = replace(RETURN, hitter_id=UNKNOWN)
    rows = stats(
        rally(unseen_server, RETURN, server=None, winner=TEAM_B),
        rally(replace(unseen_server, error=Error(kind=observed(ErrorKind.NET))), server=None),
        rally(SERVE, unseen_returner, hit(A2), returner=None, winner=TEAM_A),
    )
    assert tally(row(rows, Stat.SERVES)) == (3, None, 0)
    assert tally(row(rows, Stat.SERVE_IN)) == (2, 3, 0)
    assert tally(row(rows, Stat.SERVES, kind=SubjectKind.PLAYER)) == (0, None, 2)
    assert tally(row(rows, Stat.SHOT_TYPE_ATTEMPTS, shot_type=ShotType.SERVE)) == (3, None, 0)
    assert tally(row(rows, Stat.SHOT_DISADVANTAGE, shot_type=ShotType.SERVE)) == (1, 2, 1)
    assert tally(
        row(
            rows, Stat.OUTCOME_REASON, shot_type=ShotType.SERVE, category=OutcomeReason.REPLY_WINNER
        )
    ) == (1, None, 0)
    assert tally(row(rows, Stat.RETURN_IN, team=TEAM_B)) == (2, 2, 0)
    assert tally(row(rows, Stat.RETURNS, team=TEAM_B, kind=SubjectKind.PLAYER)) == (0, None, 1)
    assert tally(
        row(
            rows, Stat.RETURNER_ZONE, team=TEAM_B, kind=SubjectKind.PLAYER, category=Zone.FRONTCOURT
        )
    ) == (0, 0, 1)


def test_serving_team_falls_back_to_the_server_or_returner() -> None:
    rows = stats(
        rally(*START, hit(A2), serving_team=None, server=None, returner=None, winner=TEAM_A),
        rally(ODD, hit(A2, number=3), serving_team=None, server=None, winner=TEAM_A),
    )
    assert tally(row(rows, Stat.OPENING_END, role=RallyRole.SERVING)) == (2, 2, 0)
    assert tally(row(rows, Stat.OPENING_END, team=TEAM_B, role=RallyRole.RECEIVING)) == (2, 2, 0)
    assert tally(row(rows, Stat.SERVES)) == (1, None, 1)


def test_rally_with_unknown_roles_reports_unattributed_opportunities() -> None:
    rows = stats(rally(serving_team=None, server=None, returner=None))
    assert tally(row(rows, Stat.SERVES, team=None)) == (0, None, 1)
    assert tally(row(rows, Stat.RETURNS, team=None)) == (0, None, 1)
    assert tally(row(rows, Stat.OPENING_END)) == (0, 0, 1)
    assert tally(
        row(rows, Stat.RETURNER_ZONE, team=None, kind=SubjectKind.PLAYER, category=Zone.BACKCOURT)
    ) == (0, 0, 2)


def test_shot_types_tally_attempts_outcomes_and_reasons_separately() -> None:
    rows = stats(
        rally(*START, hit(A2, HARD, BACK), winner=TEAM_A),
        rally(*START, hit(A2, HARD, BACK, error=fault(ErrorKind.NET, A2))),
        rally(*START, hit(A2, HARD, BACK), ODD),
        rally(*START, ODD, hit(B2, number=4), hit(A2, None), winner=TEAM_A),
    )
    for player in (None, A2):
        assert tally(
            row(rows, Stat.SHOT_TYPE_ATTEMPTS, shot_type=ShotType.DRIVE, player=player)
        ) == (
            3,
            None,
            0,
        )
        for stat in (Stat.SHOT_ADVANTAGE, Stat.SHOT_DISADVANTAGE):
            assert tally(row(rows, stat, shot_type=ShotType.DRIVE, player=player)) == (1, 2, 1)
    for reason in (OutcomeReason.WINNER, OutcomeReason.ERROR):
        result = row(rows, Stat.OUTCOME_REASON, shot_type=ShotType.DRIVE, category=reason, number=3)
        assert tally(result) == (1, None, 0)
        assert result.interval is None
    assert tally(row(rows, Stat.OUTCOME_REASON, shot_type=ShotType.DRIVE)) == (0, None, 1)
    assert tally(row(rows, Stat.SHOT_TYPE_ATTEMPTS, player=A2)) == (0, None, 1)


def test_arrival_uses_same_shot_four_cohort_from_both_teams_sides() -> None:
    rows = stats(
        rally(*START, hit(A2, positions=BACK), winner=TEAM_B),
        rally(*START, hit(A2, positions=BACK), hit(B1, positions=SPLIT), hit(A1), winner=TEAM_B),
        rally(*START, hit(A2, positions=BACK), hit(B1, positions=SPLIT), winner=TEAM_B),
        rally(
            *START,
            hit(A2, positions=BACK),
            hit(B1, positions=SPLIT),
            hit(A1, positions=BACK),
            winner=TEAM_A,
        ),
        rally(*START, hit(A2, positions=BACK), hit(B1, positions=SPLIT)),
        rally(*START, hit(A2, positions={}), hit(B1, positions=BACK), winner=TEAM_B),
        rally(*START, ODD, hit(B1, number=4), winner=TEAM_B),
        rally(*START, ODD, winner=TEAM_B),
    )
    assert tally(row(rows, Stat.ARRIVAL_RATE)) == (2, 5, 2)
    assert tally(row(rows, Stat.LOST_BEFORE_ARRIVAL)) == (1, 4, 3)
    assert tally(row(rows, Stat.WON_BEFORE_ARRIVAL, team=TEAM_B)) == (1, 4, 3)
    assert tally(row(rows, Stat.LOST_WHEN_NEVER_ARRIVED)) == (1, 2, 3)
    assert not any(r.stat is Stat.ARRIVAL_RATE and r.breakdown.shot is not None for r in rows)


def test_dink_errors_and_popups_use_the_same_incoming_soft_cohort() -> None:
    rows = stats(
        *(
            rally(*START, hit(A2, error=fault(kind, A2)))
            for kind in (
                ErrorKind.NET,
                ErrorKind.OUT,
                ErrorKind.DOUBLE_HIT,
                ErrorKind.KITCHEN_FAULT,
            )
        ),
        rally(*START, hit(A2), winner=TEAM_A),
        rally(
            SERVE,
            replace(RETURN, shot_class=observed(HARD)),
            hit(A2, error=fault(ErrorKind.OUT, A2)),
        ),
        rally(SERVE, replace(RETURN, shot_class=UNKNOWN), hit(A2), winner=TEAM_A),
        rally(*START, hit(A2), hit(B1, OVERHEAD), winner=TEAM_B),
        rally(*START, hit(A2), ODD),
    )
    assert tally(row(rows, Stat.DINK_ERRORS, player=A2)) == (3, 6, 2)
    assert tally(row(rows, Stat.DINK_POPUPS, player=A2)) == (1, 6, 2)
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, player=A2)) == (1, 1, 0)
    assert row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, player=A2).interval is None


def test_popup_credit_goes_to_the_dinker_and_the_player_who_puts_it_away() -> None:
    rows = stats(
        rally(*START, hit(A2), hit(B1), hit(A1, OVERHEAD), winner=TEAM_A),
        rally(*START, hit(A2), hit(B1), hit(A1, OVERHEAD, error=fault(ErrorKind.NET, A1))),
        rally(*START, hit(A2), hit(B1), ODD, hit(A1, OVERHEAD, number=7), winner=TEAM_A),
    )
    assert tally(row(rows, Stat.DINK_ANSWERED_WITH_POPUP, player=A2)) == (2, 2, 1)
    assert tally(row(rows, Stat.DINK_POPUPS, team=TEAM_B, player=B1)) == (2, 2, 1)
    assert tally(row(rows, Stat.POPUP_PUT_AWAY, player=A1)) == (1, 2, 1)
    assert tally(row(rows, Stat.POPUP_PUT_AWAY)) == (1, 2, 1)


def test_speedup_exchanges_are_mirrored_for_the_target_and_exclude_unknown_results() -> None:
    drop = hit(A1, positions=BACK)
    speedup = hit(B1, HARD)
    rows = stats(
        rally(*START, drop, speedup, hit(A2, HARD, error=fault(ErrorKind.NET, A2))),
        rally(*START, drop, speedup, hit(A2, HARD), winner=TEAM_A),
        rally(*START, drop, speedup, hit(A2), hit(B2), winner=TEAM_B),
        rally(*START, drop, speedup, hit(A2, HARD), ODD),
        rally(*START, drop, replace(speedup, error=fault(ErrorKind.NET, B1))),
    )
    for outcome in ExchangeOutcome:
        initiated = row(
            rows,
            Stat.SPEEDUP_INITIATED,
            team=TEAM_B,
            player=B1,
            category=outcome,
            number=4,
        )
        assert tally(initiated) == (2 if outcome is ExchangeOutcome.LOST else 1, 4, 1)
        assert initiated.breakdown.shot is not None
        assert initiated.breakdown.shot.rally_phase is RallyPhase.FRONTCOURT_BATTLE
        assert initiated.breakdown.shot.court_half is CourtHalf.LEFT
        received = row(rows, Stat.SPEEDUP_RECEIVED, player=A2, category=outcome)
        assert tally(received) == (1, 3, 1)
        success = row(rows, Stat.SPEEDUP_SUCCESS, team=TEAM_B, player=B1, category=outcome)
        assert tally(success) == tally(initiated)


def test_speedup_team_record_survives_an_unknown_hitter() -> None:
    speedup = replace(hit(None, HARD), contact_zone=observed(Zone.FRONTCOURT))
    rows = stats(rally(*START, hit(A1, positions=BACK), speedup, hit(A2, HARD), winner=TEAM_A))
    assert tally(row(rows, Stat.SPEEDUP_INITIATED, team=TEAM_B, category=ExchangeOutcome.LOST)) == (
        1,
        1,
        0,
    )
    assert tally(
        row(
            rows,
            Stat.SPEEDUP_INITIATED,
            team=TEAM_B,
            kind=SubjectKind.PLAYER,
            category=ExchangeOutcome.LOST,
        )
    ) == (0, 0, 1)
    assert tally(row(rows, Stat.SPEEDUP_RECEIVED, player=A2, category=ExchangeOutcome.WON)) == (
        1,
        1,
        0,
    )


def test_initiative_only_credits_dinks_that_do_the_work() -> None:
    rows = stats(
        rally(*START, hit(A2), winner=TEAM_A),
        rally(*START, hit(A1), hit(B1, error=fault(ErrorKind.NET, B1))),
        rally(*START, hit(A1), hit(B1), hit(A2, OVERHEAD), winner=TEAM_A),
        rally(*START, hit(A1), hit(B1, HARD, error=fault(ErrorKind.NET, B1))),
        rally(*START, hit(A1), hit(B1, HARD), hit(A2, HARD), winner=TEAM_A),
        rally(*START, hit(A1), ODD),
        rally(
            *START,
            hit(A2),
            hit(B1),
            hit(A1, HARD, court(a1=(-5, -10)), error=fault(ErrorKind.NET, A1)),
        ),
        rally(*START, hit(A2, positions=BACK), hit(B1), hit(A1, HARD), winner=TEAM_A),
    )
    assert tally(row(rows, Stat.INITIATIVE_SHARE, player=A1)) == (3, 4, 1)
    assert tally(row(rows, Stat.INITIATIVE_SHARE, player=A2)) == (1, 4, 1)
    assert tally(row(rows, Stat.SUCCESSFUL_INITIATIVE_SHARE, player=A1)) == (3, 4, 1)
    assert not any(
        r.stat in (Stat.INITIATIVE_SHARE, Stat.SUCCESSFUL_INITIATIVE_SHARE)
        and r.breakdown.shot is not None
        and r.breakdown.shot.shot_type is ShotType.DRIVE
        for r in rows
    )


def test_hit_and_targeted_shares_and_crossover_use_each_players_court_half() -> None:
    rows = stats(
        rally(
            *START,
            hit(A2, positions=court(a2=(-1, -7))),
            hit(B2),
            hit(A1, HARD, error=fault(ErrorKind.BODY_HIT, B1)),
        )
    )
    assert tally(row(rows, Stat.HIT_SHARE, player=A1)) == (1, 2, 0)
    assert tally(row(rows, Stat.HIT_SHARE, player=A2)) == (1, 2, 0)
    assert tally(row(rows, Stat.HIT_SHARE, team=TEAM_B, player=B1)) == (0, 1, 0)
    assert tally(row(rows, Stat.TARGETED_SHARE, player=A2)) == (1, 2, 0)
    assert tally(row(rows, Stat.TARGETED_SHARE, team=TEAM_B, player=B1)) == (1, 2, 0)
    crossover = row(rows, Stat.CROSSOVER, player=A2, number=3)
    assert tally(crossover) == (1, 1, 0)
    assert crossover.breakdown.shot is not None
    assert crossover.breakdown.shot.court_half is CourtHalf.RIGHT
    assert tally(row(rows, Stat.CROSSOVER, player=A1)) == (0, 1, 0)
    for player, side in ((B1, CourtHalf.LEFT), (B2, CourtHalf.RIGHT)):
        split = row(rows, Stat.HIT_SHARE, team=TEAM_B, player=player, number=4)
        assert split.breakdown.shot is not None
        assert split.breakdown.shot.court_half is side
    assert not any(
        r.subject.kind is SubjectKind.TEAM
        for r in rows
        if r.stat in (Stat.HIT_SHARE, Stat.TARGETED_SHARE, Stat.CROSSOVER)
    )


def test_targeted_share_excludes_missing_targets_and_ignores_targetless_errors() -> None:
    rows = stats(
        rally(*START, hit(A2, HARD, error=fault(ErrorKind.OUT, A2))),
        rally(*START, hit(A2, HARD), winner=TEAM_A),  # no landing from which to derive a Target
        rally(*START, hit(A2, HARD), ODD),  # the would-be Target was missed
    )
    assert tally(row(rows, Stat.TARGETED_SHARE, team=TEAM_B, player=B1)) == (0, 0, 2)
    assert tally(row(rows, Stat.TARGETED_SHARE, player=A2)) == (3, 3, 0)


def test_missing_positions_and_gaps_preserve_unknown_shot_groups() -> None:
    no_partner = {pid: pos for pid, pos in BASELINE.items() if pid != A2.id}
    rows = stats(
        rally(SERVE, replace(RETURN, positions=no_partner), hit(A2, positions=BACK), winner=TEAM_A),
        rally(*START, EVEN, hit(A2, HARD, positions=BACK), winner=TEAM_A),
    )
    assert tally(row(rows, Stat.CROSSOVER, player=A2)) == (0, 0, 2)
    known_number = row(rows, Stat.CROSSOVER, player=A2, number=3)
    unknown_number = row(rows, Stat.CROSSOVER, player=A2, shot_group=True)
    assert known_number.breakdown.shot is not None
    assert known_number.breakdown.shot.court_half is None
    assert unknown_number.breakdown.shot is not None
    assert unknown_number.breakdown.shot.rally_phase is None
    assert unknown_number.breakdown.shot.in_opening is None
    hit_share = row(rows, Stat.HIT_SHARE, player=A2, shot_group=True)
    assert tally(hit_share) == (1, 1, 0)


def test_opening_ending_stats_are_by_rally_role_and_use_gap_bounds() -> None:
    receiving = replace(
        rally(hit(B1, HARD), winner=TEAM_A),
        serving_team_id=observed(TEAM_B),
        server_id=observed(B1.id),
        returner_id=observed(A1.id),
    )
    four = (*START, hit(A2), hit(B1))
    rows = stats(
        rally(*START, hit(A2), winner=TEAM_A),
        rally(*four, winner=TEAM_B),
        rally(*four),
        rally(*four, ODD, winner=TEAM_B),
        rally(*four, EVEN, winner=TEAM_B),
        rally(*four, hit(A1), hit(B2), winner=TEAM_B),
        receiving,
    )
    role = RallyRole.SERVING
    assert tally(row(rows, Stat.OPENING_END, role=role)) == (3, 5, 1)
    assert tally(row(rows, Stat.OPENING_WIN, role=role)) == (1, 2, 2)
    assert tally(row(rows, Stat.OPENING_END_SHOT, role=role, end_shot_number=4)) == (2, None, 0)
    assert tally(row(rows, Stat.OPENING_WIN, role=RallyRole.RECEIVING)) == (1, 1, 0)


def test_opening_positions_track_shots_three_and_five_individually() -> None:
    rows = stats(
        rally(*START, hit(A2, positions=SPLIT), hit(B1), hit(A1, positions=court(b1=(5, 19)))),
        rally(*START, ODD, hit(B1, number=4), hit(A1, positions={})),
    )
    assert tally(
        row(
            rows,
            Stat.RETURNER_ZONE,
            player=B1,
            team=TEAM_B,
            category=Zone.FRONTCOURT,
            number=3,
            phase=RallyPhase.TRANSITION,
        )
    ) == (1, 1, 0)
    missing = [
        r
        for r in rows
        if r.stat is Stat.RETURNER_ZONE
        and r.breakdown.category is Zone.FRONTCOURT
        and r.breakdown.shot is not None
        and r.breakdown.shot.shot_number == 3
        and r.breakdown.shot.rally_phase is None
    ]
    assert len(missing) == 1
    assert tally(missing[0]) == (0, 0, 1)
    assert tally(
        row(
            rows,
            Stat.SERVING_TEAM_STATUS,
            category=TeamStatus.SPLIT,
            number=3,
            phase=RallyPhase.TRANSITION,
        )
    ) == (1, 1, 0)
    assert tally(
        row(
            rows,
            Stat.RETURNER_ZONE,
            player=B1,
            team=TEAM_B,
            category=Zone.BACKCOURT,
            number=5,
            phase=RallyPhase.SCRAMBLE,
        )
    ) == (1, 1, 0)
    assert tally(
        row(
            rows,
            Stat.SERVING_TEAM_STATUS,
            category=TeamStatus.ESTABLISHED,
            number=5,
            phase=RallyPhase.SCRAMBLE,
        )
    ) == (1, 1, 0)


def test_body_hits_and_challenge_success_use_the_final_call_and_correct_subject() -> None:
    body = hit(A2, HARD, error=fault(ErrorKind.BODY_HIT, B2))
    rows = stats(
        rally(*START, body),
        rally(*START, replace(body, hitter_id=UNKNOWN)),
        rally(
            *START,
            body,
            winner=TEAM_B,
            challenge=Challenge(observed(B2.id), ruling=observed(Ruling.OVERTURNED)),
        ),
        rally(
            *START, hit(A2), challenge=Challenge(observed(B2.id), ruling=observed(Ruling.UPHELD))
        ),
        rally(*START, hit(A2), challenge=Challenge(observed(B2.id))),
        rally(*START, hit(A2), challenge=Challenge(ruling=observed(Ruling.UPHELD))),
    )
    assert tally(row(rows, Stat.BODY_HIT_WINNERS, player=A2)) == (1, None, 0)
    assert tally(row(rows, Stat.BODY_HIT_WINNERS)) == (2, None, 0)
    assert tally(row(rows, Stat.BODY_HIT_WINNERS, kind=SubjectKind.PLAYER)) == (0, None, 1)
    assert tally(row(rows, Stat.BODY_HIT_RECEIVED, team=TEAM_B, player=B2)) == (2, None, 0)
    assert tally(row(rows, Stat.CHALLENGE_SUCCESS, team=TEAM_B)) == (1, 2, 1)
    assert tally(row(rows, Stat.CHALLENGE_SUCCESS, team=TEAM_B, player=B2)) == (1, 2, 1)
    assert tally(row(rows, Stat.CHALLENGE_SUCCESS, team=None, kind=SubjectKind.PLAYER)) == (0, 0, 1)


def test_unknown_hitter_is_reported_without_attributing_a_shot_to_either_partner() -> None:
    rows = stats(rally(*START, hit(None, HARD, positions=BACK), winner=TEAM_A))
    assert tally(row(rows, Stat.SHOT_TYPE_ATTEMPTS, kind=SubjectKind.PLAYER)) == (0, None, 1)
    assert tally(row(rows, Stat.HIT_SHARE, player=A1)) == (0, 0, 1)
    assert tally(row(rows, Stat.HIT_SHARE, player=A2)) == (0, 0, 1)


def test_kitchen_fault_defaults_to_hitter_when_error_player_is_unknown() -> None:
    kitchen_fault = Error(kind=observed(ErrorKind.KITCHEN_FAULT))
    rows = stats(
        rally(*START, hit(A2, error=kitchen_fault)),
        rally(*START, hit(None, error=kitchen_fault)),
        rally(*START, hit(A1, error=fault(ErrorKind.KITCHEN_FAULT, A2))),
    )
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, player=A2)) == (2, 1, 0)
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, player=A1)) == (0, 1, 0)
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH)) == (3, 1, 0)
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, kind=SubjectKind.PLAYER)) == (0, None, 1)


def test_aggregation_pools_matching_teams_and_keeps_a_players_partners_distinct() -> None:
    repeat = replace(ROSTER, match_id=MatchId(new_id()))
    new_partner = Player(PlayerId(new_id()), "Casey Three", Handedness.RIGHT)
    other = replace(
        repeat,
        match_id=MatchId(new_id()),
        team_a_id=TeamId(new_id()),
        team_a_players=(A1, new_partner),
    )
    a1_fault = rally(hit(A1, positions={}, error=fault(ErrorKind.KITCHEN_FAULT, A1)))
    a2_fault = rally(*START, hit(A2, error=fault(ErrorKind.KITCHEN_FAULT, A2)))
    paired_fault = replace(a1_fault, serving_team_id=observed(other.team_a_id))
    rows = compute_stats(
        (m, roster)
        for m, roster in (
            (match((a1_fault,), (a1_fault, a2_fault)), ROSTER),
            (match(roster=repeat), repeat),
            (match((paired_fault,), roster=other), other),
        )
    )
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, player=A1)) == (2, 2, 0)
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, player=A2)) == (1, 2, 0)
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH)) == (3, 2, 0)
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, team=other.team_a_id, player=A1)) == (
        1,
        1,
        0,
    )
    assert tally(row(rows, Stat.KITCHEN_FAULTS_PER_MATCH, team=TEAM_B)) == (0, 3, 0)


def test_full_match_computes_every_stat_and_shot_type() -> None:
    fixture = replace(match(), games=demo_games(ROSTER))
    rows = compute_stats(((fixture, ROSTER),))
    assert {r.stat for r in rows} == set(Stat)
    assert {
        r.breakdown.shot_type for r in rows if r.stat is Stat.SHOT_TYPE_ATTEMPTS and r.count
    } == set(ShotType)
    assert len({(r.stat, r.subject, r.breakdown) for r in rows}) == len(rows)
    assert tally(row(rows, Stat.SERVE_IN, player=A1)) == (6, 6, 0)
    assert tally(row(rows, Stat.ARRIVAL_RATE)) == (3, 4, 0)
    assert tally(row(rows, Stat.SHOT_TYPE_ATTEMPTS, shot_type=ShotType.DRIVE, number=3)) == (
        1,
        None,
        0,
    )
    assert tally(row(rows, Stat.BODY_HIT_RECEIVED, team=TEAM_B, player=B2)) == (1, None, 0)

    plain_counts = {
        Stat.SERVES,
        Stat.RETURNS,
        Stat.SHOT_TYPE_ATTEMPTS,
        Stat.OUTCOME_REASON,
        Stat.OPENING_END_SHOT,
        Stat.BODY_HIT_WINNERS,
        Stat.BODY_HIT_RECEIVED,
    }
    for result in rows:
        if result.stat in plain_counts:
            assert result.stat.kind is StatKind.COUNT
            assert result.total is None and result.interval is None
        elif result.stat is Stat.KITCHEN_FAULTS_PER_MATCH:
            assert result.stat.kind is StatKind.PER_MATCH
            assert result.total == 1 and result.interval is None
        else:
            assert result.stat.kind is StatKind.RATE
            assert result.total is not None
            assert (result.interval is not None) == (result.total > 0)
