"""Player and Team profiles and their Matches in the Rally Log."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date
from uuid import UUID

from pydantic import BaseModel

from pb_tokei.rally_log import (
    Franchise,
    Handedness,
    MatchGames,
    MatchRoster,
    Player,
    PlayerId,
    RallyLog,
    TeamId,
    Tour,
    Tournament,
)

from .report import (
    MultiMatchReport,
    ReportGame,
    ReportPlayer,
    ReportRallies,
    ReportTeam,
    build_multi_match_report,
    game_scores,
    rally_counts,
)
from .stats import SubjectKind


class PlayerProfile(ReportPlayer):
    handedness: Handedness


class PlayerListEntry(PlayerProfile):
    match_count: int


class TeamListEntry(ReportTeam):
    match_count: int


class PlayedForTournament(BaseModel):
    id: UUID
    name: str
    match_count: int


class PlayedForFranchise(BaseModel):
    id: UUID
    name: str
    tournaments: list[PlayedForTournament]


class ReportPartner(BaseModel):
    team: ReportTeam
    player: ReportPlayer
    match_count: int


class SubjectMatch(BaseModel):
    id: UUID
    date: date | None
    tournament: str
    partner: ReportPlayer | None
    opponents: ReportTeam
    games: list[ReportGame]
    rallies: ReportRallies


class PlayerReport(MultiMatchReport):
    profile: PlayerProfile
    played_for: list[PlayedForFranchise]
    partners: list[ReportPartner]
    matches: list[SubjectMatch]


class TeamReport(MultiMatchReport):
    profile: ReportTeam
    matches: list[SubjectMatch]


def list_players(log: RallyLog) -> list[PlayerListEntry]:
    players: dict[PlayerId, Player] = {}
    counts: Counter[PlayerId] = Counter()
    for roster in log.list_match_rosters():
        for player in roster.players:
            players[player.id] = player
            counts[player.id] += 1
    return [
        PlayerListEntry(id=p.id, name=p.name, handedness=p.handedness, match_count=counts[p.id])
        for p in sorted(players.values(), key=lambda p: (p.name, p.id))
    ]


def list_teams(log: RallyLog) -> list[TeamListEntry]:
    teams: dict[TeamId, tuple[Player, Player]] = {}
    counts: Counter[TeamId] = Counter()
    for roster in log.list_match_rosters():
        for team_id in (roster.team_a_id, roster.team_b_id):
            teams[team_id] = roster.team_players(team_id)
            counts[team_id] += 1
    entries = []
    for team_id, players in teams.items():
        team = ReportTeam.from_players(team_id, players)
        entries.append(TeamListEntry(id=team.id, players=team.players, match_count=counts[team_id]))
    return sorted(entries, key=lambda team: (team.players[0].name, team.players[1].name, team.id))


@dataclass(frozen=True, slots=True)
class SubjectMatchSource:
    match: MatchGames
    roster: MatchRoster
    tournament: Tournament
    franchise: Franchise | None


def _load_matches(
    log: RallyLog, rosters: list[MatchRoster], *, player_id: PlayerId | None = None
) -> list[SubjectMatchSource]:
    if not rosters:
        return []
    matches = log.load_match_games([roster.match_id for roster in rosters])
    tournaments = {t.id: t for t in log.list_tournaments()}
    franchise_matches = {}
    franchises = {}
    if player_id is not None and any(m.franchise_match_id is not None for m in matches.values()):
        franchise_matches = {m.id: m for m in log.list_franchise_matches()}
        franchises = {f.id: f for f in log.list_franchises()}

    sources = []
    for roster in rosters:
        match = matches[roster.match_id]
        tournament = tournaments[match.tournament_id]
        franchise = None
        if (
            player_id is not None
            and tournament.tour is Tour.MLP
            and match.franchise_match_id is not None
        ):
            franchise_match = franchise_matches[match.franchise_match_id]
            franchise_id = (
                franchise_match.franchise_a_id
                if roster.team_id_for(player_id) == roster.team_a_id
                else franchise_match.franchise_b_id
            )
            franchise = franchises[franchise_id]
        sources.append(SubjectMatchSource(match, roster, tournament, franchise))
    return sources


def load_player_matches(
    log: RallyLog, player_id: PlayerId
) -> tuple[Player, list[SubjectMatchSource]] | None:
    with log.transaction():
        try:
            player = log.get_player(player_id)
        except KeyError:
            return None
        rosters = log.list_match_rosters(player_id=player_id)
        return player, _load_matches(log, rosters, player_id=player_id)


def load_team_matches(
    log: RallyLog, team_id: TeamId
) -> tuple[ReportTeam, list[SubjectMatchSource]] | None:
    with log.transaction():
        try:
            team = log.get_team(team_id)
        except KeyError:
            return None
        first, second = team.player_ids
        profile = ReportTeam.from_players(team.id, (log.get_player(first), log.get_player(second)))
        return profile, _load_matches(log, log.list_match_rosters(team_id=team_id))


def _match_row(
    source: SubjectMatchSource, team_id: TeamId, partner: ReportPlayer | None = None
) -> SubjectMatch:
    match, roster = source.match, source.roster
    opponents = roster.other_team_id(team_id)
    return SubjectMatch(
        id=match.id,
        date=match.date,
        tournament=source.tournament.name,
        partner=partner,
        opponents=ReportTeam.from_players(opponents, roster.team_players(opponents)),
        games=game_scores(match.games, roster, team_id),
        rallies=rally_counts(match.games),
    )


def build_player_report(player: Player, sources: list[SubjectMatchSource]) -> PlayerReport:
    report = build_multi_match_report(
        [(source.match, source.roster) for source in sources], {player.id: SubjectKind.PLAYER}
    )
    played_for: defaultdict[Franchise, Counter[Tournament]] = defaultdict(Counter)
    partners: dict[TeamId, ReportPartner] = {}
    matches = []
    for source in sources:
        roster = source.roster
        team_id = roster.team_id_for(player.id)
        teammates = roster.team_players(team_id)
        partner = ReportPlayer.from_player(next(p for p in teammates if p.id != player.id))
        if team_id not in partners:
            partners[team_id] = ReportPartner(
                team=ReportTeam.from_players(team_id, teammates), player=partner, match_count=0
            )
        partners[team_id].match_count += 1
        if source.franchise is not None:
            played_for[source.franchise][source.tournament] += 1
        matches.append(_match_row(source, team_id, partner))
    ordered_partners = sorted(partners.values(), key=lambda p: (p.player.name, p.player.id))
    return PlayerReport(
        header=report.header,
        stats=report.stats,
        profile=PlayerProfile(id=player.id, name=player.name, handedness=player.handedness),
        played_for=[
            PlayedForFranchise(
                id=franchise.id,
                name=franchise.name,
                tournaments=[
                    PlayedForTournament(id=t.id, name=t.name, match_count=counts[t])
                    for t in sorted(counts, key=lambda t: (t.name, t.id))
                ],
            )
            for franchise, counts in sorted(
                played_for.items(), key=lambda item: (item[0].name, item[0].id)
            )
        ],
        partners=ordered_partners,
        matches=matches,
    )


def build_team_report(team: ReportTeam, sources: list[SubjectMatchSource]) -> TeamReport:
    subjects = {player.id: SubjectKind.PLAYER for player in team.players}
    subjects[team.id] = SubjectKind.TEAM
    report = build_multi_match_report([(s.match, s.roster) for s in sources], subjects)
    return TeamReport(
        header=report.header,
        stats=report.stats,
        profile=team,
        matches=[_match_row(source, TeamId(team.id)) for source in sources],
    )
