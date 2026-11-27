"""Team and Player stats derived from Matches and their rosters (issue #18)."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, replace
from enum import StrEnum
from math import sqrt
from statistics import NormalDist

from pb_tokei.rally_log.model import (
    CourtPoint,
    Error,
    ErrorKind,
    Match,
    MatchRoster,
    ObservationGap,
    Parity,
    PlayerId,
    Ruling,
    ShotClass,
    TeamId,
    Zone,
    zone_for_point,
)

from .derived import (
    OPENING_LAST_SHOT_NUMBER,
    RETURN_SHOT_NUMBER,
    SERVE_SHOT_NUMBER,
    ArrivalStatus,
    DerivedRally,
    DerivedShot,
    ExchangeOutcome,
    RallyPhase,
    ShotType,
    TeamStatus,
    derive_match,
    resolve_attack_exchange,
    resolve_rally_winner,
)
from .outcomes import OutcomeReason, ShotJudgment, ShotOutcome, judge_rally


class StatKind(StrEnum):
    COUNT = "count"
    RATE = "rate"
    PER_MATCH = "per_match"


class Stat(StrEnum):
    kind: StatKind

    def __new__(cls, value: str, kind: StatKind) -> Stat:
        member = str.__new__(cls, value)
        member._value_ = value
        member.kind = kind
        return member

    SERVES = "serves", StatKind.COUNT
    SERVE_IN = "serve_in", StatKind.RATE
    RETURNS = "returns", StatKind.COUNT
    RETURN_IN = "return_in", StatKind.RATE
    SHOT_TYPE_ATTEMPTS = "shot_type_attempts", StatKind.COUNT
    SHOT_ADVANTAGE = "shot_advantage", StatKind.RATE
    SHOT_DISADVANTAGE = "shot_disadvantage", StatKind.RATE
    OUTCOME_REASON = "outcome_reason", StatKind.COUNT
    WON_BEFORE_ARRIVAL = "won_before_arrival", StatKind.RATE
    ARRIVAL_RATE = "arrival_rate", StatKind.RATE
    LOST_BEFORE_ARRIVAL = "lost_before_arrival", StatKind.RATE
    LOST_WHEN_NEVER_ARRIVED = "lost_when_never_arrived", StatKind.RATE
    DINK_ERRORS = "dink_errors", StatKind.RATE
    DINK_POPUPS = "dink_popups", StatKind.RATE
    KITCHEN_FAULTS_PER_MATCH = "kitchen_faults_per_match", StatKind.PER_MATCH
    SPEEDUP_INITIATED = "speedup_initiated", StatKind.RATE
    SPEEDUP_RECEIVED = "speedup_received", StatKind.RATE
    DINK_ANSWERED_WITH_POPUP = "dink_answered_with_popup", StatKind.RATE
    POPUP_PUT_AWAY = "popup_put_away", StatKind.RATE
    HIT_SHARE = "hit_share", StatKind.RATE
    TARGETED_SHARE = "targeted_share", StatKind.RATE
    CROSSOVER = "crossover", StatKind.RATE
    INITIATIVE_SHARE = "initiative_share", StatKind.RATE
    SUCCESSFUL_INITIATIVE_SHARE = "successful_initiative_share", StatKind.RATE
    SPEEDUP_SUCCESS = "speedup_success", StatKind.RATE
    OPENING_END = "opening_end", StatKind.RATE
    OPENING_WIN = "opening_win", StatKind.RATE
    OPENING_END_SHOT = "opening_end_shot", StatKind.COUNT
    RETURNER_ZONE = "returner_zone", StatKind.RATE
    SERVING_TEAM_STATUS = "serving_team_status", StatKind.RATE
    BODY_HIT_WINNERS = "body_hit_winners", StatKind.COUNT
    BODY_HIT_RECEIVED = "body_hit_received", StatKind.COUNT
    CHALLENGE_SUCCESS = "challenge_success", StatKind.RATE


class SubjectKind(StrEnum):
    PLAYER = "player"
    TEAM = "team"


class CourtHalf(StrEnum):
    LEFT = "left"
    RIGHT = "right"


class RallyRole(StrEnum):
    SERVING = "serving"
    RECEIVING = "receiving"


@dataclass(frozen=True, slots=True)
class StatSubject:
    """The subject and its Team. Missing IDs collect observations we cannot attribute."""

    kind: SubjectKind
    team_id: TeamId | None
    player_id: PlayerId | None = None


@dataclass(frozen=True, slots=True)
class ShotBreakdown:
    """A Shot group. Missing facts stay in their own Unknown groups."""

    shot_number: int | None
    rally_phase: RallyPhase | None
    in_opening: bool | None
    shot_type: ShotType | None = None
    court_half: CourtHalf | None = None


type StatCategory = OutcomeReason | ExchangeOutcome | Zone | TeamStatus


@dataclass(frozen=True, slots=True)
class StatBreakdown:
    """A stat's category and optional Shot group (absent on the overall row)."""

    shot: ShotBreakdown | None = None
    shot_type: ShotType | None = None  # Shot Type table, including the overall rows
    category: StatCategory | None = None
    rally_role: RallyRole | None = None
    end_shot_number: int | None = None  # Rallies ending in the Opening


