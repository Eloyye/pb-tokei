"""Match selection shared by dashboard reports."""

from collections.abc import Iterable, Mapping
from datetime import date
from typing import Self

from pydantic import BaseModel, model_validator

from pb_tokei.rally_log import MatchMetadata, PlayerId, Tour, Tournament, TournamentId


class FilterTournament(BaseModel):
    id: TournamentId
    name: str
    tour: Tour

    @classmethod
    def from_tournament(cls, tournament: Tournament) -> Self:
        return cls(id=tournament.id, name=tournament.name, tour=tournament.tour)


class MatchFilterOptions(BaseModel):
    tournaments: list[FilterTournament]


class MatchFilters(BaseModel):
    tournament: frozenset[TournamentId] = frozenset()
    tour: Tour | None = None
    date_from: date | None = None
    date_to: date | None = None

    @model_validator(mode="after")
    def validate_date_range(self) -> Self:
        if (
            self.date_from is not None
            and self.date_to is not None
            and self.date_from > self.date_to
        ):
            raise ValueError("Date from must be on or before Date to.")
        return self

    def includes_tournament(self, tournament: Tournament) -> bool:
        return (not self.tournament or tournament.id in self.tournament) and (
            self.tour is None or self.tour == tournament.tour
        )

    def includes_date(self, match_date: date | None) -> bool:
        if self.date_from is None and self.date_to is None:
            return True
        return (
            match_date is not None
            and (self.date_from is None or match_date >= self.date_from)
            and (self.date_to is None or match_date <= self.date_to)
        )

    def select_matches(
        self, matches: Iterable[MatchMetadata], tournaments: Mapping[TournamentId, Tournament]
    ) -> tuple[list[MatchMetadata], int]:
        """Select Matches in input order and count undated ones excluded by the date range."""
        selected = []
        undated_excluded = 0
        for match in matches:
            if not self.includes_tournament(tournaments[match.tournament_id]):
                continue
            if self.includes_date(match.date):
                selected.append(match)
            elif match.date is None:
                undated_excluded += 1
        return selected, undated_excluded


class TeamMatchFilters(MatchFilters):
    opponent: PlayerId | None = None


class PlayerMatchFilters(TeamMatchFilters):
    partner: PlayerId | None = None
