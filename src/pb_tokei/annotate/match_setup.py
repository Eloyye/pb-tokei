"""Roster data, Match creation, and Match set-up editing inputs for the annotation app."""

from __future__ import annotations

import datetime
from collections import defaultdict
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

from pb_tokei.rally_log import (
    Franchise,
    FranchiseMatchId,
    Handedness,
    MatchId,
    Player,
    RallyLog,
    Tour,
    Tournament,
    check_match_date,
    is_calendar_date,
    new_id,
    parse_match_date,
)
from pb_tokei.roster import Roster, RosterFranchiseMatch, RosterPlayer


def _validate_match_date(value: object) -> datetime.date:
    if is_calendar_date(value):
        check_match_date(value, required=True)
        return value
    if isinstance(value, str):
        return parse_match_date(value)
    raise ValueError("Match date must be YYYY-MM-DD")


MatchDate = Annotated[datetime.date, BeforeValidator(_validate_match_date)]


class FranchiseMatchIn(BaseModel):
    """Omit `id` for Roster File matching, or send null to create a new Franchise Match."""

    model_config = ConfigDict(extra="forbid")

    franchise_a: str
    franchise_b: str
    id: UUID | None = None

    @property
    def create_new(self) -> bool:
        return self.id is None and "id" in self.model_fields_set

    def to_roster(self) -> RosterFranchiseMatch:
        match_id = new_id() if self.create_new else self.id
        return RosterFranchiseMatch(
            self.franchise_a,
            self.franchise_b,
            None if match_id is None else FranchiseMatchId(match_id),
        )

    def to_edit_roster(self) -> RosterFranchiseMatch:
        return RosterFranchiseMatch(
            self.franchise_a,
            self.franchise_b,
            None if self.id is None else FranchiseMatchId(self.id),
        )


class CreateMatchIn(BaseModel):
    date: MatchDate
    tournament: str
    tour: Tour
    team_a: tuple[RosterPlayer, RosterPlayer]
    team_b: tuple[RosterPlayer, RosterPlayer]
    franchise_match: FranchiseMatchIn | None = None
    footage_url: str | None = None

    def to_roster(self) -> Roster:
        return Roster(
            match_id=MatchId(new_id()),
            date=self.date,
            tournament=self.tournament,
            tour=self.tour,
            team_a=self.team_a,
            team_b=self.team_b,
            franchise_match=self.franchise_match.to_roster() if self.franchise_match else None,
        )


class NewTournamentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    tour: Tour


class NewPlayerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    handedness: Handedness


class UpdateMatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: MatchDate | None = None
    tournament: UUID | NewTournamentIn | None = None
    franchise_match: FranchiseMatchIn | None = None

    @model_validator(mode="after")
    def _check_fields(self) -> UpdateMatchIn:
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to update")
        if "date" in self.model_fields_set and self.date is None:
            raise ValueError("Match date cannot be cleared")
        if "tournament" in self.model_fields_set and self.tournament is None:
            raise ValueError("Tournament cannot be cleared")
        return self


class ReplacePlayerIn(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    from_player_id: UUID = Field(alias="from")
    to: UUID | NewPlayerIn


class UpdatePlayerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    handedness: Handedness | None = None

    @model_validator(mode="after")
    def _check_fields(self) -> UpdatePlayerIn:
        if not self.model_fields_set:
            raise ValueError("Provide name or handedness to update")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Player name cannot be cleared")
        if "handedness" in self.model_fields_set and self.handedness is None:
            raise ValueError("Player handedness cannot be cleared")
        return self


class UpdateTournamentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    tour: Tour | None = None

    @model_validator(mode="after")
    def _check_fields(self) -> UpdateTournamentIn:
        if not self.model_fields_set:
            raise ValueError("Provide name or tour to update")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("Tournament name cannot be cleared")
        if "tour" in self.model_fields_set and self.tour is None:
            raise ValueError("Tournament Tour cannot be cleared")
        return self


class UpdateFranchiseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str


class MergeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    into: UUID


class CreatedMatchOut(BaseModel):
    id: UUID


class DeletedMatchOut(BaseModel):
    id: UUID


class PlayerEditOut(BaseModel):
    player: Player
    affected_matches: int
    dry_run: bool


class TournamentEditOut(BaseModel):
    tournament: Tournament
    affected_matches: int
    dry_run: bool


class FranchiseEditOut(BaseModel):
    franchise: Franchise
    affected_matches: int
    dry_run: bool


class MatchTeams(BaseModel):
    team_a: tuple[str, str]
    team_b: tuple[str, str]


class FranchiseMatchOut(BaseModel):
    id: UUID
    tournament_id: UUID
    franchise_a_id: UUID
    franchise_b_id: UUID
    matches: list[MatchTeams]


class RosterOut(BaseModel):
    players: list[Player]
    tournaments: list[Tournament]
    franchises: list[Franchise]
    franchise_matches: list[FranchiseMatchOut]


def roster_catalog(log: RallyLog) -> RosterOut:
    with log.transaction():
        matches = defaultdict[FranchiseMatchId, list[MatchTeams]](list)
        for match in log.list_matches():
            if match.franchise_match_id is not None:
                matches[match.franchise_match_id].append(
                    MatchTeams(team_a=match.team_a, team_b=match.team_b)
                )
        return RosterOut(
            players=log.list_players(),
            tournaments=log.list_tournaments(),
            franchises=log.list_franchises(),
            franchise_matches=[
                FranchiseMatchOut(
                    id=meeting.id,
                    tournament_id=meeting.tournament_id,
                    franchise_a_id=meeting.franchise_a_id,
                    franchise_b_id=meeting.franchise_b_id,
                    matches=matches[meeting.id],
                )
                for meeting in log.list_franchise_matches()
            ],
        )