@dataclass(frozen=True, slots=True)
class StatRow:
    """One tally. Shares and 90% intervals are on the 0–1 scale.

    Dink rates can be displayed per 100 by scaling the fraction and interval. Plain counts have
    no total or interval, except that Kitchen Faults per Match carries the number of Matches.
    """

    stat: Stat
    subject: StatSubject
    breakdown: StatBreakdown
    count: int
    total: int | None
    excluded: int
    interval: tuple[float, float] | None


_OVERALL = StatBreakdown()
_Z_90 = NormalDist().inv_cdf(0.95)
_FIRST_TRANSITION_SHOT = 4
_DINK_ERRORS = frozenset({ErrorKind.NET, ErrorKind.OUT, ErrorKind.DOUBLE_HIT})
_DINK_INITIATIVE_REASONS = frozenset(
    {OutcomeReason.WINNER, OutcomeReason.REPLY_ERROR, OutcomeReason.REPLY_POPUP}
)
_OPPOSITE_EXCHANGE = {
    ExchangeOutcome.WON: ExchangeOutcome.LOST,
    ExchangeOutcome.LOST: ExchangeOutcome.WON,
    ExchangeOutcome.NEUTRAL: ExchangeOutcome.NEUTRAL,
    None: None,
}


def wilson_interval(count: int, total: int) -> tuple[float, float] | None:
    """The two-sided 90% Wilson score interval for a count out of a known total."""
    if total == 0:
        return None
    rate = count / total
    z_squared = _Z_90**2
    scale = 1 + z_squared / total
    center = (rate + z_squared / (2 * total)) / scale
    margin = _Z_90 * sqrt((rate * (1 - rate) + z_squared / (4 * total)) / total) / scale
    return (0.0 if count == 0 else center - margin, 1.0 if count == total else center + margin)


def compute_stats(matches: Iterable[tuple[Match, MatchRoster]]) -> tuple[StatRow, ...]:
    """Aggregate any number of Matches by roster IDs, keeping each Player's Teams distinct.

    Each Shot stat has an overall row and rows keyed by exact Shot Number, Rally Phase, Opening,
    Shot Type and (for Players) Court Half. Known Team results contribute to Team rows even
    when the Player is Unknown. Category counts are sparse. An Observation Gap can exclude
    specific opportunities, such as an unseen Serve or a Speedup Exchange whose result was missed.
    """
    tallies = _Tallies()
    for match, roster in matches:
        derived = derive_match(match, roster)
        for team_id in (roster.team_a_id, roster.team_b_id):
            tallies.played_match(StatSubject(SubjectKind.TEAM, team_id))
            for player in roster.team_players(team_id):
                tallies.played_match(StatSubject(SubjectKind.PLAYER, team_id, player.id))
        for game in derived.games:
            for rally in game.rallies:
                _RallyStats(rally, roster, tallies).collect()
    return tuple(tallies.rows())


