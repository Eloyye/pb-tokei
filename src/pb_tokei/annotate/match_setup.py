"""Roster data and Match creation inputs for the annotation app."""

from collections import defaultdict
from uuid import UUID

from pydantic import BaseModel

from pb_tokei.rally_log import (
    Franchise,
    FranchiseMatchId,
    MatchId,
    RallyLog,
    Tour,
    Tournament,
    new_id,
)
from pb_tokei.roster import Roster, RosterFranchiseMatch, RosterPlayer


class FranchiseMatchIn(BaseModel):
    """Omit `id` for Roster File matching, or send null to create a new Franchise Match."""

    franchise_a: str
    franchise_b: str
    id: UUID | None = None

    def to_roster(self) -> RosterFranchiseMatch:
        match_id = self.id
        if match_id is None and "id" in self.model_fields_set:
            match_id = new_id()
        return RosterFranchiseMatch(
            self.franchise_a,
            self.franchise_b,
            None if match_id is None else FranchiseMatchId(match_id),
        )


class CreateMatchIn(BaseModel):
    tournament: str
    tour: Tour
    team_a: tuple[RosterPlayer, RosterPlayer]
    team_b: tuple[RosterPlayer, RosterPlayer]
    franchise_match: FranchiseMatchIn | None = None
    footage_url: str | None = None

    def to_roster(self) -> Roster:
        return Roster(
            match_id=MatchId(new_id()),
            tournament=self.tournament,
            tour=self.tour,
            team_a=self.team_a,
            team_b=self.team_b,
            franchise_match=self.franchise_match.to_roster() if self.franchise_match else None,
        )


class CreatedMatchOut(BaseModel):
    id: UUID


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
    players: list[RosterPlayer]
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
            players=[RosterPlayer(player.name, player.handedness) for player in log.list_players()],
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
