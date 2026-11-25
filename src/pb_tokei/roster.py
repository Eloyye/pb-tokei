"""Roster Files: hand-written TOML files that each set up one Match.

A Roster File names its Tournament, Players and Franchises; setting up the Match finds each by
name in the Rally Log, or adds it when it is new. Setup only ever creates a Match: it never saves
over one that exists, since that would replace the Rallies already logged under it.

Names are kept unique here, not by unique indexes: in DuckDB an index on `players.name` would stop
a Player who is already in a Match from being renamed (its foreign keys reject the update).
"""

from __future__ import annotations

import os
import tomllib
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from functools import partial
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import UUID

from pb_tokei.rally_log import (
    Franchise,
    FranchiseId,
    FranchiseMatch,
    FranchiseMatchId,
    Handedness,
    Match,
    MatchId,
    Player,
    PlayerId,
    RallyLog,
    SourceVideo,
    Team,
    TeamId,
    Tour,
    Tournament,
    TournamentId,
    new_id,
)


class RosterError(ValueError):
    """A Roster that is malformed, or that disagrees with the Rally Log."""


class AmbiguousFranchiseMatchError(RosterError):
    """More than one existing Franchise Match fits an unpinned Roster."""

    def __init__(self, message: str, choices: tuple[FranchiseMatchId, ...]) -> None:
        super().__init__(message)
        self.choices = choices


@dataclass(frozen=True)
class RosterPlayer:
    name: str
    handedness: Handedness


def _trim_team(team: tuple[RosterPlayer, RosterPlayer]) -> tuple[RosterPlayer, RosterPlayer]:
    a, b = team
    return replace(a, name=a.name.strip()), replace(b, name=b.name.strip())


@dataclass(frozen=True)
class RosterFranchiseMatch:
    franchise_a: str
    franchise_b: str
    id: FranchiseMatchId | None = None


@dataclass(frozen=True)
class Roster:
    match_id: MatchId
    tournament: str
    tour: Tour
    team_a: tuple[RosterPlayer, RosterPlayer]
    team_b: tuple[RosterPlayer, RosterPlayer]
    franchise_match: RosterFranchiseMatch | None = None
    video: SourceVideo | None = None

    def __post_init__(self) -> None:
        team_a, team_b = _trim_team(self.team_a), _trim_team(self.team_b)
        names = [p.name for p in (*team_a, *team_b)]
        if not all(names):
            raise RosterError("each Player needs a name")
        if len(set(names)) != len(names):
            raise RosterError("a Player can't appear twice in a Match")
        tournament = self.tournament.strip()
        if not tournament:
            raise RosterError("Tournament name must be non-empty text")
        object.__setattr__(self, "team_a", team_a)
        object.__setattr__(self, "team_b", team_b)
        object.__setattr__(self, "tournament", tournament)

        fm = self.franchise_match
        if fm is None:
            if self.tour is Tour.MLP:
                raise RosterError("an MLP Match needs a Franchise Match")
            return
        if self.tour is not Tour.MLP:
            raise RosterError("only MLP Matches have a Franchise Match")
        a, b = fm.franchise_a.strip(), fm.franchise_b.strip()
        if not a or not b:
            raise RosterError("each Franchise needs a name")
        if a == b:
            raise RosterError("a Franchise can't play itself")
        object.__setattr__(self, "franchise_match", replace(fm, franchise_a=a, franchise_b=b))


# --- Reading ------------------------------------------------------------------------------


def read_roster(path: Path) -> Roster:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RosterError(f"cannot read Roster File {path}: {exc.strerror}") from exc
    roster = parse_roster(text)
    if roster.video is not None and not roster.video.path.is_absolute():
        roster_dir = Path(os.path.abspath(path)).parent
        lexical = Path(os.path.abspath(roster_dir / roster.video.path))
        roster = replace(roster, video=replace(roster.video, path=lexical))
    return roster


def parse_roster(text: str) -> Roster:
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise RosterError(f"not valid TOML: {exc}") from exc

    _only_keys(
        data,
        "the Roster File",
        {"id", "tournament", "team_a", "team_b"},
        {"franchise_match", "video"},
    )
    tournament = _table(data, "tournament")
    _only_keys(tournament, "[tournament]", {"name", "tour"})
    tour = _choice(tournament, "tour", Tour, "[tournament]")

    team_a = _team(data, "team_a")
    team_b = _team(data, "team_b")

    franchise_match = None
    if "franchise_match" in data:
        franchise_match = _franchise_match(_table(data, "franchise_match"))

    video = None
    if "video" in data:
        table = _table(data, "video")
        _only_keys(table, "[video]", {"url", "video_id", "path"})
        try:
            video = SourceVideo(
                _text(table, "url", "[video]"),
                _text(table, "video_id", "[video]"),
                Path(_text(table, "path", "[video]")),
            )
        except ValueError as exc:
            raise RosterError(f"[video]: {exc}") from exc

    return Roster(
        match_id=MatchId(_uuid(data, "id", "the Roster File")),
        tournament=_text(tournament, "name", "[tournament]"),
        tour=tour,
        team_a=team_a,
        team_b=team_b,
        franchise_match=franchise_match,
        video=video,
    )


