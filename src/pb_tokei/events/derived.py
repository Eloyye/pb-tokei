"""Derived facts: judgments worked out from the Rally Log by written rules (ADR 0003).

Every function here is pure. It reads only the in-memory Rally Log (ADR 0001), never DuckDB,
Tracking caches or video, and ignores annotation-workflow fields such as `Rally.status` and
`Rally.scoreboard_winner_id` (ADR 0013).

Observed and Inferred facts count alike as known values. An Unknown fact makes any judgment that
needs it `None`, so a Derived value is `True`/`False`/an enum member when the rules settle it and
`None` when the Rally Log cannot.

The rules never block on a messy Rally: an Error that is not on the last entry, two Shots in a row
by one Team, missing positions and empty Rallies all degrade to `None` (or `False`) rather than
raising. Only a Player or Team that is not in the Match raises `ValueError`.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import StrEnum

from pb_tokei.rally_log.model import (
    FRONTCOURT_MAX_Y_FT,
    CourtPoint,
    ErrorKind,
    Fact,
    Game,
    Match,
    MatchRoster,
    ObservationGap,
    Parity,
    PlayerId,
    PlayerPosition,
    Rally,
    Ruling,
    Shot,
    ShotClass,
    TeamId,
    Zone,
    zone_for_point,
)

ESTABLISHED_KEEP_MAX_Y_FT = 12.0
"""Inclusive depth, in feet from the net, an Established Team's Players may drop back to and
stay Established; going strictly deeper breaks it."""

OPENING_LAST_SHOT_NUMBER = 5
"""The last Shot Number in the Opening."""

TARGET_TIE_TOLERANCE_FT = 1e-9
"""Two opponents this close to equally near a Winner's path are a tie, with no Target."""

_PLAYED_ERROR_KINDS = frozenset(
    {ErrorKind.NET, ErrorKind.OUT, ErrorKind.KITCHEN_FAULT, ErrorKind.DOUBLE_HIT}
)
"""Error Kinds the hitter of the erring Shot commits (as opposed to a Body Hit)."""


class ShotType(StrEnum):
    SERVE = "serve"
    RETURN = "return"
    DINK = "dink"
    BLOCK = "block"
    DROP = "drop"
    RESET = "reset"
    SPEEDUP = "speedup"
    COUNTER = "counter"
    DRIVE = "drive"
    OFFENSIVE_LOB = "offensive_lob"
    DEFENSIVE_LOB = "defensive_lob"
    OVERHEAD = "overhead"


class TeamStatus(StrEnum):
    ESTABLISHED = "established"
    SPLIT = "split"
    BACK = "back"


class RallyPhase(StrEnum):
    SERVE = "serve"
    RETURN = "return"
    TRANSITION = "transition"
    FRONTCOURT_BATTLE = "frontcourt_battle"
    SCRAMBLE = "scramble"


class ArrivalStatus(StrEnum):
    ARRIVED = "arrived"
    """Established for the first time at exactly this contact."""
    ARRIVED_BY = "arrived_by"
    """First seen Established at this contact, after a gap or Unknown position, so the Team may
    have arrived earlier."""
    NEVER_ARRIVED = "never_arrived"
    UNKNOWN = "unknown"


class ExchangeOutcome(StrEnum):
    """How an attack exchange ended, for the Team that started it."""

    WON = "won"
    LOST = "lost"
    NEUTRAL = "neutral"


@dataclass(frozen=True)
class TeamArrival:
    """A Team's Arrival in one Rally. The indices are set for `ARRIVED` and `ARRIVED_BY` only."""

    status: ArrivalStatus
    entry_index: int | None = None
    shot_index: int | None = None
    shot_number: int | None = None