@dataclass(slots=True)
class _Tally:
    count: int = 0
    total: int = 0
    excluded: int = 0

    def add(self, result: bool | None) -> None:
        if result is None:
            self.excluded += 1
        else:
            self.total += 1
            self.count += int(result)


class _Tallies:
    def __init__(self) -> None:
        self.values: defaultdict[tuple[Stat, StatSubject, StatBreakdown], _Tally] = defaultdict(
            _Tally
        )
        self.matches_played: Counter[StatSubject] = Counter()

    def played_match(self, subject: StatSubject) -> None:
        self.matches_played[subject] += 1
        self.values.setdefault((Stat.KITCHEN_FAULTS_PER_MATCH, subject, _OVERALL), _Tally())

    def add(
        self,
        stat: Stat,
        subject: StatSubject,
        result: bool | None,
        breakdown: StatBreakdown,
        shot: ShotBreakdown | None,
    ) -> None:
        self.values[(stat, subject, breakdown)].add(result)
        if shot is not None:
            self.values[(stat, subject, replace(breakdown, shot=shot))].add(result)

    def rows(self) -> Iterable[StatRow]:
        for (stat, subject, breakdown), tally in self.values.items():
            total, interval = None, None
            if stat.kind is StatKind.PER_MATCH:
                total = self.matches_played.get(subject)
            elif stat.kind is StatKind.RATE:
                total = tally.total
                interval = wilson_interval(tally.count, total)
            yield StatRow(stat, subject, breakdown, tally.count, total, tally.excluded, interval)


def _position(shot: DerivedShot, player_id: PlayerId) -> CourtPoint | None:
    position = shot.shot.positions.get(player_id)
    return None if position is None else position.position.value


def _court_halves(rally: DerivedRally, roster: MatchRoster) -> dict[PlayerId, CourtHalf]:
    halves = {}
    for team_id, arrival in rally.arrivals.items():
        if arrival.shot_index is None:
            continue
        first, second = roster.team_players(team_id)
        shot = rally.shots[arrival.shot_index]
        p1, p2 = _position(shot, first.id), _position(shot, second.id)
        if p1 is None or p2 is None or p1.x == p2.x or p1.y * p2.y < 0 or p1.y + p2.y == 0:
            continue
        # The far Team faces the camera, so the larger world x is on its left.
        first_left = (p1.x < p2.x) == (p1.y + p2.y < 0)
        halves[first.id] = CourtHalf.LEFT if first_left else CourtHalf.RIGHT
        halves[second.id] = CourtHalf.RIGHT if first_left else CourtHalf.LEFT
    return halves


def _rally_length(derived: DerivedRally) -> tuple[int | None, int]:
    """Exact length and lower bound, including any trailing Observation Gaps."""
    last = derived.shots[-1] if derived.shots else None
    first_unseen = 0 if last is None else last.entry_index + 1
    trailing_gaps = derived.rally.entries[first_unseen:]
    minimum = 0 if last is None else last.min_shot_number
    if last is not None and not trailing_gaps:
        return last.shot_number, minimum
    for entry in trailing_gaps:
        if isinstance(entry, ObservationGap):
            minimum += 1 if entry.missing is Parity.ODD else 2
    return None, minimum


def _shot_breakdown(shot: DerivedShot) -> ShotBreakdown:
    return ShotBreakdown(shot.shot_number, shot.rally_phase, shot.in_opening, shot.shot_type)


