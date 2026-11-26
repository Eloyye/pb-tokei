"""Derived facts on small hand-built Rallies (issue #16)."""

from __future__ import annotations

import pytest

from pb_tokei.events import (
    ArrivalStatus,
    DerivedRally,
    DerivedShot,
    ExchangeOutcome,
    RallyPhase,
    ShotType,
    TeamArrival,
    TeamStatus,
    derive_game,
    derive_match,
    derive_rally,
    resolve_attack_exchange,
)
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
    inferred,
    new_id,
    observed,
)

A1 = Player(PlayerId(new_id()), "Alex One", Handedness.RIGHT)
A2 = Player(PlayerId(new_id()), "Avery Two", Handedness.LEFT)
B1 = Player(PlayerId(new_id()), "Blake One", Handedness.RIGHT)
B2 = Player(PlayerId(new_id()), "Brook Two", Handedness.RIGHT)
TEAM_A = TeamId(new_id())  # plays at the near end (y < 0)
TEAM_B = TeamId(new_id())
ROSTER = MatchRoster(MatchId(new_id()), TEAM_A, TEAM_B, (A1, A2), (B1, B2))

SOFT, HARD, LOB, OVERHEAD = ShotClass.SOFT, ShotClass.HARD, ShotClass.LOB, ShotClass.OVERHEAD
FRONT, MID, BACK = Zone.FRONTCOURT, Zone.MIDCOURT, Zone.BACKCOURT
ODD, EVEN = ObservationGap(Parity.ODD), ObservationGap(Parity.EVEN)


def court(
    a1: float | None = None,
    a2: float | None = None,
    b1: float | None = None,
    b2: float | None = None,
) -> dict[PlayerId, PlayerPosition]:
    """Players at these distances from the net (Team A at the near end); None leaves one out."""
    positions = {}
    for player, depth, sign in ((A1, a1, -1), (A2, a2, -1), (B1, b1, 1), (B2, b2, 1)):
        if depth is not None:
            positions[player.id] = PlayerPosition(observed(CourtPoint(0.0, sign * depth)))
    return positions


ALL_FRONT = court(5, 5, 5, 5)
ALL_BACK = court(20, 20, 20, 20)


def hit(
    hitter: Player | None,
    shot_class: ShotClass | None = None,
    zone: Zone | None = None,
    *,
    number: int | None = None,
    positions: dict[PlayerId, PlayerPosition] | None = None,
    landing: CourtPoint | None = None,
    error: Error | None = None,
) -> Shot:
    return Shot(
        shot_number=UNKNOWN if number is None else observed(number),
        hitter_id=UNKNOWN if hitter is None else observed(hitter.id),
        contact_zone=UNKNOWN if zone is None else observed(zone),
        shot_class=UNKNOWN if shot_class is None else inferred(shot_class),
        landing=UNKNOWN if landing is None else observed(landing),
        error=error,
        positions={} if positions is None else positions,
    )


def dink(hitter: Player, *, error: Error | None = None) -> Shot:
    """A Soft Shot from the Frontcourt with everyone at the net (a Dink or a Block)."""
    return hit(hitter, SOFT, FRONT, positions=ALL_FRONT, error=error)


def bang(hitter: Player, *, error: Error | None = None) -> Shot:
    """A Hard Shot from the Frontcourt with everyone at the net (a Speedup or a Counter)."""
    return hit(hitter, HARD, FRONT, positions=ALL_FRONT, error=error)


def error(kind: ErrorKind | None, player: Player | None) -> Error:
    return Error(
        kind=UNKNOWN if kind is None else observed(kind),
        player_id=UNKNOWN if player is None else observed(player.id),
    )


OVERTURNED = Challenge(challenger_id=observed(A1.id), ruling=observed(Ruling.OVERTURNED))
UPHELD = Challenge(challenger_id=observed(A1.id), ruling=observed(Ruling.UPHELD))


def rally(
    *entries: Shot | ObservationGap,
    winner: TeamId | None = None,
    challenge: Challenge | None = None,
) -> Rally:
    return Rally(
        number=1,
        entries=entries,
        winner_id=UNKNOWN if winner is None else observed(winner),
        challenge=challenge,
    )


def derive(
    *entries: Shot | ObservationGap,
    winner: TeamId | None = None,
    challenge: Challenge | None = None,
) -> DerivedRally:
    return derive_rally(rally(*entries, winner=winner, challenge=challenge), ROSTER)


def serve_return() -> tuple[Shot, Shot]:
    """A Hard Serve by A1 and a Hard Return by B1, both from the Backcourt."""
    return hit(A1, HARD, BACK), hit(B1, HARD, BACK)


def last(derived: DerivedRally) -> DerivedShot:
    return derived.shots[-1]


# --- Shot Number --------------------------------------------------------------------------


def test_shot_numbers_count_from_the_serve() -> None:
    derived = derive(hit(A1), hit(B1), hit(A2))
    assert [s.shot_number for s in derived.shots] == [1, 2, 3]
    assert [s.min_shot_number for s in derived.shots] == [1, 2, 3]
    assert [(s.entry_index, s.shot_index) for s in derived.shots] == [(0, 0), (1, 1), (2, 2)]


def test_an_observation_gap_leaves_the_shot_number_unknown_but_bounds_it() -> None:
    odd = derive(hit(A1), hit(B1), hit(A2), ODD, hit(B2), hit(A1))
    assert [s.shot_number for s in odd.shots] == [1, 2, 3, None, None]
    assert [s.min_shot_number for s in odd.shots] == [1, 2, 3, 5, 6]

    even = derive(hit(A1), hit(B1), hit(A2), EVEN, hit(B2))
    assert last(even).shot_number is None
    assert last(even).min_shot_number == 6


def test_a_recorded_shot_number_resyncs_counting_after_a_gap() -> None:
    derived = derive(hit(A1), ODD, hit(A2, number=7), hit(B1))
    assert [s.shot_number for s in derived.shots] == [1, 7, 8]
    assert [s.min_shot_number for s in derived.shots] == [1, 7, 8]


def test_a_leading_odd_gap_makes_the_first_seen_shot_at_least_shot_two() -> None:
    derived = derive(ODD, hit(B1), hit(A1))
    assert [s.shot_number for s in derived.shots] == [None, None]
    assert [s.min_shot_number for s in derived.shots] == [2, 3]


# --- Opening ------------------------------------------------------------------------------