@dataclass(frozen=True)
class AttackExchange:
    """Where an attack exchange from `start_entry_index` ended, and how.

    `end_entry_index` is the last Shot inside the exchange: the Rally's last Shot, the Shot before
    an Observation Gap, or the Soft Shot or Lob that neutralised it. `shot_indices` index
    `Rally.shots`.
    """

    start_entry_index: int
    end_entry_index: int
    shot_indices: tuple[int, ...]
    outcome: ExchangeOutcome | None


@dataclass(frozen=True)
class SpeedupExchange:
    """A Speedup and the Counters, Blocks and Overheads that follow it (see `AttackExchange`)."""

    initiating_team_id: TeamId | None
    initiating_player_id: PlayerId | None
    rally_phase: RallyPhase | None
    start_entry_index: int
    end_entry_index: int
    shot_indices: tuple[int, ...]
    outcome: ExchangeOutcome | None


@dataclass(frozen=True)
class DerivedShot:
    """Every Derived fact about one Shot. `None` means the Rally Log cannot settle it.

    `entry_index` indexes `Rally.entries` and `shot_index` indexes `Rally.shots`.
    `min_shot_number` is the smallest Shot Number this Shot can have. The per-Team maps hold both
    Teams of the Match at this Shot's contact; `team_established` keeps partial knowledge even
    where `team_status` cannot name a status.
    """

    shot: Shot
    entry_index: int
    shot_index: int
    shot_number: int | None
    min_shot_number: int
    hitter_id: PlayerId | None
    hitter_team_id: TeamId | None
    in_opening: bool | None
    contact_zone: Zone | None
    is_attack: bool | None
    incoming_is_attack: bool | None
    team_status: dict[TeamId, TeamStatus | None]
    team_established: dict[TeamId, bool | None]
    team_in_scramble: dict[TeamId, bool | None]
    rally_phase: RallyPhase | None
    shot_type: ShotType | None
    is_winner: bool | None = None
    target_id: PlayerId | None = None
    is_put_away: bool | None = None
    is_popup: bool | None = None
    speedup_exchange_index: int | None = None


@dataclass(frozen=True)
class DerivedRally:
    rally: Rally
    shots: tuple[DerivedShot, ...] = ()
    arrivals: dict[TeamId, TeamArrival] = field(default_factory=dict)
    speedup_exchanges: tuple[SpeedupExchange, ...] = ()

    def shot_at(self, entry_index: int) -> DerivedShot | None:
        """The Derived Shot at `entry_index` of `Rally.entries`, or None for an Observation Gap."""
        return next((s for s in self.shots if s.entry_index == entry_index), None)


@dataclass(frozen=True)
class DerivedGame:
    game: Game
    rallies: tuple[DerivedRally, ...] = ()


@dataclass(frozen=True)
class DerivedMatch:
    match: Match
    games: tuple[DerivedGame, ...] = ()


# --- Public entry points ------------------------------------------------------------------


def derive_match(match: Match, roster: MatchRoster) -> DerivedMatch:
    if {match.team_a_id, match.team_b_id} != {roster.team_a_id, roster.team_b_id}:
        raise ValueError(f"roster for Match {roster.match_id} does not fit Match {match.id}")
    return DerivedMatch(match, tuple(derive_game(game, roster) for game in match.games))


def derive_game(game: Game, roster: MatchRoster) -> DerivedGame:
    return DerivedGame(game, tuple(derive_rally(rally, roster) for rally in game.rallies))


def derive_rally(rally: Rally, roster: MatchRoster) -> DerivedRally:
    _check_references(rally, roster)
    shots, arrivals = _walk(rally, roster)
    shots = _judge_endings(rally, roster, shots)
    shots, exchanges = _speedup_exchanges(rally, roster, shots)
    return DerivedRally(rally, shots, arrivals, exchanges)