def _team(data: dict[str, Any], key: str) -> tuple[RosterPlayer, RosterPlayer]:
    team = _table(data, key)
    _only_keys(team, f"[{key}]", {"players"})
    players = team.get("players")
    if not isinstance(players, list) or len(players) != 2:
        raise RosterError(f"{key} needs exactly two [[{key}.players]]")
    result = []
    for player in players:
        where = f"[[{key}.players]]"
        if not isinstance(player, dict):
            raise RosterError(f"{where} must be a table")
        _only_keys(player, where, {"name", "handedness"})
        result.append(
            RosterPlayer(
                _text(player, "name", where),
                _choice(player, "handedness", Handedness, where),
            )
        )
    return result[0], result[1]


def _franchise_match(table: dict[str, Any]) -> RosterFranchiseMatch:
    where = "[franchise_match]"
    _only_keys(table, where, {"franchise_a", "franchise_b"}, {"id"})
    a = _text(table, "franchise_a", where)
    b = _text(table, "franchise_b", where)
    pinned = FranchiseMatchId(_uuid(table, "id", where)) if "id" in table else None
    return RosterFranchiseMatch(a, b, pinned)


def _only_keys(
    table: dict[str, Any],
    where: str,
    required: set[str],
    optional: frozenset[str] | set[str] = frozenset(),
) -> None:
    missing = sorted(required - table.keys())
    if missing:
        raise RosterError(f"{where} is missing {', '.join(missing)}")
    unknown = sorted(table.keys() - required - optional)
    if unknown:
        raise RosterError(f"{where} has unknown keys: {', '.join(unknown)}")