class _RallyStats:
    def __init__(self, derived: DerivedRally, roster: MatchRoster, tallies: _Tallies) -> None:
        self.derived = derived
        self.rally = derived.rally
        self.roster = roster
        self.tallies = tallies
        self.by_entry = {shot.entry_index: shot for shot in derived.shots}
        self.by_number = {s.shot_number: s for s in derived.shots if s.shot_number is not None}
        self.length, self.min_length = _rally_length(derived)
        self.halves = _court_halves(derived, roster)
        self.server = self._opening_hitter(SERVE_SHOT_NUMBER, self.rally.server_id.value)
        self.returner = self._opening_hitter(RETURN_SHOT_NUMBER, self.rally.returner_id.value)
        self.serving_team = self.rally.serving_team_id.value
        if self.serving_team is None and self.server is not None:
            self.serving_team = roster.team_id_for(self.server)
        if self.serving_team is None and self.returner is not None:
            self.serving_team = roster.other_team_id(roster.team_id_for(self.returner))
        self.receiving_team = self._opponent(self.serving_team)
        self.winner = resolve_rally_winner(self.rally, roster)
        challenge = self.rally.challenge
        self.overturned = challenge is not None and challenge.ruling.value is Ruling.OVERTURNED

    def _opening_hitter(self, number: int, recorded: PlayerId | None) -> PlayerId | None:
        shot = self.by_number.get(number)
        return (None if shot is None else shot.hitter_id) or recorded

    def _hitter(self, shot: DerivedShot) -> PlayerId | None:
        if shot.shot_number == SERVE_SHOT_NUMBER:
            return self.server
        if shot.shot_number == RETURN_SHOT_NUMBER:
            return self.returner
        return shot.hitter_id

    def _opponent(self, team_id: TeamId | None) -> TeamId | None:
        return None if team_id is None else self.roster.other_team_id(team_id)

    def _hitter_team(self, shot: DerivedShot) -> TeamId | None:
        if shot.hitter_team_id is not None:
            return shot.hitter_team_id
        hitter = self._hitter(shot)
        if hitter is not None:
            return self.roster.team_id_for(hitter)
        if shot.shot_number is None:
            return None
        return self.serving_team if shot.shot_number % 2 else self.receiving_team

    def _is_last(self, shot: DerivedShot) -> bool:
        return shot.entry_index == len(self.rally.entries) - 1

    def _team(
        self,
        stat: Stat,
        team_id: TeamId | None,
        result: bool | None,
        shot: ShotBreakdown | None = None,
        breakdown: StatBreakdown = _OVERALL,
    ) -> None:
        subject = StatSubject(SubjectKind.TEAM, team_id)
        self.tallies.add(stat, subject, None if team_id is None else result, breakdown, shot)

    def _player(
        self,
        stat: Stat,
        player_id: PlayerId | None,
        result: bool | None,
        shot: ShotBreakdown | None = None,
        breakdown: StatBreakdown = _OVERALL,
        *,
        team_id: TeamId | None = None,
        team_row: bool = True,
    ) -> None:
        if player_id is not None:
            team_id = self.roster.team_id_for(player_id)
        if team_row:
            self._team(stat, team_id, result, shot, breakdown)
        subject = StatSubject(SubjectKind.PLAYER, team_id, player_id)
        player_shot = None if shot is None else replace(shot, court_half=self.halves.get(player_id))
        player_result = None if player_id is None else result
        self.tallies.add(stat, subject, player_result, breakdown, player_shot)

    def _share(
        self,
        stat: Stat,
        team_id: TeamId | None,
        player_id: PlayerId | None,
        known: bool,
        shot: ShotBreakdown,
    ) -> None:
        if team_id is None:
            self._player(stat, None, None, shot, team_row=False)
            return
        for player in self.roster.team_players(team_id):
            result = player.id == player_id if known and player_id is not None else None
            self._player(stat, player.id, result, shot, team_row=False)

    def collect(self) -> None:
        self._serve_return()
        self._arrival()
        self._opening()
        self._challenge()
        self._speedup_exchanges()
        for judgment in judge_rally(self.derived, self.roster):
            self._shot(judgment)

    def _serve_return(self) -> None:
        leading_gap = bool(self.rally.entries) and isinstance(self.rally.entries[0], ObservationGap)
        for number, player, team, attempts, in_rate, phase, shot_type in (
            (
                SERVE_SHOT_NUMBER,
                self.server,
                self.serving_team,
                Stat.SERVES,
                Stat.SERVE_IN,
                RallyPhase.SERVE,
                ShotType.SERVE,
            ),
            (
                RETURN_SHOT_NUMBER,
                self.returner,
                self.receiving_team,
                Stat.RETURNS,
                Stat.RETURN_IN,
                RallyPhase.RETURN,
                ShotType.RETURN,
            ),
        ):
            if self.length is not None and self.length < number:
                continue
            shot = None if leading_gap else self.by_number.get(number)
            if shot is None:
                key = ShotBreakdown(number, phase, True, shot_type)
                self._player(attempts, player, None, key, team_id=team)
                self._player(in_rate, player, None, key, team_id=team)
                continue
            key = _shot_breakdown(shot)
            self._player(attempts, player, True, key, team_id=team)
            own_error = self._own_error(shot, player)
            result = None if own_error is None else not own_error
            self._player(in_rate, player, result, key, team_id=team)

    def _effective_error(self, shot: DerivedShot) -> Error | None:
        return shot.shot.error if self._is_last(shot) and not self.overturned else None

    def _own_error(self, shot: DerivedShot, player: PlayerId | None) -> bool | None:
        team = self._hitter_team(shot)
        if self._is_last(shot) and self.overturned:
            if team is not None and self.winner is not None:
                return team != self.winner
            error = shot.shot.error
            if error is not None and error.kind.value is ErrorKind.OUT:
                return False
            return None
        error = self._effective_error(shot)
        if error is None:
            return False
        erring = error.player_id.value
        if erring is not None:
            if player is not None:
                return erring == player
            if team is not None and self.roster.team_id_for(erring) != team:
                return False
        # Net, Out and Double Hit belong to the hitter. A recorded Kitchen Fault
        # without an Error Player also defaults to the hitter.
        if error.kind.value in _DINK_ERRORS:
            return True
        return True if error.kind.value is ErrorKind.KITCHEN_FAULT and erring is None else None

    def _arrival(self) -> None:
        if self.length is not None and self.length < _FIRST_TRANSITION_SHOT:
            return
        serving = self.serving_team
        arrived: bool | None = None
        if serving is not None and self.min_length >= _FIRST_TRANSITION_SHOT:
            status = self.derived.arrivals[serving].status
            if status is not ArrivalStatus.UNKNOWN:
                arrived = status in (ArrivalStatus.ARRIVED, ArrivalStatus.ARRIVED_BY)
        lost: bool | None = None
        if arrived is True:
            lost = False
        elif arrived is False and self.winner is not None:
            lost = self.winner != serving
        self._team(Stat.ARRIVAL_RATE, serving, arrived)
        self._team(Stat.LOST_BEFORE_ARRIVAL, serving, lost)
        self._team(Stat.WON_BEFORE_ARRIVAL, self.receiving_team, lost)
        if arrived is not True:
            self._team(Stat.LOST_WHEN_NEVER_ARRIVED, serving, lost)

    def _opening(self) -> None:
        ended: bool | None = None
        if self.length is not None:
            ended = self.length <= OPENING_LAST_SHOT_NUMBER
        elif self.min_length > OPENING_LAST_SHOT_NUMBER:
            ended = False
        for team in (self.roster.team_a_id, self.roster.team_b_id):
            role = None
            if self.serving_team is not None:
                role = RallyRole.SERVING if team == self.serving_team else RallyRole.RECEIVING
            result = ended if role is not None else None
            group = StatBreakdown(rally_role=role)
            self._team(Stat.OPENING_END, team, result, breakdown=group)
            if result is not False:
                won = self.winner == team if result is True and self.winner is not None else None
                self._team(Stat.OPENING_WIN, team, won, breakdown=group)
                self._team(
                    Stat.OPENING_END_SHOT,
                    team,
                    result,
                    breakdown=replace(group, end_shot_number=self.length if result else None),
                )

        for number in (3, OPENING_LAST_SHOT_NUMBER):
            if self.length is not None and self.length < number:
                continue
            shot = self.by_number.get(number)
            key = ShotBreakdown(number, None, True) if shot is None else _shot_breakdown(shot)
            point = (
                None if shot is None or self.returner is None else _position(shot, self.returner)
            )
            zone = None if point is None else zone_for_point(point)
            status = None if shot is None else shot.team_status.get(self.serving_team)
            for candidate in Zone:
                self._player(
                    Stat.RETURNER_ZONE,
                    self.returner,
                    _is_category(zone, candidate),
                    key,
                    StatBreakdown(category=candidate),
                    team_id=self.receiving_team,
                    team_row=False,
                )
            for candidate in TeamStatus:
                self._team(
                    Stat.SERVING_TEAM_STATUS,
                    self.serving_team,
                    _is_category(status, candidate),
                    key,
                    StatBreakdown(category=candidate),
                )

    def _challenge(self) -> None:
        challenge = self.rally.challenge
        if challenge is not None:
            self._player(
                Stat.CHALLENGE_SUCCESS,
                challenge.challenger_id.value,
                _is_category(challenge.ruling.value, Ruling.OVERTURNED),
            )

    def _exchange_record(
        self,
        stat: Stat,
        outcome: ExchangeOutcome | None,
        player_id: PlayerId | None,
        team_id: TeamId | None,
        key: ShotBreakdown,
    ) -> None:
        for category in ExchangeOutcome:
            self._player(
                stat,
                player_id,
                _is_category(outcome, category),
                key,
                StatBreakdown(category=category),
                team_id=team_id,
            )

    def _speedup_exchanges(self) -> None:
        for exchange in self.derived.speedup_exchanges:
            shot = self.by_entry[exchange.start_entry_index]
            key = _shot_breakdown(shot)
            team = self._hitter_team(shot)
            outcome = self._speedup_outcome(shot, team)
            self._exchange_record(Stat.SPEEDUP_INITIATED, outcome, shot.hitter_id, team, key)
            if not self._without_target(shot):
                self._exchange_record(
                    Stat.SPEEDUP_RECEIVED,
                    _OPPOSITE_EXCHANGE[outcome],
                    shot.target_id,
                    self._opponent(team),
                    key,
                )

    def _shot(self, judgment: ShotJudgment) -> None:
        shot = judgment.shot
        key = _shot_breakdown(shot)
        player = self._hitter(shot)
        team = self._hitter_team(shot)
        previous = self.by_entry.get(shot.entry_index - 1)
        reply = self.by_entry.get(shot.entry_index + 1)
        group = StatBreakdown(shot_type=shot.shot_type)
        self._player(
            Stat.SHOT_TYPE_ATTEMPTS,
            player,
            None if shot.shot_type is None else True,
            key,
            group,
            team_id=team,
        )
        outcome = judgment.outcome if shot.shot_type is not None else None
        for stat, category in (
            (Stat.SHOT_ADVANTAGE, ShotOutcome.ADVANTAGE),
            (Stat.SHOT_DISADVANTAGE, ShotOutcome.DISADVANTAGE),
        ):
            self._player(stat, player, _is_category(outcome, category), key, group, team_id=team)
        reason = judgment.reason if outcome is not None else None
        self._player(
            Stat.OUTCOME_REASON,
            player,
            None if reason is None else True,
            key,
            replace(group, category=reason),
            team_id=team,
        )
        self._ball_share(shot, previous, key, team)
        self._dinks_and_popups(shot, previous, reply, key, team)
        self._initiative(judgment, reply, key, team)
        error = self._effective_error(shot)
        if error is not None:
            self._faults_and_body_hits(shot, key, team, error)

    def _without_target(self, shot: DerivedShot) -> bool:
        return self._is_last(shot) and shot.is_winner is False

    def _ball_share(
        self,
        shot: DerivedShot,
        previous: DerivedShot | None,
        key: ShotBreakdown,
        team: TeamId | None,
    ) -> None:
        if shot.shot_number not in (SERVE_SHOT_NUMBER, RETURN_SHOT_NUMBER):
            from_third = shot.min_shot_number > RETURN_SHOT_NUMBER
            self._share(Stat.HIT_SHARE, team, shot.hitter_id, from_third, key)
            crossover = self._crossover(shot, previous, team) if from_third else None
            self._player(
                Stat.CROSSOVER, shot.hitter_id, crossover, key, team_id=team, team_row=False
            )
        if shot.shot_number != SERVE_SHOT_NUMBER and not self._without_target(shot):
            target = shot.target_id
            target_team = (
                self._opponent(team) if target is None else self.roster.team_id_for(target)
            )
            self._share(Stat.TARGETED_SHARE, target_team, target, True, key)

    def _crossover(
        self, shot: DerivedShot, previous: DerivedShot | None, team: TeamId | None
    ) -> bool | None:
        hitter = shot.hitter_id
        if (
            hitter is None
            or team is None
            or previous is None
            or self._hitter_team(previous) != self._opponent(team)
        ):
            return None
        first, second = self.roster.team_players(team)
        before = _position(previous, hitter)
        partner = _position(previous, second.id if first.id == hitter else first.id)
        now = _position(shot, hitter)
        if before is None or partner is None or now is None or before.x == partner.x:
            return None
        midpoint = (before.x + partner.x) / 2
        return (before.x - midpoint) * (now.x - midpoint) < 0

    def _dinks_and_popups(
        self,
        shot: DerivedShot,
        previous: DerivedShot | None,
        reply: DerivedShot | None,
        key: ShotBreakdown,
        team: TeamId | None,
    ) -> None:
        player = shot.hitter_id
        if _could_be_dink_or_speedup(shot, ShotType.DINK, ShotClass.SOFT):
            dink = shot.shot_type is ShotType.DINK
            incoming = None if previous is None else previous.shot.shot_class.value
            if incoming in (ShotClass.SOFT, None):
                dink_error: bool | None = None
                if dink and incoming is ShotClass.SOFT:
                    own_error = self._own_error(shot, player)
                    error = self._effective_error(shot)
                    if own_error is False:
                        dink_error = False
                    elif error is not None and error.kind.value is not None:
                        kind = error.kind.value
                        dink_error = own_error if kind in _DINK_ERRORS else False
                popup = shot.is_popup if dink and incoming is ShotClass.SOFT else None
                if dink_error is None or popup is None:
                    # Keep the two rates on the same cohort of Dinks.
                    dink_error = popup = None
                self._player(Stat.DINK_ERRORS, player, dink_error, key, team_id=team)
                self._player(Stat.DINK_POPUPS, player, popup, key, team_id=team)
            answer = None
            if dink:
                if self._is_last(shot):
                    answer = False
                elif reply is not None and (team is None or self._hitter_team(reply) != team):
                    answer = reply.is_popup
            self._player(Stat.DINK_ANSWERED_WITH_POPUP, player, answer, key, team_id=team)

        incoming_popup = None if previous is None else previous.is_popup
        if incoming_popup is False or (previous is None and shot.entry_index == 0):
            return
        if previous is not None and team is not None and self._hitter_team(previous) == team:
            return
        if (
            incoming_popup is None
            and shot.is_put_away is False
            and shot.shot.shot_class.value not in (ShotClass.OVERHEAD, None)
        ):
            return  # This reply cannot make the previous Shot a Popup.
        put_away = shot.is_put_away if incoming_popup is True else None
        self._player(Stat.POPUP_PUT_AWAY, self._hitter(shot), put_away, key, team_id=team)

    def _initiative(
        self,
        judgment: ShotJudgment,
        reply: DerivedShot | None,
        key: ShotBreakdown,
        team: TeamId | None,
    ) -> None:
        shot = judgment.shot
        player = shot.hitter_id
        if shot.shot_type is ShotType.DINK:
            attempted = successful = _dink_initiative(judgment.reason, reply)
        elif _could_be_dink_or_speedup(shot, ShotType.SPEEDUP, ShotClass.HARD):
            attempted = True if shot.shot_type is ShotType.SPEEDUP else None
            outcome = self._speedup_outcome(shot, team) if attempted else None
            self._exchange_record(Stat.SPEEDUP_SUCCESS, outcome, player, team, key)
            successful = _is_category(outcome, ExchangeOutcome.WON)
        elif _could_be_dink_or_speedup(shot, ShotType.DINK, ShotClass.SOFT):
            attempted = successful = None
        else:
            return
        if attempted is not False:
            self._share(Stat.INITIATIVE_SHARE, team, player, attempted is True, key)
        if successful is not False:
            self._share(Stat.SUCCESSFUL_INITIATIVE_SHARE, team, player, successful is True, key)

    def _speedup_outcome(self, shot: DerivedShot, team: TeamId | None) -> ExchangeOutcome | None:
        if shot.speedup_exchange_index is None:
            return None
        exchange = self.derived.speedup_exchanges[shot.speedup_exchange_index]
        if exchange.outcome is ExchangeOutcome.NEUTRAL or team is None:
            return exchange.outcome
        if exchange.initiating_team_id is None:
            # The Shot Number can identify the Team even when the initiating Player is Unknown.
            return resolve_attack_exchange(
                self.rally, self.roster, self.derived.shots, shot.entry_index, team
            ).outcome
        if exchange.initiating_team_id == team:
            return exchange.outcome
        return _OPPOSITE_EXCHANGE[exchange.outcome]

    def _faults_and_body_hits(
        self, shot: DerivedShot, key: ShotBreakdown, team: TeamId | None, error: Error
    ) -> None:
        kind = error.kind.value
        erring = error.player_id.value
        if kind in (ErrorKind.KITCHEN_FAULT, None):
            fault_player = erring
            if fault_player is None and kind is ErrorKind.KITCHEN_FAULT:
                fault_player = self._hitter(shot)
            self._player(
                Stat.KITCHEN_FAULTS_PER_MATCH,
                fault_player,
                _is_category(kind, ErrorKind.KITCHEN_FAULT),
                key,
                team_id=team,
            )
        if kind in (ErrorKind.BODY_HIT, None):
            won = shot.is_winner
            if won is None and team is not None and erring is not None:
                won = self.roster.team_id_for(erring) != team
            if won is not False:
                result = won if kind is ErrorKind.BODY_HIT else None
                self._player(Stat.BODY_HIT_WINNERS, self._hitter(shot), result, key, team_id=team)
                self._player(
                    Stat.BODY_HIT_RECEIVED, erring, result, key, team_id=self._opponent(team)
                )


def _is_category[T](value: T | None, category: T) -> bool | None:
    return None if value is None else value == category


def _dink_initiative(reason: OutcomeReason | None, reply: DerivedShot | None) -> bool | None:
    if reason is None:
        return None
    if (
        reason is OutcomeReason.REPLY_ERROR
        and reply is not None
        and _could_be_dink_or_speedup(reply, ShotType.SPEEDUP, ShotClass.HARD)
    ):
        # An immediate Speedup Error is judged as REPLY_ERROR too.
        return False if reply.shot_type is ShotType.SPEEDUP else None
    return reason in _DINK_INITIATIVE_REASONS


def _could_be_dink_or_speedup(
    shot: DerivedShot, shot_type: ShotType, shot_class: ShotClass
) -> bool:
    if shot.shot_type is not None:
        return shot.shot_type is shot_type
    return (
        shot.shot.shot_class.value in (shot_class, None)
        and shot.contact_zone in (Zone.FRONTCOURT, None)
        and shot.incoming_is_attack is not True
    )