def resolve_attack_exchange(
    rally: Rally,
    roster: MatchRoster,
    shots: Sequence[DerivedShot],
    start_entry_index: int,
    initiating_team_id: TeamId | None,
) -> AttackExchange:
    """Follow an attack exchange from the Shot at `start_entry_index` to where it ends.

    The exchange runs on through every Attack. It ends Neutral at a Soft Shot or Lob whose reply
    is not an Attack (that Shot is the last one in the exchange), Won or Lost for
    `initiating_team_id` when the Rally ends, and with no outcome at an Observation Gap or wherever
    a needed fact is Unknown. `shots` are the Rally's Derived Shots, as in `DerivedRally.shots`.
    """
    by_entry = {s.entry_index: s for s in shots}
    if start_entry_index not in by_entry:
        raise ValueError(f"entry {start_entry_index} of Rally {rally.number} is not a Shot")
    last = len(rally.entries) - 1
    idx = start_entry_index
    outcome: ExchangeOutcome | None
    while True:
        if idx == last:
            outcome = _rally_outcome_for(rally, roster, initiating_team_id)
            break
        if isinstance(rally.entries[idx + 1], ObservationGap):
            outcome = None
            break
        current = by_entry[idx]
        next_is_attack = by_entry[idx + 1].is_attack
        if idx == start_entry_index or current.is_attack is True:
            idx += 1
            continue
        if current.shot.shot_class.value in (ShotClass.SOFT, ShotClass.LOB):
            if next_is_attack is True:
                idx += 1
                continue
            outcome = ExchangeOutcome.NEUTRAL if next_is_attack is False else None
            break
        outcome = None
        break
    shot_indices = tuple(
        by_entry[i].shot_index for i in range(start_entry_index, idx + 1) if i in by_entry
    )
    return AttackExchange(start_entry_index, idx, shot_indices, outcome)


# --- The walk through a Rally -------------------------------------------------------------


def _check_references(rally: Rally, roster: MatchRoster) -> None:
    teams = (roster.team_a_id, roster.team_b_id)
    players = roster.player_ids

    def team(fact: Fact[TeamId], what: str) -> None:
        if fact.value is not None and fact.value not in teams:
            raise ValueError(f"Rally {rally.number} {what}: Team {fact.value} is not in the Match")

    def player(fact: Fact[PlayerId], what: str) -> None:
        if fact.value is not None and fact.value not in players:
            raise ValueError(
                f"Rally {rally.number} {what}: Player {fact.value} is not in the Match"
            )

    team(rally.serving_team_id, "Serving Team")
    team(rally.winner_id, "winner")
    player(rally.server_id, "Server")
    player(rally.returner_id, "Returner")
    if rally.challenge is not None:
        player(rally.challenge.challenger_id, "challenger")
    for shot in rally.shots:
        player(shot.hitter_id, "hitter")
        if shot.error is not None:
            player(shot.error.player_id, "Error")
        for player_id in shot.positions:
            if player_id not in players:
                raise ValueError(
                    f"Rally {rally.number} position: Player {player_id} is not in the Match"
                )


def _next_established(
    current: bool | None, depths: tuple[float | None, float | None]
) -> bool | None:
    """Whether a Team is Established at a contact, from its Players' distances from the net and
    whether it was Established at the previous contact (12 ft hysteresis)."""
    known = [d for d in depths if d is not None]
    both_known = len(known) == 2
    if both_known and all(d <= FRONTCOURT_MAX_Y_FT for d in known):
        return True
    deeper_than_keep = any(d > ESTABLISHED_KEEP_MAX_Y_FT for d in known)
    if current is True:
        if deeper_than_keep:
            return False
        return True if both_known else None
    if current is False:
        return False if any(d > FRONTCOURT_MAX_Y_FT for d in known) else None
    return False if deeper_than_keep else None


def _team_status(
    established: bool | None, depths: tuple[float | None, float | None]
) -> TeamStatus | None:
    if established is True:
        return TeamStatus.ESTABLISHED
    d1, d2 = depths
    if established is False and d1 is not None and d2 is not None:
        in_front = d1 <= FRONTCOURT_MAX_Y_FT or d2 <= FRONTCOURT_MAX_Y_FT
        return TeamStatus.SPLIT if in_front else TeamStatus.BACK
    return None


