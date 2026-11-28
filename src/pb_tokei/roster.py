"""Roster Files: hand-written TOML files that each set up one Match.

A Roster File names its Tournament, Players and Franchises; setting up the Match finds each by
name in the Rally Log, or adds it when it is new. Setup only ever creates a Match: it never saves
over one that exists, since that would replace the Rallies already logged under it.

Names are kept unique here (after trimming outer spaces and folding case/internal spacing),
shared across Match creation, Match editing, renaming, and merging under one lock.
"""

from __future__ import annotations

import datetime
import os
import tomllib
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from functools import partial
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import UUID

from pb_tokei.rally_log import (
    Discipline,
    Franchise,
    FranchiseId,
    FranchiseMatch,
    FranchiseMatchId,
    Gender,
    Handedness,
    Match,
    MatchId,
    MatchRoster,
    Player,
    PlayerId,
    RallyLog,
    RecordNotFound,
    SourceVideo,
    Team,
    TeamId,
    Tour,
    Tournament,
    TournamentId,
    check_match_date,
    check_match_lineup,
    is_calendar_date,
    new_id,
    parse_match_date,
    team_discipline,
)


class RosterError(ValueError):
    """A Roster that is malformed, or that disagrees with the Rally Log."""


class AmbiguousFranchiseMatchError(RosterError):
    """More than one existing Franchise Match fits an unpinned Roster."""

    def __init__(self, message: str, choices: tuple[FranchiseMatchId, ...]) -> None:
        super().__init__(message)
        self.choices = choices


class ExactNameConflictError(RosterError):
    """Renaming a record to another record's exact name: offer merging instead."""

    def __init__(self, message: str, *, existing_id: UUID, existing_name: str) -> None:
        super().__init__(message)
        self.existing_id = existing_id
        self.existing_name = existing_name


class Unset:
    pass


UNSET = Unset()


