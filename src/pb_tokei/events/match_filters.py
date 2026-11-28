"""Match selection shared by dashboard reports."""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Self

from pydantic import BaseModel, model_validator

from pb_tokei.rally_log import (
    Discipline,
    MatchId,
    MatchMetadata,
    PlayerId,
    Tour,
    Tournament,
    TournamentId,
)


class FilterTournament(BaseModel):
    id: TournamentId
    name: str
    tour: Tour

    @classmethod
    def from_tournament(cls, tournament: Tournament) -> Self:
        return cls(id=tournament.id, name=tournament.name, tour=tournament.tour)


class MatchFilterOptions(BaseModel):
    tournaments: list[FilterTournament]


@dataclass(frozen=True, slots=True)
class MatchSelection:
    matches: list[MatchMetadata]
    undated_excluded: int
    unclassified_excluded: int


class MatchFilters(BaseModel):
    tournament: frozenset[TournamentId] = frozenset()
    tour: Tour | None = None
    discipline: Discipline | None = None
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
        self,
        matches: Iterable[MatchMetadata],
        tournaments: Mapping[TournamentId, Tournament],
        disciplines: Mapping[MatchId, Discipline | None] | None = None,
    ) -> MatchSelection:
        """Select Matches in input order and count ones excluded for missing dates or Discipline."""
        selected = []
        undated_excluded = 0
        unclassified_excluded = 0
        date_active = self.date_from is not None or self.date_to is not None
        discipline_active = self.discipline is not None
        for match in matches:
            if not self.includes_tournament(tournaments[match.tournament_id]):
                continue
            match_discipline = None if disciplines is None else disciplines.get(match.id)
            if date_active and match.date is not None and not self.includes_date(match.date):
                continue
            if (
                discipline_active
                and match_discipline is not None
                and match_discipline is not self.discipline
            ):
                continue
            missing_date = date_active and match.date is None
            missing_discipline = discipline_active and match_discipline is None
            if not missing_date and not missing_discipline:
                selected.append(match)
            else:
                if missing_date:
                    undated_excluded += 1
                if missing_discipline:
                    unclassified_excluded += 1
        return MatchSelection(selected, undated_excluded, unclassified_excluded)


class TeamMatchFilters(MatchFilters):
    opponent: PlayerId | None = None


class PlayerMatchFilters(TeamMatchFilters):
    partner: PlayerId | None = None