def test_opening_is_shots_one_to_five() -> None:
    derived = derive(*(hit(p) for p in (A1, B1, A2, B2, A1, B1)))
    assert [s.in_opening for s in derived.shots] == [True] * 5 + [False]


def test_opening_after_a_gap_is_false_once_the_shot_must_be_past_five() -> None:
    assert last(derive(hit(A1), hit(B1), hit(A2), EVEN, hit(B2))).in_opening is False


def test_opening_after_a_gap_is_unknown_while_the_shot_could_still_be_in_it() -> None:
    assert last(derive(hit(A1), ODD, hit(A2))).in_opening is None
    assert last(derive(hit(A1), hit(B1), hit(A2), ODD, hit(B2))).in_opening is None


# --- Contact Zone -------------------------------------------------------------------------


def test_contact_zone_prefers_the_recorded_zone() -> None:
    shot = hit(A1, zone=BACK, positions=court(a1=5))
    assert last(derive(shot)).contact_zone is BACK


def test_contact_zone_falls_back_to_the_hitters_position() -> None:
    assert last(derive(hit(A1, positions=court(a1=12)))).contact_zone is MID
    assert last(derive(hit(B1, positions=court(b1=9.0)))).contact_zone is FRONT


def test_contact_zone_is_unknown_without_a_zone_or_the_hitters_position() -> None:
    assert last(derive(hit(None, positions=court(5, 5, 5, 5)))).contact_zone is None
    assert last(derive(hit(A1, positions=court(a2=5)))).contact_zone is None


# --- Attack -------------------------------------------------------------------------------


def test_serve_and_return_are_never_attacks() -> None:
    derived = derive(hit(A1, OVERHEAD), hit(B1, HARD))
    assert [s.is_attack for s in derived.shots] == [False, False]


@pytest.mark.parametrize(
    ("shot_class", "expected"),
    [(SOFT, False), (LOB, False), (HARD, True), (OVERHEAD, True), (None, None)],
)
def test_attack_follows_shot_class(shot_class: ShotClass | None, expected: bool | None) -> None:
    assert last(derive(*serve_return(), hit(A2, shot_class))).is_attack is expected


def test_attack_after_a_leading_odd_gap_is_unknown_since_the_shot_might_be_the_return() -> None:
    assert last(derive(ODD, hit(B1, HARD))).is_attack is None
    assert last(derive(ODD, hit(B1, SOFT))).is_attack is False
    assert last(derive(EVEN, hit(A1, HARD))).is_attack is True


# --- Shot Type ----------------------------------------------------------------------------


def _fourth_shot_type(
    shot_class: ShotClass, zone: Zone | None, incoming_attack: bool
) -> ShotType | None:
    """Shot Type of a Shot answering a third Shot that was (or was not) an Attack."""
    third = hit(A2, HARD, MID) if incoming_attack else hit(A2, SOFT, MID)
    derived = derive(*serve_return(), third, hit(B2, shot_class, zone, positions=ALL_FRONT))
    assert last(derived).incoming_is_attack is incoming_attack
    return last(derived).shot_type


@pytest.mark.parametrize(
    ("shot_class", "zone", "incoming_attack", "expected"),
    [
        (SOFT, FRONT, False, ShotType.DINK),
        (SOFT, FRONT, True, ShotType.BLOCK),
        (SOFT, MID, False, ShotType.DROP),
        (SOFT, BACK, False, ShotType.DROP),
        (SOFT, MID, True, ShotType.RESET),
        (SOFT, BACK, True, ShotType.RESET),
        (HARD, FRONT, False, ShotType.SPEEDUP),
        (HARD, FRONT, True, ShotType.COUNTER),
        (HARD, MID, False, ShotType.DRIVE),
        (HARD, BACK, True, ShotType.DRIVE),
        (OVERHEAD, FRONT, False, ShotType.OVERHEAD),
        (OVERHEAD, None, True, ShotType.OVERHEAD),
        (LOB, None, False, ShotType.OFFENSIVE_LOB),
    ],
)
def test_shot_type_table(
    shot_class: ShotClass, zone: Zone | None, incoming_attack: bool, expected: ShotType
) -> None:
    assert _fourth_shot_type(shot_class, zone, incoming_attack) is expected


def test_serve_and_return_shot_types_are_fixed_by_shot_number() -> None:
    derived = derive(hit(A1, SOFT, FRONT), hit(B1, LOB, BACK))
    assert [s.shot_type for s in derived.shots] == [ShotType.SERVE, ShotType.RETURN]


def test_a_soft_third_shot_off_a_hard_return_is_a_drop_not_a_reset() -> None:
    third = last(derive(*serve_return(), hit(A2, SOFT, BACK)))
    assert third.incoming_is_attack is False
    assert third.shot_type is ShotType.DROP


def test_lobs_are_offensive_or_defensive_by_the_hitters_team_status() -> None:
    offensive = derive(*serve_return(), hit(A2, LOB, positions=court(5, 5, 20, 20)))
    defensive = derive(*serve_return(), hit(A2, LOB, positions=court(5, 15, 5, 5)))
    unknown = derive(*serve_return(), hit(A2, LOB, positions=court(5, None, 5, 5)))
    no_hitter = derive(*serve_return(), hit(None, LOB, positions=ALL_FRONT))
    assert last(offensive).shot_type is ShotType.OFFENSIVE_LOB
    assert last(defensive).shot_type is ShotType.DEFENSIVE_LOB
    assert last(unknown).shot_type is None
    assert last(no_hitter).shot_type is None


def test_shot_type_uses_the_contact_zone_fallback() -> None:
    shot = hit(B2, SOFT, positions=court(5, 5, 5, 14))
    assert last(derive(*serve_return(), hit(A2, SOFT, MID), shot)).shot_type is ShotType.DROP


def test_after_a_gap_shot_types_that_ignore_the_incoming_shot_are_still_known() -> None:
    lead = (*serve_return(), hit(A2, SOFT, MID), ODD)
    assert last(derive(*lead, hit(A1, HARD, MID))).shot_type is ShotType.DRIVE
    assert last(derive(*lead, hit(A1, OVERHEAD))).shot_type is ShotType.OVERHEAD
    lob = hit(A1, LOB, positions=ALL_FRONT)
    assert last(derive(*lead, lob)).shot_type is ShotType.OFFENSIVE_LOB