@dataclass(frozen=True)
class RosterPlayer:
    name: str
    handedness: Handedness
    gender: Gender


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
    date: datetime.date
    tournament: str
    tour: Tour
    team_a: tuple[RosterPlayer, RosterPlayer]
    team_b: tuple[RosterPlayer, RosterPlayer]
    franchise_match: RosterFranchiseMatch | None = None
    video: SourceVideo | None = None

    def __post_init__(self) -> None:
        try:
            check_match_date(self.date, required=True)
        except ValueError as exc:
            raise RosterError(str(exc)) from None
        team_a, team_b = _trim_team(self.team_a), _trim_team(self.team_b)
        names = [p.name for p in (*team_a, *team_b)]
        if not all(names):
            raise RosterError("each Player needs a name")
        if len(set(names)) != len(names):
            raise RosterError("a Player can't appear twice in a Match")
        try:
            check_match_lineup(
                (team_a[0].gender, team_a[1].gender),
                (team_b[0].gender, team_b[1].gender),
            )
        except ValueError as exc:
            raise RosterError(str(exc)) from None
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
        {"id", "date", "tournament", "team_a", "team_b"},
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
        date=_date(data, "date", "the Roster File"),
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
        _only_keys(player, where, {"name", "handedness", "gender"})
        result.append(
            RosterPlayer(
                _text(player, "name", where),
                _choice(player, "handedness", Handedness, where),
                _choice(player, "gender", Gender, where),
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


def _choice[E: (Tour, Handedness, Gender)](
    table: dict[str, Any], key: str, enum: type[E], where: str
) -> E:
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


def _date(table: dict[str, Any], key: str, where: str) -> datetime.date:
    value = table.get(key)
    if is_calendar_date(value):
        try:
            check_match_date(value, required=True)
        except ValueError as exc:
            raise RosterError(f"{where} {key}: {exc}") from None
        return value
    if not isinstance(value, str) or not value.strip():
        raise RosterError(f"{where} {key} must be YYYY-MM-DD")
    text = value.strip()
    try:
        return parse_match_date(text)
    except ValueError:
        raise RosterError(f"{where} {key} must be YYYY-MM-DD, not {text!r}") from None


# --- Template -----------------------------------------------------------------------------


def roster_template(match_id: MatchId | None = None) -> str:
    """A Roster File to fill in, with a fresh Match id."""
    match_id = match_id or MatchId(new_id())
    return f'''# Roster File: sets up one Match. Load it with `pb-tokei match add <this file>`.
# Use the exact stored names for existing Players, Franchises and Tournaments (across all Tours).
# Outer spaces are trimmed. If a name differs only in case or internal spacing, use the suggestion.
id = "{match_id}"
date = ""            # YYYY-MM-DD, the day the Match was played

[tournament]
name = ""            # put the year in the name, e.g. "PPA Atlanta Open 2026"
tour = "ppa"         # ppa | app | mlp

[[team_a.players]]
name = ""
handedness = "right" # left | right
gender = "female"    # male | female

[[team_a.players]]
name = ""
handedness = "right"
gender = "female"

[[team_b.players]]
name = ""
handedness = "right"
gender = "female"

[[team_b.players]]
name = ""
handedness = "right"
gender = "female"

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
# stop both from adding the same normalized name under different ids, nor stop a workspace write
# started on an old snapshot from committing against a Player or Match being replaced or deleted.
_setup_lock = Lock()
match_write_lock = _setup_lock


def set_up_match(log: RallyLog, roster: Roster, *, source_video_frames: int | None = None) -> Match:
    """Creates the Match a Roster describes in one transaction.

    After trimming outer whitespace, an exact name reuses the stored Player, Franchise or
    Tournament on its Tour. A name that only matches after folding case and internal whitespace
    raises RosterError. Tournament names are checked across Tours. Only new records are written.
    """
    with _setup_lock, log.transaction():
        return _set_up_match(log, roster, source_video_frames)


def _set_up_match(log: RallyLog, roster: Roster, source_video_frames: int | None) -> Match:
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
    backfilled_genders: dict[PlayerId, Gender] = {}
    for entry in (*roster.team_a, *roster.team_b):
        player = log.find_player(entry.name)
        if player is None:
            if available_players is None:
                available_players = log.list_players()
            _reject_normalized_name(available_players, entry.name, "Player")
            player = Player(PlayerId(new_id()), entry.name, entry.handedness, entry.gender)
            new.append(partial(log.save_player, player))
            available_players.append(player)
        else:
            if player.handedness is not entry.handedness:
                raise RosterError(
                    f"{entry.name} is stored as {player.handedness.value}-handed,"
                    f" but the Roster says {entry.handedness.value}"
                )
            if player.gender is None:
                backfilled = replace(player, gender=entry.gender)
                new.append(partial(log.save_player, backfilled))
                backfilled_genders[player.id] = entry.gender
            elif player.gender is not entry.gender:
                raise RosterError(
                    f"{entry.name} is stored as {player.gender.value},"
                    f" but the Roster says {entry.gender.value}"
                )
        player_ids[entry.name] = player.id

    if backfilled_genders:
        _check_existing_matches_for_gender_updates(log, backfilled_genders)

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
        date=roster.date,
        source_video=roster.video,
        source_video_frames=source_video_frames,
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


def _check_roster_lineups(
    log: RallyLog,
    proposed: Sequence[
        tuple[
            MatchRoster,
            tuple[Gender | None, Gender | None],
            tuple[Gender | None, Gender | None],
        ]
    ],
) -> None:
    """Rejects any proposed change that leaves a fully-gendered Match with an invalid Discipline."""
    conflicts: list[tuple[MatchRoster, Discipline, Discipline]] = []
    for roster, team_a_genders, team_b_genders in proposed:
        disc_a = team_discipline(team_a_genders)
        disc_b = team_discipline(team_b_genders)
        if disc_a is not None and disc_b is not None and disc_a is not disc_b:
            conflicts.append((roster, disc_a, disc_b))
    if not conflicts:
        return
    metadata = log.load_match_metadata([roster.match_id for roster, _, _ in conflicts])
    tournaments = {t.id: t.name for t in log.list_tournaments()}
    details = []
    for roster, disc_a, disc_b in conflicts:
        meta = metadata[roster.match_id]
        tournament_name = tournaments[meta.tournament_id]
        date_part = f" ({meta.date.isoformat()})" if meta.date is not None else ""
        team_a_names = " / ".join(p.name for p in roster.team_a_players)
        team_b_names = " / ".join(p.name for p in roster.team_b_players)
        details.append(
            f"{tournament_name}{date_part}: {team_a_names} vs {team_b_names} "
            f"({disc_a.label} vs {disc_b.label})"
        )
    noun = "Match" if len(details) == 1 else "Matches"
    raise RosterError(
        f"Would create an invalid Discipline in {len(details)} existing {noun}: "
        + "; ".join(details)
    )


def _check_existing_matches_for_gender_updates(
    log: RallyLog, gender_updates: Mapping[PlayerId, Gender]
) -> None:
    rosters_by_id: dict[MatchId, MatchRoster] = {}
    for player_id in gender_updates:
        for roster in log.list_match_rosters(player_id=player_id):
            rosters_by_id.setdefault(roster.match_id, roster)
    if not rosters_by_id:
        return
    proposed = [
        (
            roster,
            (
                gender_updates.get(roster.team_a_players[0].id, roster.team_a_players[0].gender),
                gender_updates.get(roster.team_a_players[1].id, roster.team_a_players[1].gender),
            ),
            (
                gender_updates.get(roster.team_b_players[0].id, roster.team_b_players[0].gender),
                gender_updates.get(roster.team_b_players[1].id, roster.team_b_players[1].gender),
            ),
        )
        for roster in rosters_by_id.values()
    ]
    _check_roster_lineups(log, proposed)


def _check_single_match_replacement(
    roster: MatchRoster, from_player_id: PlayerId, replacement_gender: Gender | None
) -> None:
    team_a = (
        replacement_gender
        if roster.team_a_players[0].id == from_player_id
        else roster.team_a_players[0].gender,
        replacement_gender
        if roster.team_a_players[1].id == from_player_id
        else roster.team_a_players[1].gender,
    )
    team_b = (
        replacement_gender
        if roster.team_b_players[0].id == from_player_id
        else roster.team_b_players[0].gender,
        replacement_gender
        if roster.team_b_players[1].id == from_player_id
        else roster.team_b_players[1].gender,
    )
    try:
        check_match_lineup(team_a, team_b)
    except ValueError as exc:
        raise RosterError(str(exc)) from None


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


# --- Editing, merging, and deleting Match set-up (ADR 0016) -------------------------------


def _resolve_or_create_tournament(log: RallyLog, name: str, tour: Tour) -> Tournament:
    cleaned = name.strip()
    if not cleaned:
        raise RosterError("Tournament name must be non-empty text")
    existing = log.find_tournament(cleaned, tour)
    if existing is not None:
        return existing
    tournaments = log.list_tournaments()
    other = next((t for t in tournaments if t.name == cleaned), None)
    if other is not None:
        raise RosterError(f"Tournament {other.name!r} is on the {other.tour.upper()} Tour")
    _reject_normalized_name(tournaments, cleaned, "Tournament")
    created = Tournament(TournamentId(new_id()), cleaned, tour)
    log.save_tournament(created)
    return created


def _resolve_or_create_franchise(log: RallyLog, name: str) -> Franchise:
    cleaned = name.strip()
    if not cleaned:
        raise RosterError("each Franchise needs a name")
    existing = log.find_franchise(cleaned)
    if existing is not None:
        return existing
    _reject_normalized_name(log.list_franchises(), cleaned, "Franchise")
    created = Franchise(FranchiseId(new_id()), cleaned)
    log.save_franchise(created)
    return created


def _align_franchise_match(
    log: RallyLog,
    tournament: Tournament,
    resolved_fm: FranchiseMatch,
    franchise_a: Franchise,
    franchise_b: Franchise,
    *,
    current_fm_id: FranchiseMatchId | None,
    team_a_id: TeamId,
    team_b_id: TeamId,
) -> tuple[FranchiseMatch, TeamId, TeamId]:
    """Ensures Team A plays for `franchise_a`, flipping the Franchise Match only when no other
    Match uses it, and swapping the Match's Team A/B order otherwise."""
    if resolved_fm.franchise_a_id == franchise_a.id:
        return resolved_fm, team_a_id, team_b_id
    other_uses = log.count_matches_for_franchise_match(resolved_fm.id) - (
        1 if resolved_fm.id == current_fm_id else 0
    )
    if other_uses == 0:
        flipped = FranchiseMatch(resolved_fm.id, tournament.id, franchise_a.id, franchise_b.id)
        log.save_franchise_match(flipped)
        return flipped, team_a_id, team_b_id
    return resolved_fm, team_b_id, team_a_id


def edit_match_setup(
    log: RallyLog,
    match_id: MatchId,
    *,
    date: datetime.date | Unset = UNSET,
    tournament: TournamentId | tuple[str, Tour] | Unset = UNSET,
    franchise_match: RosterFranchiseMatch | None | Unset = UNSET,
    create_new_franchise_match: bool = False,
) -> None:
    """Updates a Match's date, Tournament, and/or Franchise Match in one transaction, deleting
    any orphaned Tournament, Franchise Match, or Franchise."""
    with _setup_lock, log.transaction():
        setup = log.get_match_setup(match_id)

        new_date = setup.date
        if not isinstance(date, Unset):
            try:
                check_match_date(date, required=True)
            except ValueError as exc:
                raise RosterError(str(exc)) from None
            new_date = date

        new_tournament = setup.tournament
        if not isinstance(tournament, Unset):
            if isinstance(tournament, UUID):
                try:
                    new_tournament = log.get_tournament(TournamentId(tournament))
                except KeyError:
                    raise RosterError(f"Tournament not found: {tournament}") from None
            else:
                new_tournament = _resolve_or_create_tournament(log, tournament[0], tournament[1])

        team_a_id, team_b_id = setup.team_a_id, setup.team_b_id
        old_fm = setup.franchise_match
        current_fm_id = None if old_fm is None else old_fm.id
        new_fm_id: FranchiseMatchId | None = current_fm_id

        if isinstance(franchise_match, Unset):
            if old_fm is not None:
                if new_tournament.tour is not Tour.MLP:
                    new_fm_id = None
                elif new_tournament.id != setup.tournament.id:
                    fa = log.get_franchise(old_fm.franchise_a_id)
                    fb = log.get_franchise(old_fm.franchise_b_id)
                    resolved_fm, is_new = _franchise_match_for(log, new_tournament, fa, fb, None)
                    if is_new:
                        log.save_franchise_match(resolved_fm)
                    resolved_fm, team_a_id, team_b_id = _align_franchise_match(
                        log,
                        new_tournament,
                        resolved_fm,
                        fa,
                        fb,
                        current_fm_id=current_fm_id,
                        team_a_id=team_a_id,
                        team_b_id=team_b_id,
                    )
                    new_fm_id = resolved_fm.id
        elif franchise_match is None:
            new_fm_id = None
        else:
            if new_tournament.tour is not Tour.MLP:
                raise RosterError("only MLP Matches have a Franchise Match")
            a_name = franchise_match.franchise_a.strip()
            b_name = franchise_match.franchise_b.strip()
            if not a_name or not b_name:
                raise RosterError("each Franchise needs a name")
            if a_name == b_name:
                raise RosterError("a Franchise can't play itself")
            fa = _resolve_or_create_franchise(log, a_name)
            fb = _resolve_or_create_franchise(log, b_name)

            if create_new_franchise_match:
                resolved_fm = FranchiseMatch(
                    FranchiseMatchId(new_id()), new_tournament.id, fa.id, fb.id
                )
                log.save_franchise_match(resolved_fm)
            elif franchise_match.id is not None:
                try:
                    stored = log.get_franchise_match(franchise_match.id)
                except KeyError:
                    raise RosterError(f"Franchise Match not found: {franchise_match.id}") from None
                if stored.tournament_id != new_tournament.id or {
                    stored.franchise_a_id,
                    stored.franchise_b_id,
                } != {fa.id, fb.id}:
                    raise RosterError(
                        "That Franchise Match is between other Franchises or at another Tournament"
                    )
                resolved_fm = stored
            else:
                resolved_fm, is_new = _franchise_match_for(log, new_tournament, fa, fb, None)
                if is_new:
                    log.save_franchise_match(resolved_fm)

            resolved_fm, team_a_id, team_b_id = _align_franchise_match(
                log,
                new_tournament,
                resolved_fm,
                fa,
                fb,
                current_fm_id=current_fm_id,
                team_a_id=team_a_id,
                team_b_id=team_b_id,
            )
            new_fm_id = resolved_fm.id

        log.update_match_setup(
            match_id,
            date=new_date,
            tournament_id=new_tournament.id,
            team_a_id=team_a_id,
            team_b_id=team_b_id,
            franchise_match_id=new_fm_id,
        )
        log.delete_orphans(
            tournament_ids=(
                [] if new_tournament.id == setup.tournament.id else [setup.tournament.id]
            ),
            franchise_match_ids=([] if old_fm is None or old_fm.id == new_fm_id else [old_fm.id]),
            franchise_ids=(
                [] if old_fm is None else [old_fm.franchise_a_id, old_fm.franchise_b_id]
            ),
        )


def replace_match_player(
    log: RallyLog,
    match_id: MatchId,
    from_player_id: PlayerId,
    to_player: PlayerId | RosterPlayer,
) -> None:
    """Replaces one Player in a Match with an existing or new Player in one transaction,
    rewriting every reference in that Match and deleting any orphaned Team or Player."""
    with _setup_lock, log.transaction():
        roster = log.get_match_roster(match_id)
        if from_player_id not in roster.player_ids:
            raise RosterError(f"Player {from_player_id} is not in Match {match_id}")

        is_new_player = False
        needs_backfill = False
        if isinstance(to_player, UUID):
            try:
                target = log.get_player(PlayerId(to_player))
            except KeyError:
                raise RosterError(f"Player not found: {to_player}") from None
        else:
            name = to_player.name.strip()
            if not name:
                raise RosterError("each Player needs a name")
            existing = log.find_player(name)
            if existing is not None:
                if existing.handedness is not to_player.handedness:
                    raise RosterError(
                        f"{name} is stored as {existing.handedness.value}-handed,"
                        f" but the request says {to_player.handedness.value}"
                    )
                if existing.gender is None:
                    target = replace(existing, gender=to_player.gender)
                    needs_backfill = True
                elif existing.gender is not to_player.gender:
                    raise RosterError(
                        f"{name} is stored as {existing.gender.value},"
                        f" but the request says {to_player.gender.value}"
                    )
                else:
                    target = existing
            else:
                _reject_normalized_name(log.list_players(), name, "Player")
                target = Player(PlayerId(new_id()), name, to_player.handedness, to_player.gender)
                is_new_player = True

        if target.id in roster.player_ids:
            if target.id == from_player_id:
                raise RosterError("Player is already in this Match")
            raise RosterError("a Player can't appear twice in a Match")

        _check_single_match_replacement(roster, from_player_id, target.gender)
        if needs_backfill and target.gender is not None:
            _check_existing_matches_for_gender_updates(log, {target.id: target.gender})

        if is_new_player or needs_backfill:
            log.save_player(target)

        old_team_id = log.rewrite_match_player(match_id, from_player_id, target.id)
        log.delete_orphans(team_ids=[old_team_id], player_ids=[from_player_id])


def delete_match(log: RallyLog, match_id: MatchId) -> None:
    """Hard-deletes a Match, its content and sessions, and any orphaned roster records."""
    with _setup_lock, log.transaction():
        log.delete_match(match_id)


def edit_player(
    log: RallyLog,
    player_id: PlayerId,
    *,
    name: str | Unset = UNSET,
    handedness: Handedness | Unset = UNSET,
    gender: Gender | None | Unset = UNSET,
    dry_run: bool = False,
) -> tuple[Player, int]:
    """Renames a Player or fixes handedness/gender across all Matches; returns `(player, count)`."""
    with _setup_lock, log.transaction():
        try:
            player = log.get_player(player_id)
        except KeyError:
            raise RecordNotFound("Player", player_id) from None

        new_name = player.name if isinstance(name, Unset) else name.strip()
        if not new_name:
            raise RosterError("each Player needs a name")
        new_handedness = player.handedness if isinstance(handedness, Unset) else handedness
        if isinstance(gender, Unset):
            new_gender = player.gender
        else:
            if gender is None:
                raise RosterError("Player gender cannot be cleared")
            new_gender = gender

        if new_name != player.name:
            others = [p for p in log.list_players() if p.id != player.id]
            exact = next((p for p in others if p.name == new_name), None)
            if exact is not None:
                raise ExactNameConflictError(
                    f"Player {exact.name!r} already exists; merge into {exact.name!r} instead",
                    existing_id=exact.id,
                    existing_name=exact.name,
                )
            _reject_normalized_name(others, new_name, "Player")

        if new_gender is not None and new_gender is not player.gender:
            _check_existing_matches_for_gender_updates(log, {player.id: new_gender})

        affected = log.count_matches_for_player(player.id)
        updated = Player(player.id, new_name, new_handedness, new_gender)
        if not dry_run:
            log.save_player(updated)
        return updated, affected


def merge_player(
    log: RallyLog,
    source_id: PlayerId,
    target_id: PlayerId,
    *,
    dry_run: bool = False,
) -> tuple[Player, int]:
    """Replaces `source_id` with `target_id` in every Match `source_id` plays in, then deletes
    `source_id` (and any orphaned Teams). Refused if both play in the same Match or if replacing
    would leave any fully-gendered Match with an invalid Discipline."""
    with _setup_lock, log.transaction():
        try:
            source = log.get_player(source_id)
        except KeyError:
            raise RecordNotFound("Player", source_id) from None
        try:
            target = log.get_player(target_id)
        except KeyError:
            raise RosterError(f"Player not found: {target_id}") from None
        if source.id == target.id:
            raise RosterError("Cannot merge a Player into themselves")

        rosters = log.list_match_rosters(player_id=source.id)
        for roster in rosters:
            if target.id in roster.player_ids:
                raise RosterError(
                    f"Cannot merge {source.name} into {target.name}: both play in the same Match"
                )
        proposed = [
            (
                roster,
                (
                    target.gender
                    if roster.team_a_players[0].id == source.id
                    else roster.team_a_players[0].gender,
                    target.gender
                    if roster.team_a_players[1].id == source.id
                    else roster.team_a_players[1].gender,
                ),
                (
                    target.gender
                    if roster.team_b_players[0].id == source.id
                    else roster.team_b_players[0].gender,
                    target.gender
                    if roster.team_b_players[1].id == source.id
                    else roster.team_b_players[1].gender,
                ),
            )
            for roster in rosters
        ]
        _check_roster_lineups(log, proposed)
        affected = len(rosters)
        if dry_run:
            return target, affected

        old_teams = [
            log.rewrite_match_player(roster.match_id, source.id, target.id) for roster in rosters
        ]
        log.delete_orphans(team_ids=old_teams, player_ids=[source.id])
        return target, affected


def edit_tournament(
    log: RallyLog,
    tournament_id: TournamentId,
    *,
    name: str | Unset = UNSET,
    tour: Tour | Unset = UNSET,
    dry_run: bool = False,
) -> tuple[Tournament, int]:
    """Renames a Tournament or fixes its Tour across all Matches; returns `(tournament, count)`."""
    with _setup_lock, log.transaction():
        try:
            tournament = log.get_tournament(tournament_id)
        except KeyError:
            raise RecordNotFound("Tournament", tournament_id) from None

        new_name = tournament.name if isinstance(name, Unset) else name.strip()
        if not new_name:
            raise RosterError("Tournament name must be non-empty text")
        new_tour = tournament.tour if isinstance(tour, Unset) else tour

        if new_name != tournament.name:
            others = [t for t in log.list_tournaments() if t.id != tournament.id]
            exact = next((t for t in others if t.name == new_name), None)
            if exact is not None:
                if exact.tour is new_tour:
                    if new_tour is tournament.tour:
                        raise ExactNameConflictError(
                            f"Tournament {exact.name!r} already exists; "
                            f"merge into {exact.name!r} instead",
                            existing_id=exact.id,
                            existing_name=exact.name,
                        )
                    raise RosterError(
                        f"Tournament {exact.name!r} already exists on the"
                        f" {exact.tour.upper()} Tour; change this Tournament's Tour first,"
                        f" then merge into {exact.name!r}"
                    )
                raise RosterError(f"Tournament {exact.name!r} is on the {exact.tour.upper()} Tour")
            _reject_normalized_name(others, new_name, "Tournament")

        affected = log.count_matches_for_tournament(tournament.id)
        updated = Tournament(tournament.id, new_name, new_tour)
        if not dry_run:
            log.save_tournament(updated)
            if tournament.tour is Tour.MLP and new_tour is not Tour.MLP:
                fm_ids, franchise_ids = log.clear_tournament_franchise_matches(tournament.id)
                log.delete_orphans(franchise_match_ids=fm_ids, franchise_ids=franchise_ids)
        return updated, affected


def merge_tournament(
    log: RallyLog,
    source_id: TournamentId,
    target_id: TournamentId,
    *,
    dry_run: bool = False,
) -> tuple[Tournament, int]:
    """Moves every Match and Franchise Match from `source_id` onto `target_id` and deletes
    `source_id`. Refused across Tours."""
    with _setup_lock, log.transaction():
        try:
            source = log.get_tournament(source_id)
        except KeyError:
            raise RecordNotFound("Tournament", source_id) from None
        try:
            target = log.get_tournament(target_id)
        except KeyError:
            raise RosterError(f"Tournament not found: {target_id}") from None
        if source.id == target.id:
            raise RosterError("Cannot merge a Tournament into itself")
        if source.tour is not target.tour:
            raise RosterError(
                f"Cannot merge Tournaments across Tours "
                f"({source.tour.upper()} into {target.tour.upper()})"
            )

        affected = log.count_matches_for_tournament(source.id)
        if dry_run:
            return target, affected

        log.move_tournament_records(source.id, target.id)
        log.delete_orphans(tournament_ids=[source.id])
        return target, affected


def edit_franchise(
    log: RallyLog,
    franchise_id: FranchiseId,
    *,
    name: str,
    dry_run: bool = False,
) -> tuple[Franchise, int]:
    """Renames a Franchise across all Franchise Matches; returns `(franchise, affected)`."""
    with _setup_lock, log.transaction():
        try:
            franchise = log.get_franchise(franchise_id)
        except KeyError:
            raise RecordNotFound("Franchise", franchise_id) from None

        new_name = name.strip()
        if not new_name:
            raise RosterError("each Franchise needs a name")

        if new_name != franchise.name:
            others = [f for f in log.list_franchises() if f.id != franchise.id]
            exact = next((f for f in others if f.name == new_name), None)
            if exact is not None:
                raise ExactNameConflictError(
                    f"Franchise {exact.name!r} already exists; merge into {exact.name!r} instead",
                    existing_id=exact.id,
                    existing_name=exact.name,
                )
            _reject_normalized_name(others, new_name, "Franchise")

        affected = log.count_matches_for_franchise(franchise.id)
        updated = Franchise(franchise.id, new_name)
        if not dry_run:
            log.save_franchise(updated)
        return updated, affected


def merge_franchise(
    log: RallyLog,
    source_id: FranchiseId,
    target_id: FranchiseId,
    *,
    dry_run: bool = False,
) -> tuple[Franchise, int]:
    """Moves every Franchise Match from `source_id` onto `target_id` and deletes `source_id`.
    Refused if that would put the same Franchise on both sides of a Franchise Match."""
    with _setup_lock, log.transaction():
        try:
            source = log.get_franchise(source_id)
        except KeyError:
            raise RecordNotFound("Franchise", source_id) from None
        try:
            target = log.get_franchise(target_id)
        except KeyError:
            raise RosterError(f"Franchise not found: {target_id}") from None
        if source.id == target.id:
            raise RosterError("Cannot merge a Franchise into itself")
        if log.franchise_match_has_both(source.id, target.id):
            raise RosterError(
                f"Cannot merge {source.name} into {target.name}: "
                "both play each other in the same Franchise Match"
            )

        affected = log.count_matches_for_franchise(source.id)
        if dry_run:
            return target, affected

        log.move_franchise_records(source.id, target.id)
        log.delete_orphans(franchise_ids=[source.id])
        return target, affected
