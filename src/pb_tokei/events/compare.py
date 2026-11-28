"""Compare two Players or two Teams side by side from the same selected Matches."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from pb_tokei.rally_log import PlayerId, RallyLog, RecordNotFound, TeamId

from .match_filters import (
    FilterTournament,
    MatchFilterOptions,
    MatchFilters,
    PlayerMatchFilters,
    TeamMatchFilters,
)
from .report import (
    MultiMatchHeader,
    ReportBreakdowns,
    ReportKind,
    ReportPlayer,
    ReportRate,
    ReportRow,
    ReportSplit,
    ReportStat,
    ReportSubject,
    ReportSubRow,
    ReportTeam,
    ReportValue,
    ReportValues,
    build_multi_match_report,
)
from .stats import SubjectKind
from .subject_report import (
    SubjectMatchSelection,
    list_players,
    list_teams,
    load_player_matches,
    load_team_matches,
)

_MARKED_KINDS = frozenset((ReportKind.RATE, ReportKind.PER100))


class CompareQuery(MatchFilters):
    kind: SubjectKind = SubjectKind.PLAYER
    a: UUID | None = None
    b: UUID | None = None

    @model_validator(mode="after")
    def validate_subjects(self) -> Self:
        if self.a is not None and self.a == self.b:
            raise ValueError("Choose two different subjects to compare.")
        return self

    @property
    def match_filters(self) -> MatchFilters:
        return MatchFilters.model_validate(self.model_dump(include=set(MatchFilters.model_fields)))


class CompareMarks(BaseModel):
    """Which values are clearly different: their 90% intervals do not overlap."""

    clearly_different: bool
    breakdowns: dict[ReportSplit, list[str]]


class CompareStat(ReportStat):
    marks: CompareMarks
    row_marks: dict[str, CompareMarks]
    """Marks for each sub-row, by its id."""


class _CompareSide(BaseModel):
    header: MultiMatchHeader
    undated_matches_excluded: int


class ComparePlayerSide(_CompareSide):
    subject: ReportPlayer


class CompareTeamSide(_CompareSide):
    subject: ReportTeam


class _Comparison(BaseModel):
    stats: list[CompareStat]
    filter_options: MatchFilterOptions


class PlayerComparison(_Comparison):
    kind: Literal[SubjectKind.PLAYER]
    choices: list[ReportPlayer]
    a: ComparePlayerSide | None
    b: ComparePlayerSide | None


class TeamComparison(_Comparison):
    kind: Literal[SubjectKind.TEAM]
    choices: list[ReportTeam]
    a: CompareTeamSide | None
    b: CompareTeamSide | None


type Comparison = Annotated[PlayerComparison | TeamComparison, Field(discriminator="kind")]


@dataclass(frozen=True, slots=True)
class CompareSelection:
    subject: ReportPlayer | ReportTeam
    matches: SubjectMatchSelection


@dataclass(frozen=True, slots=True)
class CompareSnapshot:
    kind: SubjectKind
    choices: list[ReportPlayer] | list[ReportTeam]
    a: CompareSelection | None
    b: CompareSelection | None


def _load_side(
    log: RallyLog, kind: SubjectKind, subject_id: UUID | None, filters: MatchFilters
) -> CompareSelection | None:
    if subject_id is None:
        return None
    values = filters.model_dump()
    if kind is SubjectKind.PLAYER:
        player = load_player_matches(log, PlayerId(subject_id), PlayerMatchFilters(**values))
        if player is None:
            raise RecordNotFound("Player", subject_id)
        profile, selection = player
        return CompareSelection(ReportPlayer.from_player(profile), selection)
    team = load_team_matches(log, TeamId(subject_id), TeamMatchFilters(**values))
    if team is None:
        raise RecordNotFound("Team", subject_id)
    return CompareSelection(*team)


def load_comparison(log: RallyLog, query: CompareQuery) -> CompareSnapshot:
    """Read both sides from one snapshot. Raises `RecordNotFound` for an unknown subject."""
    filters = query.match_filters
    with log.transaction():
        choices: list[ReportPlayer] | list[ReportTeam]
        if query.kind is SubjectKind.PLAYER:
            choices = [ReportPlayer(id=p.id, name=p.name) for p in list_players(log)]
        else:
            choices = [ReportTeam(id=t.id, players=t.players) for t in list_teams(log)]
        return CompareSnapshot(
            kind=query.kind,
            choices=choices,
            a=_load_side(log, query.kind, query.a, filters),
            b=_load_side(log, query.kind, query.b, filters),
        )


def intervals_separated(a: ReportValue | None, b: ReportValue | None) -> bool:
    """Whether two rates' 90% intervals are disjoint; touching intervals overlap."""
    if not isinstance(a, ReportRate) or not isinstance(b, ReportRate):
        return False
    if a.low is None or a.high is None or b.low is None or b.high is None:
        return False
    return a.high < b.low or b.high < a.low


