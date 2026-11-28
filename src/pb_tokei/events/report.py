"""Shape Team and Player tallies for the Match and dashboard reports."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel

from pb_tokei.rally_log import Game, Match, MatchRoster, Player, RallyStatus, TeamId, Zone

from .derived import (
    OPENING_LAST_SHOT_NUMBER,
    ExchangeOutcome,
    RallyPhase,
    ShotType,
    TeamStatus,
    resolve_rally_winner,
    resolve_serving_team,
)
from .outcomes import OutcomeReason, ShotOutcome
from .stats import (
    CourtHalf,
    RallyRole,
    ShotBreakdown,
    Stat,
    StatBreakdown,
    StatKind,
    StatRow,
    SubjectKind,
    compute_stats,
    wilson_interval,
)


class ReportGroup(StrEnum):
    SERVE_RETURN = "Serve & Return"
    OPENING = "Third Shot / Opening"
    ARRIVAL = "Arrival"
    DINKS = "Dinks"
    SPEEDUPS = "Speedups"
    SHARES = "Shares & Initiative"
    OTHER = "Other"


class ReportSplit(StrEnum):
    RALLY_PHASE = "rally_phase"
    SHOT_NUMBER = "shot_number"
    OPENING = "opening"
    COURT_HALF = "court_half"


class ReportDimension(StrEnum):
    SHOT_TYPE = "shot_type"
    RALLY_ROLE = "rally_role"
    END_SHOT_NUMBER = "end_shot_number"
    SHOT_NUMBER = "shot_number"


class ReportKind(StrEnum):
    RATE = "rate"
    PER100 = "per100"
    COUNT = "count"
    PER_MATCH = "per_match"
    MIX = "mix"


class ReportSubject(StrEnum):
    TEAM = "team"
    PLAYER = "player"
    BOTH = "both"


class ReportCount(BaseModel):
    count: int
    left_out: int


class ReportRate(ReportCount):
    of: int
    estimate: float | None
    low: float | None
    high: float | None


class ReportPerMatch(ReportCount):
    matches: int
    average: float


class ReportCategory(BaseModel):
    id: str
    label: str
    count: int
    estimate: float | None = None
    low: float | None = None
    high: float | None = None


class ReportMix(BaseModel):
    categories: list[ReportCategory]
    of: int
    left_out: int


type ReportValue = ReportRate | ReportPerMatch | ReportCount | ReportMix
type ReportValues = dict[UUID, ReportValue]
type ReportBreakdowns = dict[ReportSplit, dict[str, ReportValues]]


class ReportRow(BaseModel):
    values: ReportValues
    breakdowns: ReportBreakdowns


class ReportSubRow(ReportRow):
    id: str
    label: str


class ReportStat(ReportRow):
    id: str
    label: str
    group: ReportGroup
    kind: ReportKind
    applies_to: ReportSubject
    splits_by: tuple[ReportSplit, ...]
    sub_rows: ReportDimension | None
    rows: list[ReportSubRow]


class ReportPlayer(BaseModel):
    id: UUID
    name: str

    @staticmethod
    def from_player(player: Player) -> ReportPlayer:
        return ReportPlayer(id=player.id, name=player.name)


class ReportTeam(BaseModel):
    id: UUID
    players: tuple[ReportPlayer, ReportPlayer]

    @staticmethod
    def from_players(team_id: TeamId, players: tuple[Player, Player]) -> ReportTeam:
        first, second = sorted(players, key=lambda player: (player.name, player.id))
        return ReportTeam(
            id=team_id, players=(ReportPlayer.from_player(first), ReportPlayer.from_player(second))
        )


class ReportGame(BaseModel):
    number: int
    score: tuple[int, int] | None


class ReportRallies(BaseModel):
    counted: int
    done: int
    in_progress: int
    empty: int


class _ReportHeader(BaseModel):
    rallies: ReportRallies
    uncredited: int


class ReportHeader(_ReportHeader):
    tournament: str
    teams: tuple[ReportTeam, ReportTeam]
    games: list[ReportGame]


class MatchReport(BaseModel):
    header: ReportHeader
    stats: list[ReportStat]


class MultiMatchHeader(_ReportHeader):
    match_count: int


class MultiMatchReport(BaseModel):
    header: MultiMatchHeader
    stats: list[ReportStat]


_SHOT_SPLITS = tuple(ReportSplit)
_TEAM_SHOT_SPLITS = tuple(split for split in ReportSplit if split is not ReportSplit.COURT_HALF)
_SHOT_OUTCOMES = (ShotOutcome.ADVANTAGE, ShotOutcome.NEUTRAL, ShotOutcome.DISADVANTAGE)


@dataclass(frozen=True, slots=True)
class _StatDefinition:
    label: str
    group: ReportGroup
    applies_to: ReportSubject = ReportSubject.BOTH
    splits_by: tuple[ReportSplit, ...] = _SHOT_SPLITS
    sub_rows: ReportDimension | None = None
    categories: tuple[StrEnum, ...] = ()
    per100: bool = False

    def kind(self, stat: Stat) -> ReportKind:
        if self.categories:
            return ReportKind.MIX
        if self.per100:
            return ReportKind.PER100
        return ReportKind.RATE if stat.kind is StatKind.RATE else ReportKind.COUNT


# The insertion order is the order of groups and stats in the report.
STAT_DEFINITIONS = {
    Stat.SERVES: _StatDefinition("Serves", ReportGroup.SERVE_RETURN),
    Stat.SERVE_IN: _StatDefinition("Serves in", ReportGroup.SERVE_RETURN),
    Stat.RETURNS: _StatDefinition("Returns", ReportGroup.SERVE_RETURN),
    Stat.RETURN_IN: _StatDefinition("Returns in", ReportGroup.SERVE_RETURN),
    Stat.OPENING_END: _StatDefinition(
        "Opening end rate", ReportGroup.OPENING, ReportSubject.TEAM, (), ReportDimension.RALLY_ROLE
    ),
    Stat.OPENING_WIN: _StatDefinition(
        "Opening win rate", ReportGroup.OPENING, ReportSubject.TEAM, (), ReportDimension.RALLY_ROLE
    ),
    Stat.OPENING_END_SHOT: _StatDefinition(
        "Rallies ending in the Opening",
        ReportGroup.OPENING,
        ReportSubject.TEAM,
        (),
        ReportDimension.END_SHOT_NUMBER,
    ),
    Stat.RETURNER_ZONE: _StatDefinition(
        "Returner Zone",
        ReportGroup.OPENING,
        ReportSubject.PLAYER,
        (ReportSplit.RALLY_PHASE, ReportSplit.COURT_HALF),
        ReportDimension.SHOT_NUMBER,
        tuple(Zone),
    ),
    Stat.SERVING_TEAM_STATUS: _StatDefinition(
        "Serving Team Status",
        ReportGroup.OPENING,
        ReportSubject.TEAM,
        (ReportSplit.RALLY_PHASE,),
        ReportDimension.SHOT_NUMBER,
        tuple(TeamStatus),
    ),
    Stat.WON_BEFORE_ARRIVAL: _StatDefinition(
        "Won Before Arrival", ReportGroup.ARRIVAL, ReportSubject.TEAM, ()
    ),
    Stat.ARRIVAL_RATE: _StatDefinition("Arrival Rate", ReportGroup.ARRIVAL, ReportSubject.TEAM, ()),
    Stat.LOST_BEFORE_ARRIVAL: _StatDefinition(
        "Lost Before Arrival", ReportGroup.ARRIVAL, ReportSubject.TEAM, ()
    ),
    Stat.LOST_WHEN_NEVER_ARRIVED: _StatDefinition(
        "Lost when never arrived", ReportGroup.ARRIVAL, ReportSubject.TEAM, ()
    ),
    Stat.DINK_ERRORS: _StatDefinition("Dink Errors", ReportGroup.DINKS, per100=True),
    Stat.DINK_POPUPS: _StatDefinition("Dink Popups", ReportGroup.DINKS, per100=True),
    Stat.DINK_ANSWERED_WITH_POPUP: _StatDefinition(
        "Dinks answered with a Popup", ReportGroup.DINKS
    ),
    Stat.POPUP_PUT_AWAY: _StatDefinition("Popups put away", ReportGroup.DINKS),
    Stat.SPEEDUP_INITIATED: _StatDefinition(
        "Speedup Exchanges initiated", ReportGroup.SPEEDUPS, categories=tuple(ExchangeOutcome)
    ),
    Stat.SPEEDUP_RECEIVED: _StatDefinition(
        "Speedup Exchanges received", ReportGroup.SPEEDUPS, categories=tuple(ExchangeOutcome)
    ),
    Stat.SPEEDUP_SUCCESS: _StatDefinition(
        "Speedup success", ReportGroup.SPEEDUPS, categories=tuple(ExchangeOutcome)
    ),
    Stat.HIT_SHARE: _StatDefinition("Hit Share", ReportGroup.SHARES, ReportSubject.PLAYER),
    Stat.TARGETED_SHARE: _StatDefinition(
        "Targeted Share", ReportGroup.SHARES, ReportSubject.PLAYER
    ),
    Stat.CROSSOVER: _StatDefinition("Crossovers", ReportGroup.SHARES, ReportSubject.PLAYER),
    Stat.INITIATIVE_SHARE: _StatDefinition(
        "Initiative Share", ReportGroup.SHARES, ReportSubject.PLAYER
    ),
    Stat.SUCCESSFUL_INITIATIVE_SHARE: _StatDefinition(
        "Successful Initiative Share", ReportGroup.SHARES, ReportSubject.PLAYER
    ),
    Stat.SHOT_TYPE_ATTEMPTS: _StatDefinition(
        "Shot Type attempts", ReportGroup.OTHER, sub_rows=ReportDimension.SHOT_TYPE
    ),
    Stat.SHOT_ADVANTAGE: _StatDefinition(
        "Shot Advantage",
        ReportGroup.OTHER,
        sub_rows=ReportDimension.SHOT_TYPE,
        categories=_SHOT_OUTCOMES,
    ),
    Stat.SHOT_DISADVANTAGE: _StatDefinition(
        "Shot Disadvantage", ReportGroup.OTHER, sub_rows=ReportDimension.SHOT_TYPE
    ),
    Stat.OUTCOME_REASON: _StatDefinition(
        "Why",
        ReportGroup.OTHER,
        sub_rows=ReportDimension.SHOT_TYPE,
        categories=tuple(OutcomeReason),
    ),
    Stat.KITCHEN_FAULTS_PER_MATCH: _StatDefinition("Kitchen Faults", ReportGroup.OTHER),
    Stat.BODY_HIT_WINNERS: _StatDefinition("Body Hit Winners", ReportGroup.OTHER),
    Stat.BODY_HIT_RECEIVED: _StatDefinition("Body Hits received", ReportGroup.OTHER),
    Stat.CHALLENGE_SUCCESS: _StatDefinition("Challenge success", ReportGroup.OTHER, splits_by=()),
}

_UNKNOWN = "Unknown"
_IN_OPENING = "In the Opening (Shots 1–5)"
_AFTER_OPENING = "After the Opening (6+)"
_SHOTS_6_TO_10 = "6–10"
_SHOTS_11_PLUS = "11+"
_PHASE_LABELS = {phase: phase.value.replace("_", " ").title() for phase in RallyPhase}
_COURT_HALF_LABELS = {half: half.value.capitalize() for half in CourtHalf}
_CATEGORY_LABELS = {
    "follow_up_popup": "Follow-up Popup",
    "established_at_follow_up": "Established at follow-up",
}
_SHOT_LABELS = tuple(str(n) for n in range(1, OPENING_LAST_SHOT_NUMBER + 1))
_SPLIT_BUCKETS = {
    ReportSplit.RALLY_PHASE: tuple(_PHASE_LABELS.values()),
    ReportSplit.SHOT_NUMBER: (*_SHOT_LABELS, _SHOTS_6_TO_10, _SHOTS_11_PLUS),
    ReportSplit.OPENING: (_IN_OPENING, _AFTER_OPENING),
    ReportSplit.COURT_HALF: tuple(_COURT_HALF_LABELS.values()),
}
_FIXED_BUCKETS = {
    ReportDimension.SHOT_TYPE: tuple(shot.value for shot in ShotType),
    ReportDimension.RALLY_ROLE: tuple(role.value for role in RallyRole),
    ReportDimension.END_SHOT_NUMBER: _SHOT_LABELS,
    ReportDimension.SHOT_NUMBER: ("3", str(OPENING_LAST_SHOT_NUMBER)),
}


def _label(value: str) -> str:
    return _CATEGORY_LABELS.get(value, value.replace("_", " ").capitalize())


def _bucket(shot: ShotBreakdown, split: ReportSplit) -> str:
    match split:
        case ReportSplit.RALLY_PHASE:
            return _UNKNOWN if shot.rally_phase is None else _PHASE_LABELS[shot.rally_phase]
        case ReportSplit.SHOT_NUMBER:
            number = shot.shot_number
            if number is None:
                return _UNKNOWN
            if number <= OPENING_LAST_SHOT_NUMBER:
                return str(number)
            return _SHOTS_6_TO_10 if number <= 10 else _SHOTS_11_PLUS
        case ReportSplit.OPENING:
            if shot.in_opening is None:
                return _UNKNOWN
            return _IN_OPENING if shot.in_opening else _AFTER_OPENING
        case ReportSplit.COURT_HALF:
            return _UNKNOWN if shot.court_half is None else _COURT_HALF_LABELS[shot.court_half]


def _fixed_bucket(breakdown: StatBreakdown, dimension: ReportDimension | None) -> str | None:
    match dimension:
        case ReportDimension.SHOT_TYPE:
            return breakdown.shot_type or _UNKNOWN
        case ReportDimension.RALLY_ROLE:
            return breakdown.rally_role or _UNKNOWN
        case ReportDimension.END_SHOT_NUMBER:
            return _UNKNOWN if breakdown.end_shot_number is None else str(breakdown.end_shot_number)
        case ReportDimension.SHOT_NUMBER:
            if breakdown.shot is not None and breakdown.shot.shot_number is not None:
                return str(breakdown.shot.shot_number)
    return None


@dataclass(frozen=True, slots=True)
class _Tally:
    count: int
    total: int
    excluded: int
    interval: tuple[float, float] | None

    @classmethod
    def from_rows(cls, rows: list[StatRow], *, pooled: bool) -> _Tally:
        count = sum(row.count for row in rows)
        total = sum(row.total or 0 for row in rows) if rows[0].stat.kind is StatKind.RATE else 0
        excluded = sum(row.excluded for row in rows)
        interval = wilson_interval(count, total) if pooled or len(rows) > 1 else rows[0].interval
        return cls(count, total, excluded, interval)

    def rate(self, scale: int = 1) -> ReportRate:
        low, high = (None, None) if self.interval is None else self.interval
        return ReportRate(
            count=self.count,
            of=self.total,
            estimate=self.count / self.total * scale if self.total else None,
            low=None if low is None else low * scale,
            high=None if high is None else high * scale,
            left_out=self.excluded,
        )


def _rate_mix(
    stat: Stat, definition: _StatDefinition, tallies: dict[StrEnum | None, _Tally]
) -> ReportMix:
    cohort = next(iter(tallies.values()))
    if stat is Stat.SHOT_ADVANTAGE:
        # Advantage and Disadvantage are disjoint outcomes on the same known cohort.
        neutral = cohort.total - sum(tally.count for tally in tallies.values())
        tallies[ShotOutcome.NEUTRAL] = replace(
            cohort, count=neutral, interval=wilson_interval(neutral, cohort.total)
        )
    categories = []
    for category in definition.categories:
        tally = tallies.get(category)
        if tally is None:
            tally = replace(cohort, count=0, interval=wilson_interval(0, cohort.total))
        rate = tally.rate()
        categories.append(
            ReportCategory(
                id=category,
                label=_label(category),
                count=rate.count,
                estimate=rate.estimate,
                low=rate.low,
                high=rate.high,
            )
        )
    return ReportMix(categories=categories, of=cohort.total, left_out=cohort.excluded)


def _value(
    stat: Stat,
    definition: _StatDefinition,
    parts: dict[StrEnum | None, list[StatRow]],
    *,
    pooled: bool,
) -> ReportValue:
    tallies = {category: _Tally.from_rows(rows, pooled=pooled) for category, rows in parts.items()}
    if stat is Stat.OUTCOME_REASON:
        return ReportMix(
            categories=[
                ReportCategory(id=category, label=_label(category), count=tallies[category].count)
                for category in definition.categories
                if category in tallies
            ],
            of=sum(tally.count for tally in tallies.values()),
            left_out=sum(tally.excluded for tally in tallies.values()),
        )
    if definition.categories:
        return _rate_mix(stat, definition, tallies)
    tally = tallies[None]
    if stat.kind is StatKind.RATE:
        return tally.rate(100 if definition.per100 else 1)
    return ReportCount(count=tally.count, left_out=tally.excluded)


type _BucketKey = tuple[Stat, str | None, ReportSplit | None, str | None]
type _CellParts = dict[UUID, dict[StrEnum | None, list[StatRow]]]


class _ReportTallies:
    def __init__(
        self,
        rows: Iterable[StatRow],
        *,
        subjects: Mapping[UUID, SubjectKind] | None = None,
        match_count: int = 0,
    ) -> None:
        self.subjects = subjects
        self.match_count = match_count
        self.cells: defaultdict[_BucketKey, _CellParts] = defaultdict(dict)
        uncredited: dict[tuple[Stat, StatBreakdown], int] = {}
        for row in rows:
            if row.subject.team_id is None:
                self._count_uncredited(row, uncredited)
                continue
            subject_id = (
                row.subject.team_id
                if row.subject.kind is SubjectKind.TEAM
                else row.subject.player_id
            )
            if subject_id is not None and (
                subjects is None or subjects.get(subject_id) is row.subject.kind
            ):
                self._add(row, subject_id)
        self.uncredited = sum(uncredited.values())

    @staticmethod
    def _count_uncredited(row: StatRow, totals: dict[tuple[Stat, StatBreakdown], int]) -> None:
        if row.breakdown.shot is not None or row.stat is Stat.SHOT_DISADVANTAGE:
            return
        breakdown = row.breakdown
        if row.stat.kind is StatKind.RATE:
            breakdown = replace(breakdown, category=None)
        key = row.stat, breakdown
        count = row.total if row.stat.kind is StatKind.RATE else row.count
        # Overall rows can repeat the same opportunity for the Team, the Player and each category.
        totals[key] = max(totals.get(key, 0), (count or 0) + row.excluded)

    def _add(self, row: StatRow, subject_id: UUID) -> None:
        stat = Stat.SHOT_ADVANTAGE if row.stat is Stat.SHOT_DISADVANTAGE else row.stat
        definition = STAT_DEFINITIONS[stat]
        category: StrEnum | None = row.breakdown.category
        if row.stat is Stat.SHOT_ADVANTAGE:
            category = ShotOutcome.ADVANTAGE
        elif row.stat is Stat.SHOT_DISADVANTAGE:
            category = ShotOutcome.DISADVANTAGE

        def add(axis: ReportSplit | None, bucket: str | None) -> None:
            subjects = self.cells[stat, fixed, axis, bucket]
            subjects.setdefault(subject_id, {}).setdefault(category, []).append(row)

        fixed = _fixed_bucket(row.breakdown, definition.sub_rows)
        shot = row.breakdown.shot
        if definition.sub_rows is ReportDimension.SHOT_NUMBER:
            # The overall tally pools both Shots 3 and 5. Keep their individual Shot rows here.
            if fixed is None:
                return
            add(None, None)
        elif shot is None:
            add(None, None)
        if shot is not None:
            for split in definition.splits_by:
                if split is ReportSplit.COURT_HALF and row.subject.kind is SubjectKind.TEAM:
                    continue
                add(split, _bucket(shot, split))

    def _values(self, key: _BucketKey) -> ReportValues:
        stat, _, split, bucket = key
        parts = self.cells.get(key, {})
        if self.subjects is not None and stat.kind is StatKind.PER_MATCH:
            if bucket == _UNKNOWN and not parts:
                return {}
            return {
                subject: self._per_match_value(parts.get(subject, {}).get(None, ()))
                for subject, kind in self.subjects.items()
                if split is not ReportSplit.COURT_HALF or kind is SubjectKind.PLAYER
            }
        definition = STAT_DEFINITIONS[stat]
        pooled = split is not None or definition.sub_rows is ReportDimension.SHOT_NUMBER
        return {
            subject: _value(stat, definition, categories, pooled=pooled)
            for subject, categories in parts.items()
        }

    def _per_match_value(self, rows: Sequence[StatRow]) -> ReportPerMatch:
        # Every displayed subject played all the chosen Matches. A breakdown may contain
        # several rows from one Match or none at all, so keep the same denominator in each.
        count = sum(row.count for row in rows)
        return ReportPerMatch(
            count=count,
            left_out=sum(row.excluded for row in rows),
            matches=self.match_count,
            average=count / self.match_count,
        )

    def _row(self, stat: Stat, fixed: str | None) -> ReportRow:
        breakdowns: ReportBreakdowns = {}
        for split in STAT_DEFINITIONS[stat].splits_by:
            buckets = {
                bucket: self._values((stat, fixed, split, bucket))
                for bucket in _SPLIT_BUCKETS[split]
            }
            if unknown := self._values((stat, fixed, split, _UNKNOWN)):
                buckets[_UNKNOWN] = unknown
            breakdowns[split] = buckets
        return ReportRow(values=self._values((stat, fixed, None, None)), breakdowns=breakdowns)

    def report_stats(self) -> list[ReportStat]:
        stats = []
        show_team_stats = self.subjects is None or SubjectKind.TEAM in self.subjects.values()
        for stat, definition in STAT_DEFINITIONS.items():
            if stat is Stat.SHOT_DISADVANTAGE:
                continue  # Displayed together with Advantage and Neutral in Shot Outcome.
            if not show_team_stats and definition.applies_to is ReportSubject.TEAM:
                continue
            dimension = definition.sub_rows
            rows: list[ReportSubRow] = []
            if dimension is None:
                overall = self._row(stat, None)
            else:
                overall = ReportRow(values={}, breakdowns={})
                for bucket in (*_FIXED_BUCKETS[dimension], _UNKNOWN):
                    row = self._row(stat, bucket)
                    if bucket != _UNKNOWN or row.values:
                        label = (
                            f"Shot {bucket}"
                            if bucket.isdecimal()
                            else bucket.replace("_", " ").title()
                        )
                        rows.append(
                            ReportSubRow(
                                id=bucket, label=label, values=row.values, breakdowns=row.breakdowns
                            )
                        )
            outcome = stat is Stat.SHOT_ADVANTAGE
            stats.append(
                ReportStat(
                    id="shot_outcome" if outcome else stat,
                    label="Shot Outcome" if outcome else definition.label,
                    group=definition.group,
                    kind=(
                        ReportKind.PER_MATCH
                        if self.subjects is not None and stat.kind is StatKind.PER_MATCH
                        else definition.kind(stat)
                    ),
                    applies_to=definition.applies_to,
                    splits_by=definition.splits_by,
                    sub_rows=dimension,
                    values=overall.values,
                    breakdowns=overall.breakdowns,
                    rows=rows,
                )
            )
        return stats


def _game_score(game: Game, roster: MatchRoster) -> tuple[int, int] | None:
    """The latest known score in Team A/B order, advanced through known side-out results."""
    latest = current = None
    previous = 0
    for rally in sorted(game.rallies, key=lambda rally: rally.number):
        if rally.number != previous + 1:
            current = None
        previous = rally.number
        called = rally.score.value
        if called is None and current is None:
            continue
        serving = resolve_serving_team(rally, roster)
        if called is not None:
            if serving == roster.team_a_id or called.serving == called.receiving:
                current = called.serving, called.receiving
            elif serving == roster.team_b_id:
                current = called.receiving, called.serving
            else:
                current = None
        if current is None:
            continue
        winner = resolve_rally_winner(rally, roster)
        if winner is None or serving is None:
            latest, current = current, None
        elif winner == serving:
            a, b = current
            latest = current = (a + 1, b) if serving == roster.team_a_id else (a, b + 1)
        else:
            latest = current
    return latest


def game_scores(match: Match, roster: MatchRoster, first_team_id: TeamId) -> list[ReportGame]:
    games = []
    for game in sorted(match.games, key=lambda game: game.number):
        score = _game_score(game, roster)
        if score is not None and first_team_id == roster.team_b_id:
            score = score[1], score[0]
        games.append(ReportGame(number=game.number, score=score))
    return games


def rally_counts(games: Iterable[Game]) -> ReportRallies:
    statuses = Counter(rally.status for game in games for rally in game.rallies)
    return ReportRallies(
        counted=statuses.total(),
        done=statuses[RallyStatus.DONE],
        in_progress=statuses[RallyStatus.IN_PROGRESS],
        empty=statuses[RallyStatus.EMPTY],
    )


def build_report(
    match: Match, roster: MatchRoster, tournament: str, rows: Iterable[StatRow]
) -> MatchReport:
    """Build the header and display rows from a single Rally Log snapshot."""
    tallies = _ReportTallies(rows)
    rallies = rally_counts(match.games)
    return MatchReport(
        header=ReportHeader(
            tournament=tournament,
            teams=(
                ReportTeam.from_players(roster.team_a_id, roster.team_a_players),
                ReportTeam.from_players(roster.team_b_id, roster.team_b_players),
            ),
            games=game_scores(match, roster, roster.team_a_id),
            rallies=rallies,
            uncredited=tallies.uncredited,
        ),
        stats=tallies.report_stats() if rallies.counted else [],
    )


def build_multi_match_report(
    matches: Sequence[tuple[Match, MatchRoster]], subjects: Mapping[UUID, SubjectKind]
) -> MultiMatchReport:
    """Pool the selected Matches for the subjects present in every one of them."""
    rallies = rally_counts(game for match, _ in matches for game in match.games)
    tallies = _ReportTallies(
        compute_stats(matches) if rallies.counted else (),
        subjects=subjects,
        match_count=len(matches),
    )
    return MultiMatchReport(
        header=MultiMatchHeader(
            match_count=len(matches), rallies=rallies, uncredited=tallies.uncredited
        ),
        stats=tallies.report_stats() if rallies.counted else [],
    )