def test_after_a_gap_shot_types_that_need_the_incoming_shot_are_unknown() -> None:
    lead = (*serve_return(), hit(A2, SOFT, MID), ODD)
    assert last(derive(*lead, hit(A1, SOFT, FRONT))).incoming_is_attack is None
    assert last(derive(*lead, hit(A1, SOFT, FRONT))).shot_type is None
    assert last(derive(*lead, hit(A1, SOFT, MID))).shot_type is None
    assert last(derive(*lead, hit(A1, HARD, FRONT))).shot_type is None


def test_shot_type_is_unknown_after_a_leading_odd_gap_or_with_missing_facts() -> None:
    assert last(derive(ODD, hit(B1, HARD, BACK))).shot_type is None
    assert last(derive(*serve_return(), hit(A2, None, FRONT))).shot_type is None
    assert last(derive(*serve_return(), hit(A2, SOFT))).shot_type is None
    assert last(derive(*serve_return(), hit(A2, HARD))).shot_type is None


def test_an_unknown_incoming_attack_leaves_soft_and_frontcourt_hard_shots_unknown() -> None:
    lead = (*serve_return(), hit(A2, None, MID))
    assert last(derive(*lead, hit(B2, SOFT, FRONT))).incoming_is_attack is None
    assert last(derive(*lead, hit(B2, SOFT, FRONT))).shot_type is None
    assert last(derive(*lead, hit(B2, HARD, FRONT))).shot_type is None
    assert last(derive(*lead, hit(B2, HARD, BACK))).shot_type is ShotType.DRIVE


# --- Team Status and the 12 ft hysteresis -------------------------------------------------


def statuses(derived: DerivedRally, team: TeamId) -> list[TeamStatus | None]:
    return [s.team_status[team] for s in derived.shots]


def established(derived: DerivedRally, team: TeamId) -> list[bool | None]:
    return [s.team_established[team] for s in derived.shots]


def test_team_status_boundaries_are_inclusive() -> None:
    derived = derive(
        hit(A1, positions=court(9.0, 9.0, 9.0, 9.01)),
        hit(B1, positions=court(12.0, 12.0, 10, 10)),
        hit(A2, positions=court(12.01, 5, 9.0, 9.0)),
    )
    assert statuses(derived, TEAM_A) == [
        TeamStatus.ESTABLISHED,
        TeamStatus.ESTABLISHED,  # kept: both still within 12 ft
        TeamStatus.SPLIT,  # lost: one Player deeper than 12 ft
    ]
    assert statuses(derived, TEAM_B) == [
        TeamStatus.SPLIT,
        TeamStatus.BACK,
        TeamStatus.ESTABLISHED,
    ]


def test_team_status_is_worked_out_on_the_serve_and_return_too() -> None:
    derived = derive(hit(A1, positions=court(5, 5, 20, 8)), hit(B1, positions=court(5, 5, 20, 5)))
    assert statuses(derived, TEAM_A) == [TeamStatus.ESTABLISHED] * 2
    assert statuses(derived, TEAM_B) == [TeamStatus.SPLIT] * 2
    assert derived.arrivals[TEAM_A] == TeamArrival(ArrivalStatus.ARRIVED, 0, 0, 1)


def test_team_status_ignores_settled() -> None:
    unsettled = PlayerPosition(observed(CourtPoint(0, -5)), observed(False))
    partner = PlayerPosition(observed(CourtPoint(1, -5)), observed(False))
    derived = derive(hit(A1, positions={A1.id: unsettled, A2.id: partner}))
    assert statuses(derived, TEAM_A) == [TeamStatus.ESTABLISHED]


def test_partial_positions_still_settle_established_when_they_can() -> None:
    derived = derive(
        hit(A1, positions=court(None, 10)),  # can't be: one Player is outside the Frontcourt
        hit(B1, positions=court(5, None)),  # could be, if the unseen Player is at the net
    )
    assert established(derived, TEAM_A) == [False, None]
    assert statuses(derived, TEAM_A) == [None, None]


def test_hysteresis_carries_across_an_unknown_position() -> None:
    derived = derive(
        hit(A1, positions=court(5, 5)),
        hit(B1, positions=court(None, 10)),  # Unknown whether still within 12 ft
        hit(A2, positions=court(10, 10)),  # Unknown: depends on the frame we could not see
        hit(B2, positions=court(None, 13)),  # deeper than 12 ft: no longer Established
        hit(A1, positions=court(10, 10)),
    )
    assert established(derived, TEAM_A) == [True, None, None, False, False]
    assert statuses(derived, TEAM_A)[-1] is TeamStatus.BACK


def test_hysteresis_while_established_keeps_status_with_both_players_known() -> None:
    derived = derive(hit(A1, positions=court(5, 5)), hit(B1, positions=court(11, 10)))
    assert established(derived, TEAM_A) == [True, True]


def test_an_unknown_established_team_resyncs_once_both_players_are_in_the_frontcourt() -> None:
    derived = derive(
        hit(A1, positions=court(5, 5)),
        ODD,
        hit(A2, positions=court(10, 10)),
        hit(B1, positions=court(8, 9)),
    )
    assert established(derived, TEAM_A) == [True, None, True]


def test_an_observation_gap_makes_established_unknown() -> None:
    derived = derive(
        hit(A1, positions=court(5, 5, 20, 20)),
        hit(B1, positions=court(5, 5, 20, 20)),
        EVEN,
        hit(A2, positions=court(10, 5, 15, 20)),
        hit(B2, positions=court(13, 5, 9, 9)),
    )
    assert established(derived, TEAM_A) == [True, True, None, False]
    assert established(derived, TEAM_B) == [False, False, False, True]
    # Team A was Established before the gap, so dropping back is a Scramble...
    assert [s.team_in_scramble[TEAM_A] for s in derived.shots] == [False, False, None, True]
    # ...but Team B has never been seen Established, so it was never in one.
    assert derived.shots[2].team_in_scramble[TEAM_B] is None


def test_missing_position_entries_count_as_unknown() -> None:
    derived = derive(hit(A1, HARD, BACK, positions={}))
    assert derived.shots[0].team_status == {TEAM_A: None, TEAM_B: None}
    assert derived.shots[0].team_established == {TEAM_A: None, TEAM_B: None}


# --- Arrival ------------------------------------------------------------------------------


def test_arrival_is_the_first_established_contact_even_on_the_rally_ending_shot() -> None:
    derived = derive(
        hit(A1, positions=court(20, 20, 20, 20)),
        hit(B1, positions=court(18, 20, 5, 5)),
        hit(A2, positions=court(5, 5, 5, 5)),
        winner=TEAM_A,
    )
    assert derived.arrivals[TEAM_B] == TeamArrival(ArrivalStatus.ARRIVED, 1, 1, 2)
    assert derived.arrivals[TEAM_A] == TeamArrival(ArrivalStatus.ARRIVED, 2, 2, 3)