def _in_scramble(established: bool | None, ever_established: bool | None) -> bool | None:
    if established is True or ever_established is False:
        return False
    if ever_established is True and established is False:
        return True
    return None


def _position(shot: Shot, player_id: PlayerId) -> CourtPoint | None:
    return shot.positions.get(player_id, PlayerPosition()).position.value


def _depths(shot: Shot, roster: MatchRoster, team_id: TeamId) -> tuple[float | None, float | None]:
    first, second = roster.team_players(team_id)
    depths = []
    for player in (first, second):
        point = _position(shot, player.id)
        depths.append(None if point is None else abs(point.y))
    return depths[0], depths[1]


def _contact_zone(shot: Shot, hitter_id: PlayerId | None) -> Zone | None:
    if shot.contact_zone.value is not None:
        return shot.contact_zone.value
    if hitter_id is None:
        return None
    point = _position(shot, hitter_id)
    return None if point is None else zone_for_point(point)


def _is_attack(shot_class: ShotClass | None, number: int | None, min_number: int) -> bool | None:
    if number in (1, 2):
        return False  # a Serve or Return is never an Attack
    if shot_class in (ShotClass.SOFT, ShotClass.LOB):
        return False
    if shot_class is None:
        return None
    if number is None and min_number <= 2:
        return None  # might be the Return
    return True


def _in_opening(number: int | None, min_number: int) -> bool | None:
    if number is not None:
        return 1 <= number <= OPENING_LAST_SHOT_NUMBER
    if min_number > OPENING_LAST_SHOT_NUMBER:
        return False
    return None


def _rally_phase(
    number: int | None,
    min_number: int,
    established: Mapping[TeamId, bool | None],
    in_scramble: Mapping[TeamId, bool | None],
) -> RallyPhase | None:
    if number == 1:
        return RallyPhase.SERVE
    if number == 2:
        return RallyPhase.RETURN
    if number is None and min_number <= 2:
        return None
    if any(s is True for s in in_scramble.values()):
        return RallyPhase.SCRAMBLE
    if all(e is True for e in established.values()):
        return RallyPhase.FRONTCOURT_BATTLE
    if all(s is False for s in in_scramble.values()) and any(
        e is False for e in established.values()
    ):
        return RallyPhase.TRANSITION
    return None


def _shot_type(
    shot_class: ShotClass | None,
    zone: Zone | None,
    incoming_is_attack: bool | None,
    hitter_team_established: bool | None,
    number: int | None,
    min_number: int,
) -> ShotType | None:
    if number == 1:
        return ShotType.SERVE
    if number == 2:
        return ShotType.RETURN
    if number is None and min_number <= 2:
        return None
    match shot_class:
        case ShotClass.OVERHEAD:
            return ShotType.OVERHEAD
        case ShotClass.LOB:
            if hitter_team_established is None:
                return None
            return ShotType.OFFENSIVE_LOB if hitter_team_established else ShotType.DEFENSIVE_LOB
        case ShotClass.HARD:
            if zone in (Zone.MIDCOURT, Zone.BACKCOURT):
                return ShotType.DRIVE
            if zone is None or incoming_is_attack is None:
                return None
            return ShotType.COUNTER if incoming_is_attack else ShotType.SPEEDUP
        case ShotClass.SOFT:
            if zone is None or incoming_is_attack is None:
                return None
            if zone is Zone.FRONTCOURT:
                return ShotType.BLOCK if incoming_is_attack else ShotType.DINK
            return ShotType.RESET if incoming_is_attack else ShotType.DROP
        case _:
            return None