def _values(a: ReportValues, b: ReportValues) -> ReportValues:
    return {**a, **b}


def _breakdowns(a: ReportBreakdowns, b: ReportBreakdowns) -> ReportBreakdowns:
    merged: ReportBreakdowns = {}
    for split in (*a, *(split for split in b if split not in a)):
        buckets_a, buckets_b = a.get(split, {}), b.get(split, {})
        merged[split] = {
            bucket: _values(buckets_a.get(bucket, {}), buckets_b.get(bucket, {}))
            for bucket in (*buckets_a, *(bucket for bucket in buckets_b if bucket not in buckets_a))
        }
    return merged


def _marks(kind: ReportKind, row: ReportRow, a: UUID, b: UUID) -> CompareMarks:
    if kind not in _MARKED_KINDS:
        return CompareMarks(clearly_different=False, breakdowns={})
    return CompareMarks(
        clearly_different=intervals_separated(row.values.get(a), row.values.get(b)),
        breakdowns={
            split: [
                bucket
                for bucket, values in buckets.items()
                if intervals_separated(values.get(a), values.get(b))
            ]
            for split, buckets in row.breakdowns.items()
        },
    )


def _merge(first: ReportRow | None, second: ReportRow | None) -> ReportRow:
    empty = ReportRow(values={}, breakdowns={})
    first, second = first or empty, second or empty
    return ReportRow(
        values=_values(first.values, second.values),
        breakdowns=_breakdowns(first.breakdowns, second.breakdowns),
    )


def compare_stats(
    stats_a: list[ReportStat], stats_b: list[ReportStat], a: UUID, b: UUID
) -> list[CompareStat]:
    """Merge two single-subject reports into one two-column report with difference marks."""
    stats_by_id = {stat.id: stat for stat in stats_b}
    compared = []
    for stat_a in stats_a:
        stat_b = stats_by_id[stat_a.id]
        # Either side can have an Unknown sub-row the other lacks; it stays last.
        rows_a = {row.id: row for row in stat_a.rows}
        rows_b = {row.id: row for row in stat_b.rows}
        rows, row_marks = [], {}
        for row_id, sub_row in (rows_b | rows_a).items():
            row = _merge(rows_a.get(row_id), rows_b.get(row_id))
            rows.append(
                ReportSubRow(
                    id=row_id, label=sub_row.label, values=row.values, breakdowns=row.breakdowns
                )
            )
            row_marks[row_id] = _marks(stat_a.kind, row, a, b)
        overall = _merge(stat_a, stat_b)
        compared.append(
            CompareStat(
                **stat_a.model_dump(exclude={"values", "breakdowns", "rows"}),
                values=overall.values,
                breakdowns=overall.breakdowns,
                rows=rows,
                marks=_marks(stat_a.kind, overall, a, b),
                row_marks=row_marks,
            )
        )
    return compared


def _side_report(
    kind: SubjectKind, selection: CompareSelection | None
) -> tuple[dict[str, object] | None, list[ReportStat]]:
    if selection is None:
        return None, []
    sources = selection.matches.sources
    report = build_multi_match_report(
        [(source.match, source.roster) for source in sources], {selection.subject.id: kind}
    )
    side = {
        "subject": selection.subject,
        "header": report.header,
        "undated_matches_excluded": selection.matches.undated_matches_excluded,
    }
    return side, report.stats


def _filter_options(*selections: CompareSelection | None) -> MatchFilterOptions:
    tournaments: dict[UUID, FilterTournament] = {}
    for selection in selections:
        if selection is not None:
            for tournament in selection.matches.filter_options.tournaments:
                tournaments[tournament.id] = tournament
    ordered = sorted(tournaments.values(), key=lambda t: (t.name, t.tour, t.id))
    return MatchFilterOptions(tournaments=ordered)


def build_comparison(snapshot: CompareSnapshot) -> PlayerComparison | TeamComparison:
    kind = snapshot.kind
    side_a, stats_a = _side_report(kind, snapshot.a)
    side_b, stats_b = _side_report(kind, snapshot.b)
    stats: list[CompareStat] = []
    if snapshot.a is not None and snapshot.b is not None and (stats_a or stats_b):
        # A side without Rallies has no stat rows. Line its empty values up with the other side.
        stats = [
            stat
            for stat in compare_stats(
                stats_a or stats_b, stats_b or stats_a, snapshot.a.subject.id, snapshot.b.subject.id
            )
            # A Team compare shows Team columns only, so Player-only stats would be blank rows.
            if stat.applies_to is ReportSubject.BOTH or stat.applies_to.value == kind.value
        ]
    fields = {
        "choices": snapshot.choices,
        "a": side_a,
        "b": side_b,
        "stats": stats,
        "filter_options": _filter_options(snapshot.a, snapshot.b),
    }
    if kind is SubjectKind.PLAYER:
        return PlayerComparison.model_validate({"kind": kind, **fields})
    return TeamComparison.model_validate({"kind": kind, **fields})
