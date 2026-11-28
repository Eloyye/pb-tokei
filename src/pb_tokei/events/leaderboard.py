"""Rank Players or Teams on one stat from the selected Matches."""

from dataclasses import dataclass
from typing import Self
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from pb_tokei.rally_log import MatchGames, MatchRoster, RallyLog

from .match_filters import FilterTournament, MatchFilterOptions, MatchFilters
from .report import (
    LEADERBOARD_BUCKETS,
    RANKABLE_STATS,
    LeaderboardStat,
    ReportKind,
    ReportPlayer,
    ReportRate,
    ReportSplit,
    ReportTeam,
    leaderboard_rates,
)
from .stats import Stat, SubjectKind


class LeaderboardQuery(MatchFilters):
    kind: SubjectKind = SubjectKind.PLAYER
    stat: str | None = None
    minimum: int = Field(default=30, ge=1)
    by: ReportSplit | None = None
    bucket: str | None = None

    @model_validator(mode="after")
    def validate_ranking(self) -> Self:
        if self.by is ReportSplit.COURT_HALF and self.kind is SubjectKind.TEAM:
            raise ValueError("Court Half is only available for Players.")
        if self.stat is not None:
            stat = RANKABLE_STATS.get(self.stat)
            if stat is None or not stat.supports(self.kind, self.by):
                raise ValueError("Choose a rankable stat for this subject kind and breakdown.")
        if self.bucket is not None and self.bucket not in LEADERBOARD_BUCKETS.get(self.by, ()):
            raise ValueError("Choose a bucket from the selected breakdown.")
        return self

    @property
    def selected_stat(self) -> LeaderboardStat:
        if self.stat is not None:
            return RANKABLE_STATS[self.stat]
        return next(
            stat
            for stat in RANKABLE_STATS.values()
            if stat.kind is ReportKind.RATE and stat.supports(self.kind, self.by)
        )

    @property
    def selected_bucket(self) -> str | None:
        return self.bucket or (None if self.by is None else LEADERBOARD_BUCKETS[self.by][0])


class LeaderboardRow(BaseModel):
    rank: int
    subject: ReportPlayer | ReportTeam
    value: ReportRate


class Leaderboard(BaseModel):
    stat: Stat
    bucket: str | None
    stats: list[LeaderboardStat]
    buckets: dict[ReportSplit, tuple[str, ...]]
    rows: list[LeaderboardRow]
    hidden_count: int
    match_count: int
    filter_options: MatchFilterOptions
    undated_matches_excluded: int


@dataclass(frozen=True, slots=True)
class LeaderboardMatches:
    matches: list[tuple[MatchGames, MatchRoster]]
    filter_options: MatchFilterOptions
    undated_matches_excluded: int


def load_leaderboard_matches(log: RallyLog, filters: MatchFilters) -> LeaderboardMatches:
    with log.transaction():
        rosters = log.list_match_rosters()
        metadata = log.load_match_metadata([roster.match_id for roster in rosters])
        tournament_ids = {match.tournament_id for match in metadata.values()}
        tournaments = [t for t in log.list_tournaments() if t.id in tournament_ids]
        included = {t.id for t in tournaments if filters.includes_tournament(t)}
        selected = []
        undated = 0
        for match in metadata.values():
            if match.tournament_id not in included:
                continue
            if filters.includes_date(match.date):
                selected.append(match)
            elif match.date is None:
                undated += 1
        matches = log.load_match_games_from_metadata(selected)
    return LeaderboardMatches(
        matches=[(matches[r.match_id], r) for r in rosters if r.match_id in matches],
        filter_options=MatchFilterOptions(
            tournaments=[FilterTournament.from_tournament(t) for t in tournaments]
        ),
        undated_matches_excluded=undated,
    )


def build_leaderboard(snapshot: LeaderboardMatches, query: LeaderboardQuery) -> Leaderboard:
    stat, bucket = query.selected_stat, query.selected_bucket
    rates = leaderboard_rates(snapshot.matches, stat, query.kind, query.by, bucket)
    subjects: dict[UUID, ReportPlayer | ReportTeam] = {}
    for _, roster in snapshot.matches:
        if query.kind is SubjectKind.PLAYER:
            for player in roster.players:
                subjects[player.id] = ReportPlayer.from_player(player)
        else:
            for team in (roster.team_a_id, roster.team_b_id):
                subjects[team] = ReportTeam.from_players(team, roster.team_players(team))

    scores = []
    for id_, subject in subjects.items():
        value = rates.get(id_)
        if value is not None and value.of >= query.minimum and value.estimate is not None:
            scores.append((value.estimate, subject, value))
    scores.sort(key=lambda score: score[0], reverse=True)
    rows = []
    rank, previous_estimate = 0, None
    for position, (estimate, subject, value) in enumerate(scores, start=1):
        if estimate != previous_estimate:
            rank, previous_estimate = position, estimate
        rows.append(LeaderboardRow(rank=rank, subject=subject, value=value))

    return Leaderboard(
        stat=stat.id,
        bucket=bucket,
        stats=list(RANKABLE_STATS.values()),
        buckets=LEADERBOARD_BUCKETS,
        rows=rows,
        hidden_count=len(subjects) - len(rows),
        match_count=len(snapshot.matches),
        filter_options=snapshot.filter_options,
        undated_matches_excluded=snapshot.undated_matches_excluded,
    )