def _walk(
    rally: Rally, roster: MatchRoster
) -> tuple[tuple[DerivedShot, ...], dict[TeamId, TeamArrival]]:
    """Walk the Rally's entries in order, working out every fact that only looks backwards."""
    team_ids = (roster.team_a_id, roster.team_b_id)
    min_number = 0
    previous_number: int | None = 0
    incoming_is_attack: bool | None = False
    established: dict[TeamId, bool | None] = dict.fromkeys(team_ids, False)
    ever_established: dict[TeamId, bool | None] = dict.fromkeys(team_ids, False)
    arrivals: dict[TeamId, TeamArrival] = {}
    shots: list[DerivedShot] = []

    for entry_index, entry in enumerate(rally.entries):
        if isinstance(entry, ObservationGap):
            min_number += 1 if entry.missing is Parity.ODD else 2
            previous_number = None
            incoming_is_attack = None
            for team_id in team_ids:
                established[team_id] = None
                if ever_established[team_id] is False:
                    ever_established[team_id] = None
            continue

        shot = entry
        min_number += 1
        number: int | None
        if shot.shot_number.value is not None:
            number = shot.shot_number.value
        elif previous_number is not None:
            number = previous_number + 1
        else:
            number = None
        if number is not None:
            min_number = number
        previous_number = number

        hitter_id = shot.hitter_id.value
        hitter_team_id = None if hitter_id is None else roster.team_id_for(hitter_id)
        shot_index = len(shots)

        status: dict[TeamId, TeamStatus | None] = {}
        in_scramble: dict[TeamId, bool | None] = {}
        for team_id in team_ids:
            depths = _depths(shot, roster, team_id)
            now = _next_established(established[team_id], depths)
            before = ever_established[team_id]
            status[team_id] = _team_status(now, depths)
            in_scramble[team_id] = _in_scramble(now, before)
            if before is False:
                if now is True:
                    arrivals[team_id] = TeamArrival(
                        ArrivalStatus.ARRIVED, entry_index, shot_index, number
                    )
                    ever_established[team_id] = True
                elif now is None:
                    ever_established[team_id] = None
            elif before is None and now is True:
                arrivals[team_id] = TeamArrival(
                    ArrivalStatus.ARRIVED_BY, entry_index, shot_index, number
                )
                ever_established[team_id] = True
            established[team_id] = now

        shot_class = shot.shot_class.value
        zone = _contact_zone(shot, hitter_id)
        is_attack = _is_attack(shot_class, number, min_number)
        hitter_established = None if hitter_team_id is None else established[hitter_team_id]
        shots.append(
            DerivedShot(
                shot=shot,
                entry_index=entry_index,
                shot_index=shot_index,
                shot_number=number,
                min_shot_number=min_number,
                hitter_id=hitter_id,
                hitter_team_id=hitter_team_id,
                in_opening=_in_opening(number, min_number),
                contact_zone=zone,
                is_attack=is_attack,
                incoming_is_attack=incoming_is_attack,
                team_status=status,
                team_established=dict(established),
                team_in_scramble=in_scramble,
                rally_phase=_rally_phase(number, min_number, established, in_scramble),
                shot_type=_shot_type(
                    shot_class, zone, incoming_is_attack, hitter_established, number, min_number
                ),
            )
        )
        incoming_is_attack = is_attack

    for team_id in team_ids:
        if team_id in arrivals:
            continue
        never = bool(shots) and ever_established[team_id] is False
        arrivals[team_id] = TeamArrival(
            ArrivalStatus.NEVER_ARRIVED if never else ArrivalStatus.UNKNOWN
        )
    return tuple(shots), arrivals


# --- How Shots end ------------------------------------------------------------------------


def _overturned(rally: Rally) -> bool:
    return rally.challenge is not None and rally.challenge.ruling.value is Ruling.OVERTURNED


def _won_by(rally: Rally, team_id: TeamId) -> bool | None:
    winner = rally.winner_id.value
    return None if winner is None else winner == team_id


