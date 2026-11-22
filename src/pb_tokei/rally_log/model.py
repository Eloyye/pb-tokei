"""The Rally Log: every Rally and Shot in a Match, as Observed and Inferred facts.

Only facts live here. Derived judgments (Shot Type, Rally Phase, Shot Outcome, unforced
errors...) are computed from these records and never stored (ADR 0003).

Court coordinates are in feet, with the origin at the centre of the net. `x` runs across the
court (sideline to sideline, -10 to 10) and `y` along it, negative at the Main View camera's end.
Distance from the net is `abs(y)`.

Frame numbers count frames of the converted constant 60 fps video.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal, NewType
from uuid import UUID, uuid4

PlayerId = NewType("PlayerId", UUID)
TeamId = NewType("TeamId", UUID)
TournamentId = NewType("TournamentId", UUID)
FranchiseId = NewType("FranchiseId", UUID)
FranchiseMatchId = NewType("FranchiseMatchId", UUID)
MatchId = NewType("MatchId", UUID)


def new_id() -> UUID:
    return uuid4()


class Certainty(StrEnum):
    OBSERVED = "observed"
    INFERRED = "inferred"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Fact[T]:
    """A value with how we know it. An Unknown fact has no value; any other fact has one."""

    value: T | None
    certainty: Certainty

    def __post_init__(self) -> None:
        if (self.value is None) != (self.certainty is Certainty.UNKNOWN):
            raise ValueError(f"{self.certainty} fact cannot have value {self.value!r}")


def observed[T](value: T) -> Fact[T]:
    return Fact(value, Certainty.OBSERVED)


def inferred[T](value: T) -> Fact[T]:
    return Fact(value, Certainty.INFERRED)


UNKNOWN: Fact[Any] = Fact(None, Certainty.UNKNOWN)


def _unknown() -> Any:
    return field(default=UNKNOWN)


# --- Vocabularies -------------------------------------------------------------------------


class Tour(StrEnum):
    PPA = "ppa"
    APP = "app"
    MLP = "mlp"


class Handedness(StrEnum):
    LEFT = "left"
    RIGHT = "right"


class Zone(StrEnum):
    FRONTCOURT = "frontcourt"
    MIDCOURT = "midcourt"
    BACKCOURT = "backcourt"


class ShotClass(StrEnum):
    SOFT = "soft"
    HARD = "hard"
    LOB = "lob"
    OVERHEAD = "overhead"


class ContactKind(StrEnum):
    VOLLEY = "volley"
    BOUNCE = "bounce"


class ErrorKind(StrEnum):
    NET = "net"
    OUT = "out"
    KITCHEN_FAULT = "kitchen_fault"
    DOUBLE_HIT = "double_hit"
    BODY_HIT = "body_hit"


class RefereeCall(StrEnum):
    POINT = "point"
    SECOND_SERVER = "second_server"
    SIDE_OUT = "side_out"


class Ruling(StrEnum):
    UPHELD = "upheld"
    OVERTURNED = "overturned"


class WinnerSource(StrEnum):
    """Where a Rally's winner came from, highest priority first."""

    CHALLENGE = "challenge"
    REFEREE_CALL = "referee_call"
    SCOREBOARD = "scoreboard"
    NEXT_SERVE = "next_serve"
    PLAY = "play"  # seen directly in the footage


class CameraView(StrEnum):
    MAIN = "main"
    SIDELINE = "sideline"


class Parity(StrEnum):
    ODD = "odd"
    EVEN = "even"


# --- Roster -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Tournament:
    id: TournamentId
    name: str
    tour: Tour


@dataclass(frozen=True)
class Player:
    id: PlayerId
    name: str
    handedness: Handedness


@dataclass(frozen=True)
class Team:
    """Two Players; the same pair is the same Team in every Match and Tournament."""

    id: TeamId
    player_ids: tuple[PlayerId, PlayerId]

    def __post_init__(self) -> None:
        a, b = self.player_ids
        if a == b:
            raise ValueError("a Team needs two different Players")
        object.__setattr__(self, "player_ids", tuple(sorted(self.player_ids)))


@dataclass(frozen=True)
class Franchise:
    id: FranchiseId
    name: str