def test_arrival_stays_the_first_contact_after_reestablishing() -> None:
    derived = derive(
        hit(A1, positions=court(5, 5)),
        hit(B1, positions=court(15, 5)),
        hit(A2, positions=court(5, 5)),
    )
    assert derived.arrivals[TEAM_A] == TeamArrival(ArrivalStatus.ARRIVED, 0, 0, 1)


def test_arrived_by_after_a_gap() -> None:
    derived = derive(
        hit(A1, positions=court(20, 20)),
        hit(B1, positions=court(20, 20)),
        ODD,
        hit(B2, positions=court(5, 5)),
    )
    assert derived.arrivals[TEAM_A] == TeamArrival(ArrivalStatus.ARRIVED_BY, 3, 2, None)


def test_arrived_by_after_an_unknown_position() -> None:
    derived = derive(
        hit(A1, positions=court(20, 20)),
        hit(B1, positions=court(None, 5)),
        hit(A2, positions=court(5, 5)),
    )
    assert derived.arrivals[TEAM_A] == TeamArrival(ArrivalStatus.ARRIVED_BY, 2, 2, 3)


def test_never_arrived_and_unknown_arrivals() -> None:
    never = derive(hit(A1, positions=ALL_BACK), hit(B1, positions=ALL_BACK))
    assert never.arrivals == {
        TEAM_A: TeamArrival(ArrivalStatus.NEVER_ARRIVED),
        TEAM_B: TeamArrival(ArrivalStatus.NEVER_ARRIVED),
    }
    unknown = TeamArrival(ArrivalStatus.UNKNOWN)
    assert derive().arrivals == {TEAM_A: unknown, TEAM_B: unknown}
    assert derive(EVEN).arrivals == {TEAM_A: unknown, TEAM_B: unknown}
    ends_unknown = derive(hit(A1, positions=ALL_BACK), ODD)
    assert ends_unknown.arrivals == {TEAM_A: unknown, TEAM_B: unknown}


# --- Rally Phase --------------------------------------------------------------------------


def phases(derived: DerivedRally) -> list[RallyPhase | None]:
    return [s.rally_phase for s in derived.shots]


def test_rally_phases_from_transition_to_frontcourt_battle() -> None:
    derived = derive(
        hit(A1, positions=court(21, 21, 21, 5)),
        hit(B1, positions=court(21, 21, 21, 5)),
        hit(A2, positions=court(15, 15, 5, 5)),
        hit(B2, positions=court(5, 5, 5, 5)),
    )
    assert phases(derived) == [
        RallyPhase.SERVE,
        RallyPhase.RETURN,
        RallyPhase.TRANSITION,
        RallyPhase.FRONTCOURT_BATTLE,
    ]


def test_scramble_takes_precedence_over_transition_and_ends_on_reestablishing() -> None:
    derived = derive(
        hit(A1, positions=court(20, 20, 20, 20)),
        hit(B1, positions=court(20, 20, 5, 5)),
        hit(A2, positions=court(15, 15, 13, 5)),  # B pushed back: Scramble, A still Transition
        hit(B2, positions=court(15, 15, 5, 5)),  # B back at the net: Transition again
        hit(A1, positions=court(5, 5, 5, 5)),
        hit(B1, positions=court(5, 5, 14, 5)),  # B pushed back, other Team's status Unknown
        hit(A2, positions=court(5, None, 14, 5)),
        hit(B2, positions=court(5, 5, 5, 5)),
    )
    assert phases(derived)[2:] == [
        RallyPhase.SCRAMBLE,
        RallyPhase.TRANSITION,
        RallyPhase.FRONTCOURT_BATTLE,
        RallyPhase.SCRAMBLE,
        RallyPhase.SCRAMBLE,
        RallyPhase.FRONTCOURT_BATTLE,
    ]


def test_rally_phase_is_unknown_when_team_status_is() -> None:
    derived = derive(*serve_return(), hit(A2, positions=court(5, 5)))
    assert phases(derived) == [RallyPhase.SERVE, RallyPhase.RETURN, None]
    assert phases(derive(ODD, hit(B1, positions=ALL_BACK))) == [None]


# --- Winner -------------------------------------------------------------------------------


def test_only_the_last_shot_can_be_a_winner() -> None:
    derived = derive(*serve_return(), hit(A2, SOFT, MID), winner=TEAM_A)
    assert [s.is_winner for s in derived.shots] == [False, False, True]


def test_a_clean_last_shot_is_a_winner_only_if_the_hitters_team_won() -> None:
    assert last(derive(*serve_return(), winner=TEAM_B)).is_winner is True
    assert last(derive(*serve_return(), winner=TEAM_A)).is_winner is False
    assert last(derive(*serve_return())).is_winner is None
    assert last(derive(hit(A1), hit(None), winner=TEAM_B)).is_winner is None


@pytest.mark.parametrize(
    "kind", [ErrorKind.NET, ErrorKind.OUT, ErrorKind.KITCHEN_FAULT, ErrorKind.DOUBLE_HIT]
)
def test_a_played_error_is_never_a_winner(kind: ErrorKind) -> None:
    shot = hit(B1, HARD, BACK, error=error(kind, None))
    assert last(derive(hit(A1), shot, winner=TEAM_B)).is_winner is False


def test_a_body_hit_is_a_winner_when_it_hits_an_opponent() -> None:
    on_opponent = hit(B1, HARD, FRONT, error=error(ErrorKind.BODY_HIT, A2))
    on_partner = hit(B1, HARD, FRONT, error=error(ErrorKind.BODY_HIT, B2))
    who_unknown = hit(B1, HARD, FRONT, error=error(ErrorKind.BODY_HIT, None))
    assert last(derive(hit(A1), on_opponent)).is_winner is True
    assert last(derive(hit(A1), on_partner)).is_winner is False
    assert last(derive(hit(A1), who_unknown, winner=TEAM_B)).is_winner is True
    assert last(derive(hit(A1), who_unknown)).is_winner is None


def test_an_error_of_unknown_kind_is_judged_by_whose_error_it_was() -> None:
    by_opponent = hit(B1, HARD, error=error(None, A1))
    by_hitter = hit(B1, HARD, error=error(None, B1))
    by_nobody_known = hit(B1, HARD, error=error(None, None))
    assert last(derive(hit(A1), by_opponent)).is_winner is True
    assert last(derive(hit(A1), by_hitter)).is_winner is False
    assert last(derive(hit(A1), by_nobody_known, winner=TEAM_A)).is_winner is False
    assert last(derive(hit(A1), by_nobody_known)).is_winner is None