def _table(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise RosterError(f"[{key}] must be a table")
    return value


def _text(table: dict[str, Any], key: str, where: str) -> str:
    value = table.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RosterError(f"{where} {key} must be non-empty text")
    return value.strip()


def _choice[E: (Tour, Handedness)](table: dict[str, Any], key: str, enum: type[E], where: str) -> E:
    value = _text(table, key, where)
    try:
        return enum(value)
    except ValueError:
        options = " | ".join(member.value for member in enum)
        raise RosterError(f"{where} {key} must be one of {options}, not {value!r}") from None


def _uuid(table: dict[str, Any], key: str, where: str) -> UUID:
    value = _text(table, key, where)
    try:
        return UUID(value)
    except ValueError:
        raise RosterError(f"{where} {key} is not a UUID: {value!r}") from None


# --- Template -----------------------------------------------------------------------------


def roster_template(match_id: MatchId | None = None) -> str:
    """A Roster File to fill in, with a fresh Match id."""
    match_id = match_id or MatchId(new_id())
    return f'''# Roster File: sets up one Match. Load it with `pb-tokei match add <this file>`.
# Use the exact stored names for existing Players, Franchises and Tournaments (across all Tours).
# Outer spaces are trimmed. If a name differs only in case or internal spacing, use the suggestion.
id = "{match_id}"

[tournament]
name = ""            # put the year in the name, e.g. "PPA Atlanta Open 2026"
tour = "ppa"         # ppa | app | mlp

[[team_a.players]]
name = ""
handedness = "right" # left | right

[[team_a.players]]
name = ""
handedness = "right"

[[team_b.players]]
name = ""
handedness = "right"

[[team_b.players]]
name = ""
handedness = "right"

# MLP only: Team A plays for franchise_a.
# [franchise_match]
# franchise_a = ""
# franchise_b = ""
# id = ""            # only to pick one of two meetings of these Franchises at the Tournament

# Optional; or attach it later with `pb-tokei download <url> --match <id>`.
# [video]
# url = ""
# video_id = ""
# path = ""          # relative to this Roster File, or absolute
'''


# --- Setting up a Match -------------------------------------------------------------------

# The server gives concurrent requests separate DuckDB connections. A transaction alone cannot
# stop both from adding the same normalized name under different ids.
_setup_lock = Lock()


def set_up_match(log: RallyLog, roster: Roster) -> Match:
    """Creates the Match a Roster describes in one transaction.

    After trimming outer whitespace, an exact name reuses the stored Player, Franchise or
    Tournament on its Tour. A name that only matches after folding case and internal whitespace
    raises RosterError. Tournament names are checked across Tours. Only new records are written.
    """
    with _setup_lock, log.transaction():
        return _set_up_match(log, roster)


def _set_up_match(log: RallyLog, roster: Roster) -> Match:
    if log.has_match(roster.match_id):
        raise RosterError(f"Match {roster.match_id} already exists")
    new: list[Callable[[], None]] = []

    tournament = log.find_tournament(roster.tournament, roster.tour)
    if tournament is None:
        tournaments = log.list_tournaments()
        other = next((t for t in tournaments if t.name == roster.tournament), None)
        if other is not None:
            raise RosterError(f"Tournament {other.name!r} is on the {other.tour.upper()} Tour")
        _reject_normalized_name(tournaments, roster.tournament, "Tournament")
        tournament = Tournament(TournamentId(new_id()), roster.tournament, roster.tour)
        new.append(partial(log.save_tournament, tournament))

    available_players: list[Player] | None = None
    player_ids: dict[str, PlayerId] = {}
    for entry in (*roster.team_a, *roster.team_b):
        player = log.find_player(entry.name)
        if player is None:
            if available_players is None:
                available_players = log.list_players()
            _reject_normalized_name(available_players, entry.name, "Player")
            player = Player(PlayerId(new_id()), entry.name, entry.handedness)
            new.append(partial(log.save_player, player))
            available_players.append(player)
        elif player.handedness is not entry.handedness:
            raise RosterError(
                f"{entry.name} is stored as {player.handedness.value}-handed,"
                f" but the Roster says {entry.handedness.value}"
            )
        player_ids[entry.name] = player.id

    teams = []
    for entries in (roster.team_a, roster.team_b):
        a, b = (player_ids[entry.name] for entry in entries)
        team = log.find_team(a, b)
        if team is None:
            team = Team(TeamId(new_id()), (a, b))
            new.append(partial(log.save_team, team))
        teams.append(team)
    team_a, team_b = teams

    franchise_match = None
    if roster.franchise_match is not None:
        fm = roster.franchise_match
        available_franchises: list[Franchise] | None = None
        franchises = []
        for name in (fm.franchise_a, fm.franchise_b):
            franchise = log.find_franchise(name)
            if franchise is None:
                if available_franchises is None:
                    available_franchises = log.list_franchises()
                _reject_normalized_name(available_franchises, name, "Franchise")
                franchise = Franchise(FranchiseId(new_id()), name)
                new.append(partial(log.save_franchise, franchise))
                available_franchises.append(franchise)
            franchises.append(franchise)
        a, b = franchises
        franchise_match, is_new = _franchise_match_for(log, tournament, a, b, fm.id)
        if is_new:
            new.append(partial(log.save_franchise_match, franchise_match))
        if franchise_match.franchise_a_id != a.id:
            # The stored Franchise Match has the Franchises the other way round; Team A must
            # play for its Franchise A.
            team_a, team_b = team_b, team_a

    match = Match(
        id=roster.match_id,
        tournament_id=tournament.id,
        team_a_id=team_a.id,
        team_b_id=team_b.id,
        franchise_match_id=None if franchise_match is None else franchise_match.id,
        source_video=roster.video,
    )
    for save in new:
        save()
    log.save_match(match)
    return match


def _reject_normalized_name(
    records: Iterable[Player | Franchise | Tournament], name: str, kind: str
) -> None:
    normalized = " ".join(name.split()).casefold()
    for record in records:
        if " ".join(record.name.split()).casefold() == normalized:
            raise RosterError(
                f"{kind} {name!r} matches an existing name (did you mean {record.name!r}?)"
            )


def _franchise_match_for(
    log: RallyLog,
    tournament: Tournament,
    franchise_a: Franchise,
    franchise_b: Franchise,
    pinned: FranchiseMatchId | None,
) -> tuple[FranchiseMatch, bool]:
    if pinned is not None:
        try:
            stored = log.get_franchise_match(pinned)
        except KeyError:
            return FranchiseMatch(pinned, tournament.id, franchise_a.id, franchise_b.id), True
        if stored.tournament_id != tournament.id or {
            stored.franchise_a_id,
            stored.franchise_b_id,
        } != {franchise_a.id, franchise_b.id}:
            raise RosterError(
                "That Franchise Match is between other Franchises or at another Tournament"
            )
        return stored, False

    found = log.find_franchise_matches(tournament.id, franchise_a.id, franchise_b.id)
    if len(found) > 1:
        raise AmbiguousFranchiseMatchError(
            f"{franchise_a.name} and {franchise_b.name} met more than once at {tournament.name}",
            tuple(fm.id for fm in found),
        )
    if found:
        return found[0], False
    return FranchiseMatch(
        FranchiseMatchId(new_id()), tournament.id, franchise_a.id, franchise_b.id
    ), True