@dataclass(frozen=True)
class FranchiseMatch:
    id: FranchiseMatchId
    tournament_id: TournamentId
    franchise_a_id: FranchiseId
    franchise_b_id: FranchiseId


# --- Rally Log ----------------------------------------------------------------------------


@dataclass(frozen=True)
class CourtPoint:
    x: float
    y: float


@dataclass(frozen=True)
class Score:
    """The score called before a Rally: serving score, receiving score, server number."""

    serving: int
    receiving: int
    server_number: Literal[1, 2]


@dataclass(frozen=True)
class Error:
    """What lost the Rally, and whose Error it was (for a Body Hit, the Player hit)."""

    kind: Fact[ErrorKind] = _unknown()
    player_id: Fact[PlayerId] = _unknown()


@dataclass(frozen=True)
class Shot:
    shot_number: Fact[int] = _unknown()
    hitter_id: Fact[PlayerId] = _unknown()
    contact_frame: Fact[int] = _unknown()
    contact_zone: Fact[Zone] = _unknown()
    shot_class: Fact[ShotClass] = _unknown()
    contact_kind: Fact[ContactKind] = _unknown()
    erne: Fact[bool] = _unknown()
    atp: Fact[bool] = _unknown()
    landing: Fact[CourtPoint] = _unknown()
    error: Error | None = None  # set only on the Shot that ended the Rally with an Error
    positions: dict[PlayerId, Fact[CourtPoint]] = field(default_factory=dict)


@dataclass(frozen=True)
class ObservationGap:
    """Shots that happened but were not seen: an odd or even number of them."""

    missing: Parity


@dataclass(frozen=True)
class Challenge:
    challenger_id: Fact[PlayerId] = _unknown()
    original_call: Fact[str] = _unknown()
    ruling: Fact[Ruling] = _unknown()


@dataclass(frozen=True)
class Rally:
    number: int  # 1-based within its Game
    start_frame: int | None = None
    end_frame: int | None = None
    score: Fact[Score] = _unknown()
    serving_team_id: Fact[TeamId] = _unknown()
    server_id: Fact[PlayerId] = _unknown()
    returner_id: Fact[PlayerId] = _unknown()
    referee_call: Fact[RefereeCall] = _unknown()
    challenge: Challenge | None = None
    winner_id: Fact[TeamId] = _unknown()
    winner_source: WinnerSource | None = None
    entries: tuple[Shot | ObservationGap, ...] = ()  # in the order they happened

    @property
    def shots(self) -> tuple[Shot, ...]:
        return tuple(e for e in self.entries if isinstance(e, Shot))


@dataclass(frozen=True)
class Game:
    number: int  # 1-based within its Match
    rallies: tuple[Rally, ...] = ()


@dataclass(frozen=True)
class PlaySegment:
    start_frame: int
    end_frame: int
    camera_view: CameraView


@dataclass(frozen=True)
class SourceVideo:
    """Broadcast footage downloaded on disk for a Match."""

    url: str
    video_id: str
    path: Path

    def __post_init__(self) -> None:
        if not self.url.strip():
            raise ValueError("SourceVideo url cannot be empty")
        if not self.video_id.strip():
            raise ValueError("SourceVideo video_id cannot be empty")
        if not str(self.path) or str(self.path) == ".":
            raise ValueError("SourceVideo path cannot be empty")


@dataclass(frozen=True)
class Match:
    """A Match between two Teams. In an MLP Franchise Match, Team A plays for Franchise A."""

    id: MatchId
    tournament_id: TournamentId
    team_a_id: TeamId
    team_b_id: TeamId
    franchise_match_id: FranchiseMatchId | None = None
    source_video: SourceVideo | None = None
    games: tuple[Game, ...] = ()
    play_segments: tuple[PlaySegment, ...] = ()

    def __post_init__(self) -> None:
        if self.team_a_id == self.team_b_id:
            raise ValueError("a Match needs two different Teams")

    def other_team_id(self, team_id: TeamId) -> TeamId:
        """The Receiving Team, given the Serving Team (and the other way round)."""
        if team_id == self.team_a_id:
            return self.team_b_id
        if team_id == self.team_b_id:
            return self.team_a_id
        raise ValueError(f"Team {team_id} is not in Match {self.id}")