def test_an_overturned_challenge_overrides_the_original_call() -> None:
    netted = hit(B1, HARD, BACK, error=error(ErrorKind.OUT, B1))
    assert last(derive(hit(A1), netted, winner=TEAM_B, challenge=OVERTURNED)).is_winner is True
    assert last(derive(hit(A1), netted, challenge=OVERTURNED)).is_winner is None
    assert last(derive(hit(A1), netted, winner=TEAM_B, challenge=UPHELD)).is_winner is False
    clean = hit(B1, HARD, BACK)
    assert last(derive(hit(A1), clean, winner=TEAM_A, challenge=OVERTURNED)).is_winner is False


def test_a_trailing_gap_means_the_last_shot_seen_was_no_winner() -> None:
    assert last(derive(*serve_return(), ODD, winner=TEAM_B)).is_winner is False


# --- Target -------------------------------------------------------------------------------


def test_target_is_the_next_hitter() -> None:
    derived = derive(hit(A1), hit(B2), hit(A2))
    assert [s.target_id for s in derived.shots[:2]] == [B2.id, A2.id]


def test_target_is_unknown_before_a_gap_an_unknown_hitter_or_a_same_team_shot() -> None:
    derived = derive(hit(A1), ODD, hit(B1), hit(None), hit(A1), hit(A2), hit(B1))
    assert [s.target_id for s in derived.shots] == [None, None, A1.id, None, B1.id, None]


def test_target_is_unknown_on_a_last_shot_that_is_not_a_winner() -> None:
    netted = hit(B1, SOFT, FRONT, error=error(ErrorKind.NET, B1))
    assert last(derive(hit(A1), netted, winner=TEAM_A)).target_id is None
    assert last(derive(hit(A1), hit(B1))).target_id is None


def test_a_body_hit_winner_targets_the_player_hit() -> None:
    shot = hit(B1, HARD, FRONT, error=error(ErrorKind.BODY_HIT, A2), positions=ALL_FRONT)
    assert last(derive(hit(A1), shot, winner=TEAM_B)).target_id == A2.id


def _winner_geometry(hitter_known: bool) -> PlayerId | None:
    """A1 at (0, -5) hits to (8, 10): the ball crosses the net at (8/3, 0). B1 stands near that
    crossing; B2 stands nearer the landing."""
    positions = {
        B1.id: PlayerPosition(observed(CourtPoint(2.0, 2.5))),
        B2.id: PlayerPosition(observed(CourtPoint(8.0, 14.0))),
    }
    if hitter_known:
        positions[A1.id] = PlayerPosition(observed(CourtPoint(0.0, -5.0)))
    shot = hit(A1, HARD, FRONT, positions=positions, landing=CourtPoint(8.0, 10.0))
    return last(derive(hit(B1), shot, winner=TEAM_A)).target_id


def test_a_clean_winner_targets_the_opponent_nearest_its_path_on_their_side() -> None:
    assert _winner_geometry(hitter_known=True) == B1.id


def test_a_clean_winner_falls_back_to_the_landing_without_the_hitters_position() -> None:
    assert _winner_geometry(hitter_known=False) == B2.id


def test_a_clean_winner_with_both_opponents_equally_near_has_no_target() -> None:
    positions = {
        A1.id: PlayerPosition(observed(CourtPoint(0.0, -5.0))),
        B1.id: PlayerPosition(observed(CourtPoint(-3.0, 5.0))),
        B2.id: PlayerPosition(observed(CourtPoint(3.0, 5.0))),
    }
    shot = hit(A1, HARD, FRONT, positions=positions, landing=CourtPoint(0.0, 10.0))
    assert last(derive(hit(B1), shot, winner=TEAM_A)).target_id is None


def test_a_clean_winner_needs_the_landing_and_both_opponents_positions() -> None:
    no_landing = hit(A1, HARD, FRONT, positions=ALL_FRONT)
    one_opponent = hit(A1, HARD, FRONT, positions=court(5, 5, 5), landing=CourtPoint(0, 10))
    assert last(derive(hit(B1), no_landing, winner=TEAM_A)).target_id is None
    assert last(derive(hit(B1), one_opponent, winner=TEAM_A)).target_id is None


def test_a_winner_from_the_hitters_own_side_falls_back_to_the_landing() -> None:
    positions = {
        A1.id: PlayerPosition(observed(CourtPoint(0.0, 2.0))),  # past the net (malformed)
        B1.id: PlayerPosition(observed(CourtPoint(0.0, 3.0))),
        B2.id: PlayerPosition(observed(CourtPoint(6.0, 12.0))),
    }
    shot = hit(A1, HARD, FRONT, positions=positions, landing=CourtPoint(6.0, 10.0))
    assert last(derive(hit(B1), shot, winner=TEAM_A)).target_id == B2.id


def test_a_winner_hit_from_on_the_net_measures_the_whole_path() -> None:
    """A1 on the net at (0, 0) hits to (8, 10): the whole path is on Team B's side. B1 stands
    just off its start; B2 stands nearer the landing."""
    positions = {
        A1.id: PlayerPosition(observed(CourtPoint(0.0, 0.0))),
        B1.id: PlayerPosition(observed(CourtPoint(1.0, 2.0))),
        B2.id: PlayerPosition(observed(CourtPoint(8.0, 14.0))),
    }
    shot = hit(A1, HARD, FRONT, positions=positions, landing=CourtPoint(8.0, 10.0))
    assert last(derive(hit(B1), shot, winner=TEAM_A)).target_id == B1.id


def test_an_overturned_body_hit_winner_takes_its_target_from_the_path() -> None:
    """The Body Hit on B2 was overturned, so the Error no longer names the Target: B1, nearest
    the path, does."""
    positions = {
        A1.id: PlayerPosition(observed(CourtPoint(0.0, -5.0))),
        B1.id: PlayerPosition(observed(CourtPoint(2.0, 2.5))),
        B2.id: PlayerPosition(observed(CourtPoint(8.0, 14.0))),
    }
    shot = hit(
        A1,
        HARD,
        FRONT,
        positions=positions,
        landing=CourtPoint(8.0, 10.0),
        error=error(ErrorKind.BODY_HIT, B2),
    )
    derived = derive(hit(B1), shot, winner=TEAM_A, challenge=OVERTURNED)
    assert last(derived).is_winner is True
    assert last(derived).target_id == B1.id