def _rally_outcome_for(
    rally: Rally, roster: MatchRoster, team_id: TeamId | None
) -> ExchangeOutcome | None:
    """Won or Lost for `team_id`, from the Rally's winner or else its last Shot's Error."""
    winner = rally.winner_id.value
    if winner is None and not _overturned(rally):
        last = rally.entries[-1] if rally.entries else None
        if isinstance(last, Shot) and last.error is not None:
            erring = last.error.player_id.value
            if erring is not None:
                winner = roster.other_team_id(roster.team_id_for(erring))
    if winner is None or team_id is None:
        return None
    return ExchangeOutcome.WON if winner == team_id else ExchangeOutcome.LOST


def _is_winner(rally: Rally, roster: MatchRoster, derived: DerivedShot, last: int) -> bool | None:
    if derived.entry_index != last:
        return False
    hitter_team = derived.hitter_team_id
    if hitter_team is None:
        return None
    error = derived.shot.error
    if _overturned(rally) or error is None:
        return _won_by(rally, hitter_team)
    kind = error.kind.value
    if kind in _PLAYED_ERROR_KINDS:
        return False
    # A Body Hit, or an Error of Unknown kind: whoever's Error it is lost the Rally.
    erring = error.player_id.value
    if erring is not None:
        return roster.team_id_for(erring) != hitter_team
    return _won_by(rally, hitter_team)


def _distance_to_segment(point: CourtPoint, start: CourtPoint, end: CourtPoint) -> float:
    dx, dy = end.x - start.x, end.y - start.y
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return math.hypot(point.x - start.x, point.y - start.y)
    t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length_squared
    t = min(1.0, max(0.0, t))
    return math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))


def _winner_target(rally: Rally, roster: MatchRoster, derived: DerivedShot) -> PlayerId | None:
    """The opponent nearest where a Winner crossed onto their side, or the Player it hit."""
    hitter_team = derived.hitter_team_id
    if hitter_team is None:
        return None
    shot = derived.shot
    opponents = roster.team_players(roster.other_team_id(hitter_team))
    if shot.error is not None and not _overturned(rally):
        # A Body Hit (or an Error of Unknown kind) on an opponent: that opponent is the Target.
        erring = shot.error.player_id.value
        return erring if erring in {p.id for p in opponents} else None
    landing = shot.landing.value
    if landing is None:
        return None
    first_point, second_point = (_position(shot, p.id) for p in opponents)
    if first_point is None or second_point is None:
        return None
    hitter_point = None if derived.hitter_id is None else _position(shot, derived.hitter_id)
    if hitter_point is not None and hitter_point.y * landing.y < 0:
        # Only the part of the ball's path on the opponents' side of the net counts.
        t = hitter_point.y / (hitter_point.y - landing.y)
        crossing = CourtPoint(hitter_point.x + t * (landing.x - hitter_point.x), 0.0)
    else:
        crossing = landing
    first = _distance_to_segment(first_point, crossing, landing)
    second = _distance_to_segment(second_point, crossing, landing)
    if abs(first - second) <= TARGET_TIE_TOLERANCE_FT:
        return None
    return opponents[0].id if first < second else opponents[1].id


def _target(
    rally: Rally,
    roster: MatchRoster,
    derived: DerivedShot,
    next_shot: DerivedShot | None,
    last: int,
) -> PlayerId | None:
    if derived.entry_index == last:
        if derived.is_winner is not True:
            return None
        return _winner_target(rally, roster, derived)
    if next_shot is None or next_shot.hitter_id is None:
        return None  # an Observation Gap, or an Unknown hitter, comes next
    if derived.hitter_team_id is not None and next_shot.hitter_team_id == derived.hitter_team_id:
        return None
    return next_shot.hitter_id


