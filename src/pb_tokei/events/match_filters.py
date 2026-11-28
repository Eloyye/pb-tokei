"""Match selection shared by dashboard reports."""

from datetime import date
from typing import Self

from pydantic import BaseModel, model_validator

from pb_tokei.rally_log import PlayerId, Tour, Tournament, TournamentId


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


class TeamMatchFilters(MatchFilters):
    opponent: PlayerId | None = None


class PlayerMatchFilters(TeamMatchFilters):
    partner: PlayerId | None = None