# --- Put-away -----------------------------------------------------------------------------


def test_only_attacks_can_be_put_aways() -> None:
    assert last(derive(*serve_return(), hit(A2, SOFT, MID), winner=TEAM_A)).is_put_away is False
    assert last(derive(*serve_return(), hit(A2, None), winner=TEAM_A)).is_put_away is None
    assert last(derive(*serve_return(), winner=TEAM_B)).is_put_away is False  # a Return


def test_an_attack_that_wins_the_rally_is_a_put_away() -> None:
    drive = hit(A2, HARD, BACK)
    derived = derive(*serve_return(), drive, winner=TEAM_A)
    assert last(derived).shot_type is ShotType.DRIVE
    assert last(derived).is_put_away is True


def test_a_last_attack_that_did_not_win_is_not_a_put_away() -> None:
    netted = hit(A2, HARD, BACK, error=error(ErrorKind.NET, A2))
    assert last(derive(*serve_return(), netted, winner=TEAM_B)).is_put_away is False
    assert last(derive(*serve_return(), hit(A2, HARD, BACK))).is_put_away is None


def test_an_attack_before_a_gap_or_returned_twice_is_not_known_to_be_a_put_away() -> None:
    assert derive(*serve_return(), bang(A2), ODD).shots[2].is_put_away is None
    assert derive(*serve_return(), bang(A2), dink(B1), dink(A1)).shots[2].is_put_away is False


def test_an_attack_answered_by_an_opponents_error_is_a_put_away() -> None:
    netted_reply = dink(B1, error=error(ErrorKind.NET, B1))
    derived = derive(*serve_return(), hit(A2, HARD, MID), netted_reply, winner=TEAM_A)
    assert derived.shots[2].shot_type is ShotType.DRIVE
    assert derived.shots[2].is_put_away is True


def test_an_opponents_body_hit_back_onto_the_attacker_is_not_a_put_away() -> None:
    reply = bang(B1, error=error(ErrorKind.BODY_HIT, A2))
    assert derive(*serve_return(), bang(A2), reply, winner=TEAM_B).shots[2].is_put_away is False


def test_a_reply_error_by_an_unknown_player_is_judged_by_the_replier() -> None:
    by_opponent = dink(B1, error=error(ErrorKind.OUT, None))
    by_unknown = hit(None, SOFT, error=error(ErrorKind.OUT, None))
    unknown_kind = dink(B1, error=error(None, None))
    assert derive(*serve_return(), bang(A2), by_opponent).shots[2].is_put_away is True
    assert derive(*serve_return(), bang(A2), by_unknown).shots[2].is_put_away is None
    assert derive(*serve_return(), bang(A2), unknown_kind).shots[2].is_put_away is None


def test_a_reply_error_by_an_unknown_player_on_the_attackers_side_is_not_known() -> None:
    by_partner = hit(A1, SOFT, FRONT, error=error(ErrorKind.OUT, None))
    body_hit = dink(B1, error=error(ErrorKind.BODY_HIT, None))
    assert derive(*serve_return(), bang(A2), by_partner).shots[2].is_put_away is None
    assert derive(*serve_return(), bang(A2), body_hit).shots[2].is_put_away is None


def test_a_clean_last_reply_means_the_attack_was_not_a_put_away() -> None:
    assert derive(*serve_return(), bang(A2), dink(B1), winner=TEAM_B).shots[2].is_put_away is False


def test_an_overturned_challenge_decides_a_put_away_on_the_reply() -> None:
    reply = dink(B1, error=error(ErrorKind.OUT, B1))
    overturned = derive(*serve_return(), bang(A2), reply, winner=TEAM_B, challenge=OVERTURNED)
    assert overturned.shots[2].is_put_away is False
    unknown = derive(*serve_return(), bang(A2), reply, challenge=OVERTURNED)
    assert unknown.shots[2].is_put_away is None
    # A clean reply called in, overturned to out: the attacker's Team won.
    called_in = derive(*serve_return(), bang(A2), dink(B1), winner=TEAM_A, challenge=OVERTURNED)
    assert called_in.shots[2].is_put_away is True


def test_put_away_needs_the_attackers_team() -> None:
    reply = dink(B1, error=error(ErrorKind.NET, B1))
    assert derive(*serve_return(), bang(A2), reply).shots[2].is_put_away is True
    unknown_hitter = hit(None, HARD, FRONT, positions=ALL_FRONT)
    assert derive(*serve_return(), unknown_hitter, reply).shots[2].is_put_away is None


# --- Popup --------------------------------------------------------------------------------


def test_only_soft_shots_can_be_popups() -> None:
    derived = derive(*serve_return(), bang(A2), hit(B1, OVERHEAD), hit(None, None), dink(B1))
    assert [s.is_popup for s in derived.shots[2:]] == [False, False, None, False]


def test_a_soft_shot_answered_by_an_overhead_is_a_popup_even_if_the_overhead_misses() -> None:
    missed = hit(B1, OVERHEAD, error=error(ErrorKind.NET, B1))
    derived = derive(*serve_return(), dink(A2), missed, winner=TEAM_A)
    assert derived.shots[2].is_popup is True
    assert derived.shots[3].is_put_away is False


def test_a_soft_shot_answered_by_a_put_away_is_a_popup() -> None:
    assert derive(*serve_return(), dink(A2), bang(B1), winner=TEAM_B).shots[2].is_popup is True


def test_a_soft_shot_answered_by_a_non_put_away_is_not_a_popup() -> None:
    derived = derive(*serve_return(), dink(A2), bang(B1), dink(A1), dink(B2))
    assert derived.shots[2].is_popup is False
    assert derive(*serve_return(), dink(A2), dink(B1), dink(A1)).shots[2].is_popup is False


def test_popup_is_unknown_before_a_gap_or_an_unknown_reply() -> None:
    assert derive(*serve_return(), dink(A2), ODD).shots[2].is_popup is None
    assert derive(*serve_return(), dink(A2), hit(B1)).shots[2].is_popup is None
    assert derive(*serve_return(), dink(A2), bang(B1)).shots[2].is_popup is None


def test_a_soft_return_can_be_a_popup() -> None:
    derived = derive(hit(A1, HARD, BACK), hit(B1, SOFT, BACK), hit(A2, OVERHEAD), winner=TEAM_A)
    assert derived.shots[1].shot_type is ShotType.RETURN
    assert derived.shots[1].is_popup is True