def _is_put_away(
    rally: Rally,
    roster: MatchRoster,
    derived: DerivedShot,
    next_shot: DerivedShot | None,
    last: int,
) -> bool | None:
    if derived.is_attack is not True:
        return derived.is_attack
    if derived.is_winner is True:
        return True
    if derived.entry_index == last:
        return False if derived.is_winner is False else None
    if next_shot is None:
        return None  # an Observation Gap comes next
    if next_shot.entry_index != last:
        return False  # the Rally went on past the reply
    hitter_team = derived.hitter_team_id
    if hitter_team is None:
        return None
    if _overturned(rally):
        return _won_by(rally, hitter_team)
    error = next_shot.shot.error
    if error is None:
        return False
    erring = error.player_id.value
    if erring is not None:
        return roster.team_id_for(erring) != hitter_team
    replier_team = next_shot.hitter_team_id
    if (
        error.kind.value in _PLAYED_ERROR_KINDS
        and replier_team is not None
        and replier_team != hitter_team
    ):
        return True
    return None


def _is_popup(derived: DerivedShot, next_shot: DerivedShot | None, last: int) -> bool | None:
    shot_class = derived.shot.shot_class.value
    if shot_class is None:
        return None
    if shot_class is not ShotClass.SOFT:
        return False
    if derived.entry_index == last:
        return False
    if next_shot is None:
        return None  # an Observation Gap comes next
    if next_shot.shot.shot_class.value is ShotClass.OVERHEAD:
        return True
    if next_shot.is_put_away is True:
        return True
    if next_shot.shot.shot_class.value is None or next_shot.is_put_away is None:
        return None
    return False


def _with_next(shots: tuple[DerivedShot, ...]) -> list[tuple[DerivedShot, DerivedShot | None]]:
    """Each Shot with the Shot right after it, or None where an Observation Gap or the Rally's end
    comes next."""
    by_entry = {s.entry_index: s for s in shots}
    return [(s, by_entry.get(s.entry_index + 1)) for s in shots]


def _judge_endings(
    rally: Rally, roster: MatchRoster, shots: tuple[DerivedShot, ...]
) -> tuple[DerivedShot, ...]:
    """Work out the facts that look ahead: Winner, then Target and Put-away, then Popup."""
    last = len(rally.entries) - 1
    shots = tuple(replace(s, is_winner=_is_winner(rally, roster, s, last)) for s in shots)
    shots = tuple(
        replace(
            s,
            target_id=_target(rally, roster, s, next_shot, last),
            is_put_away=_is_put_away(rally, roster, s, next_shot, last),
        )
        for s, next_shot in _with_next(shots)
    )
    return tuple(
        replace(s, is_popup=_is_popup(s, next_shot, last)) for s, next_shot in _with_next(shots)
    )


def _speedup_exchanges(
    rally: Rally, roster: MatchRoster, shots: tuple[DerivedShot, ...]
) -> tuple[tuple[DerivedShot, ...], tuple[SpeedupExchange, ...]]:
    exchanges: list[SpeedupExchange] = []
    exchange_of: dict[int, int] = {}
    open_until = -1
    for derived in shots:
        if derived.entry_index <= open_until or derived.shot_type is not ShotType.SPEEDUP:
            continue
        resolved = resolve_attack_exchange(
            rally, roster, shots, derived.entry_index, derived.hitter_team_id
        )
        for shot_index in resolved.shot_indices:
            exchange_of[shot_index] = len(exchanges)
        exchanges.append(
            SpeedupExchange(
                initiating_team_id=derived.hitter_team_id,
                initiating_player_id=derived.hitter_id,
                rally_phase=derived.rally_phase,
                start_entry_index=resolved.start_entry_index,
                end_entry_index=resolved.end_entry_index,
                shot_indices=resolved.shot_indices,
                outcome=resolved.outcome,
            )
        )
        open_until = resolved.end_entry_index
    shots = tuple(replace(s, speedup_exchange_index=exchange_of.get(s.shot_index)) for s in shots)
    return shots, tuple(exchanges)