# --- Speedup Exchange ---------------------------------------------------------------------


def exchange_types(derived: DerivedRally) -> list[ShotType | None]:
    return [s.shot_type for s in derived.shots]


def test_a_speedup_exchange_won_by_the_speeding_up_team() -> None:
    netted_counter = bang(B2, error=error(ErrorKind.NET, B2))
    derived = derive(*serve_return(), dink(A2), dink(B1), bang(A1), netted_counter, winner=TEAM_A)
    assert exchange_types(derived)[4:] == [ShotType.SPEEDUP, ShotType.COUNTER]
    (exchange,) = derived.speedup_exchanges
    assert exchange.initiating_team_id == TEAM_A
    assert exchange.initiating_player_id == A1.id
    assert exchange.rally_phase is RallyPhase.FRONTCOURT_BATTLE
    assert (exchange.start_entry_index, exchange.end_entry_index) == (4, 5)
    assert exchange.shot_indices == (4, 5)
    assert exchange.outcome is ExchangeOutcome.WON
    assert [s.speedup_exchange_index for s in derived.shots] == [None] * 4 + [0, 0]


def test_a_speedup_exchange_lost_to_a_counter_winner() -> None:
    derived = derive(*serve_return(), dink(A2), bang(B1), bang(A1), winner=TEAM_A)
    (exchange,) = derived.speedup_exchanges
    assert exchange.initiating_team_id == TEAM_B
    assert exchange.outcome is ExchangeOutcome.LOST


def test_a_neutral_speedup_exchange_ends_on_the_neutralising_shot() -> None:
    derived = derive(*serve_return(), dink(A2), bang(B1), dink(A1), dink(B2), dink(A2))
    assert exchange_types(derived)[3:5] == [ShotType.SPEEDUP, ShotType.BLOCK]
    (exchange,) = derived.speedup_exchanges
    assert (exchange.start_entry_index, exchange.end_entry_index) == (3, 4)
    assert exchange.outcome is ExchangeOutcome.NEUTRAL
    assert [s.speedup_exchange_index for s in derived.shots] == [None, None, None, 0, 0, None, None]


def test_speedup_block_netted_dink_is_neutral() -> None:
    netted_dink = dink(B2, error=error(ErrorKind.NET, B2))
    derived = derive(*serve_return(), dink(A2), bang(B1), dink(A1), netted_dink, winner=TEAM_A)
    (exchange,) = derived.speedup_exchanges
    assert exchange.end_entry_index == 4
    assert exchange.outcome is ExchangeOutcome.NEUTRAL


def test_speedup_netted_block_is_won() -> None:
    netted_block = dink(A1, error=error(ErrorKind.NET, A1))
    derived = derive(*serve_return(), dink(A2), bang(B1), netted_block, winner=TEAM_B)
    (exchange,) = derived.speedup_exchanges
    assert exchange.end_entry_index == 4
    assert exchange.outcome is ExchangeOutcome.WON


def test_a_transition_speedup_exchange_through_a_drive_and_a_reset() -> None:
    transition = court(15, 15, 5, 5)
    seen_serve_return = (
        hit(A1, HARD, BACK, positions=ALL_BACK),
        hit(B1, HARD, BACK, positions=ALL_BACK),
    )
    derived = derive(
        *seen_serve_return,
        hit(A2, SOFT, MID, positions=transition),  # Drop
        hit(B1, HARD, FRONT, positions=transition),  # Speedup
        hit(A1, HARD, MID, positions=transition),  # Drive
        hit(B2, SOFT, FRONT, positions=transition),  # Block
        hit(A2, SOFT, MID, positions=transition),  # Drop
    )
    assert exchange_types(derived)[2:] == [
        ShotType.DROP,
        ShotType.SPEEDUP,
        ShotType.DRIVE,
        ShotType.BLOCK,
        ShotType.DROP,
    ]
    (exchange,) = derived.speedup_exchanges
    assert exchange.rally_phase is RallyPhase.TRANSITION
    assert exchange.shot_indices == (3, 4, 5)
    assert exchange.outcome is ExchangeOutcome.NEUTRAL

    reset = derive(
        *seen_serve_return,
        hit(A2, SOFT, MID, positions=transition),
        hit(B1, HARD, FRONT, positions=transition),  # Speedup
        hit(A1, SOFT, MID, positions=transition),  # Reset
        hit(B2, SOFT, FRONT, positions=transition),  # Dink
    )
    assert reset.shots[4].shot_type is ShotType.RESET
    (exchange,) = reset.speedup_exchanges
    assert exchange.shot_indices == (3, 4)
    assert exchange.outcome is ExchangeOutcome.NEUTRAL


def test_a_follow_up_speedup_stays_in_the_same_exchange() -> None:
    netted = bang(B1, error=error(ErrorKind.NET, B1))
    derived = derive(*serve_return(), dink(A2), bang(B1), dink(A1), bang(B2), netted)
    assert exchange_types(derived)[3:] == [
        ShotType.SPEEDUP,
        ShotType.BLOCK,
        ShotType.SPEEDUP,
        ShotType.COUNTER,
    ]
    (exchange,) = derived.speedup_exchanges
    assert exchange.initiating_player_id == B1.id
    assert exchange.shot_indices == (3, 4, 5, 6)
    assert exchange.outcome is ExchangeOutcome.LOST  # winner from the Error: B1 netted


def test_several_speedup_exchanges_in_one_rally() -> None:
    derived = derive(
        *serve_return(),
        dink(A2),
        bang(B1),  # first exchange
        dink(A1),  # Block: neutral
        dink(B2),
        bang(A2),  # second exchange
        bang(B1),  # Counter winner
        winner=TEAM_B,
    )
    first, second = derived.speedup_exchanges
    assert (first.shot_indices, first.outcome) == ((3, 4), ExchangeOutcome.NEUTRAL)
    assert (second.shot_indices, second.outcome) == ((6, 7), ExchangeOutcome.LOST)
    assert second.initiating_team_id == TEAM_A
    assert [s.speedup_exchange_index for s in derived.shots] == [None] * 3 + [0, 0, None, 1, 1]


def test_a_gap_interrupts_a_speedup_exchange_and_a_later_one_still_starts() -> None:
    derived = derive(
        *serve_return(), dink(A2), bang(B1), bang(A1), ODD, dink(B2), dink(A1), bang(B2)
    )
    first, second = derived.speedup_exchanges
    assert (first.start_entry_index, first.end_entry_index, first.outcome) == (3, 4, None)
    assert second.start_entry_index == 8
    assert second.outcome is None  # the Rally's winner is Unknown


def test_an_unknown_shot_class_interrupts_a_speedup_exchange() -> None:
    unknown_reply = hit(A1, None, FRONT, positions=ALL_FRONT)
    derived = derive(*serve_return(), dink(A2), bang(B1), unknown_reply, dink(B1))
    assert derived.speedup_exchanges[0].end_entry_index == 4
    assert derived.speedup_exchanges[0].outcome is None
    # A Block whose reply is of Unknown Shot Class might or might not have neutralised it.
    derived = derive(*serve_return(), dink(A2), bang(B1), dink(A1), hit(B2), dink(A1))
    assert derived.speedup_exchanges[0].end_entry_index == 4
    assert derived.speedup_exchanges[0].outcome is None


def test_an_exchange_outcome_falls_back_to_the_last_error_and_needs_the_initiator() -> None:
    netted = bang(A1, error=error(ErrorKind.NET, A1))
    assert (
        derive(*serve_return(), dink(A2), bang(B1), netted).speedup_exchanges[0].outcome
        is ExchangeOutcome.WON
    )
    overturned = derive(*serve_return(), dink(A2), bang(B1), netted, challenge=OVERTURNED)
    assert overturned.speedup_exchanges[0].outcome is None
    nobody = hit(None, HARD, FRONT, positions=ALL_FRONT)
    unknown_initiator = derive(*serve_return(), dink(A2), nobody, dink(A1), winner=TEAM_A)
    assert unknown_initiator.speedup_exchanges[0].initiating_team_id is None
    assert unknown_initiator.speedup_exchanges[0].outcome is None


def test_resolve_attack_exchange_judges_a_counter_off_a_drive() -> None:
    log = rally(
        *serve_return(),
        hit(A2, HARD, MID, positions=ALL_FRONT),  # Drive
        bang(B1),  # Counter
        dink(A1),  # Block
        dink(B2),  # Dink: the exchange was neutralised by the Block
    )
    derived = derive_rally(log, ROSTER)
    assert exchange_types(derived)[2:] == [
        ShotType.DRIVE,
        ShotType.COUNTER,
        ShotType.BLOCK,
        ShotType.DINK,
    ]
    assert derived.speedup_exchanges == ()
    counter = resolve_attack_exchange(log, ROSTER, derived.shots, 3, TEAM_B)
    assert (counter.start_entry_index, counter.end_entry_index) == (3, 4)
    assert counter.shot_indices == (3, 4)
    assert counter.outcome is ExchangeOutcome.NEUTRAL


def test_resolve_attack_exchange_needs_a_shot_to_start_from() -> None:
    log = rally(*serve_return(), ODD, bang(A1))
    derived = derive_rally(log, ROSTER)
    with pytest.raises(ValueError, match="not a Shot"):
        resolve_attack_exchange(log, ROSTER, derived.shots, 2, TEAM_A)


# --- Messy Rallies ------------------------------------------------------------------------


def test_an_empty_rally_derives_nothing() -> None:
    derived = derive()
    assert derived.shots == ()
    assert derived.speedup_exchanges == ()
    assert derived.shot_at(0) is None


def test_a_gap_only_rally_derives_nothing() -> None:
    derived = derive(ODD)
    assert derived.shots == ()
    assert derived.speedup_exchanges == ()


def test_an_error_before_the_last_shot_does_not_crash_or_make_a_winner() -> None:
    early = hit(B1, HARD, BACK, error=error(ErrorKind.NET, B1))
    derived = derive(hit(A1), early, hit(A2, HARD, MID), winner=TEAM_B)
    assert [s.is_winner for s in derived.shots] == [False, False, False]
    assert derived.shots[1].target_id == A2.id


def test_a_shot_of_unknown_everything_derives_unknowns() -> None:
    derived = derive(EVEN, Shot())
    shot = last(derived)
    assert shot.hitter_id is None
    assert shot.hitter_team_id is None
    assert shot.contact_zone is None
    assert shot.is_attack is None
    assert shot.shot_type is None
    assert shot.is_winner is None
    assert shot.target_id is None
    assert shot.is_put_away is None
    assert shot.is_popup is None
    assert derived.shot_at(1) is shot


def test_annotation_workflow_fields_are_ignored() -> None:
    plain = rally(*serve_return(), winner=TEAM_B)
    annotated = Rally(
        number=1,
        entries=plain.entries,
        winner_id=plain.winner_id,
        scoreboard_winner_id=observed(TEAM_A),
        status=RallyStatus.IN_PROGRESS,
    )
    plain_shots = derive_rally(plain, ROSTER).shots
    assert derive_rally(annotated, ROSTER).shots == plain_shots


def test_players_and_teams_outside_the_match_are_rejected() -> None:
    stranger = Player(PlayerId(new_id()), "Stranger", Handedness.RIGHT)
    with pytest.raises(ValueError, match="hitter"):
        derive(hit(stranger))
    with pytest.raises(ValueError, match="position"):
        derive(hit(A1, positions={stranger.id: PlayerPosition()}))
    with pytest.raises(ValueError, match="Error"):
        derive(hit(A1, error=error(ErrorKind.BODY_HIT, stranger)))
    with pytest.raises(ValueError, match="winner"):
        derive(hit(A1), winner=TeamId(new_id()))


# --- Games and Matches --------------------------------------------------------------------


def test_derive_match_derives_every_game_and_rally() -> None:
    first = rally(*serve_return(), winner=TEAM_B)
    second = Rally(number=2)
    match = Match(
        id=ROSTER.match_id,
        tournament_id=TournamentId(new_id()),
        team_a_id=TEAM_A,
        team_b_id=TEAM_B,
        games=(Game(1, (first, second)), Game(2)),
    )
    derived = derive_match(match, ROSTER)
    assert derived.match is match
    assert [len(g.rallies) for g in derived.games] == [2, 0]
    assert derived.games[0] == derive_game(match.games[0], ROSTER)
    assert derived.games[0].rallies[0] == derive_rally(first, ROSTER)


def test_derive_match_rejects_a_roster_for_other_teams() -> None:
    match = Match(
        id=MatchId(new_id()),
        tournament_id=TournamentId(new_id()),
        team_a_id=TEAM_A,
        team_b_id=TeamId(new_id()),
    )
    with pytest.raises(ValueError, match="does not fit"):
        derive_match(match, ROSTER)
