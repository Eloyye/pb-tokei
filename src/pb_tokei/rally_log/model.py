"""The Rally Log: every Rally and Shot in a Match, as Observed and Inferred facts.

Only facts live here. Derived judgments (Shot Type, Rally Phase, Shot Outcome, unforced
errors...) are computed from these records and never stored (ADR 0003).

Court coordinates are in feet, with the origin at the centre of the net. `x` runs across the
court (sideline to sideline, -10 to 10), positive to the Main View camera's right, and `y` along it
(baseline to baseline, -22 to 22), negative at the Main View camera's end. Distance from the net is
`abs(y)`. "Near", "far", "left" and "right" always mean as seen from the Main View camera.

Image coordinates are normalised to the video frame: `x` from 0 (left edge) to 1 (right edge) and
`y` from 0 (top) to 1 (bottom), whatever the video's resolution.

Frame numbers count frames of the converted constant 60 fps video starting at 0, where frame `n`
starts at `n / 60` s. Players seek to the frame midpoint `(n + 0.5) / 60` s so floating-point
rounding never lands on the previous frame. Frame ranges (`start_frame`, `end_frame`) are
inclusive at both ends, for Rallies and Play Segments alike.
"""

from __future__ import annotations

import itertools
from collections.abc import Iterable
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


class Landmark(StrEnum):
    """A court-line intersection clicked to calibrate a Camera View.

    Near is the Main View camera's end; left and right are as seen from the Main View camera.
    """

    NEAR_BASELINE_LEFT = "near_baseline_left"
    NEAR_BASELINE_CENTRE = "near_baseline_centre"
    NEAR_BASELINE_RIGHT = "near_baseline_right"
    NEAR_KITCHEN_LEFT = "near_kitchen_left"
    NEAR_KITCHEN_CENTRE = "near_kitchen_centre"
    NEAR_KITCHEN_RIGHT = "near_kitchen_right"
    FAR_KITCHEN_LEFT = "far_kitchen_left"
    FAR_KITCHEN_CENTRE = "far_kitchen_centre"
    FAR_KITCHEN_RIGHT = "far_kitchen_right"
    FAR_BASELINE_LEFT = "far_baseline_left"
    FAR_BASELINE_CENTRE = "far_baseline_centre"
    FAR_BASELINE_RIGHT = "far_baseline_right"

    @property
    def court_point(self) -> CourtPoint:
        """Where this Landmark is on the court, in feet."""
        end, line, side = self.value.split("_")
        y = {"baseline": 22.0, "kitchen": 7.0}[line] * (-1 if end == "near" else 1)
        x = {"left": -10.0, "centre": 0.0, "right": 10.0}[side]
        return CourtPoint(x, y)


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
    """Live play from one Camera View, from `start_frame` to `end_frame` inclusive."""

    start_frame: int
    end_frame: int
    camera_view: CameraView

    def __post_init__(self) -> None:
        if self.start_frame < 0:
            raise ValueError(f"Play Segment cannot start before frame 0: {self.start_frame}")
        if self.end_frame < self.start_frame:
            raise ValueError(
                f"Play Segment ends (frame {self.end_frame}) before it starts "
                f"(frame {self.start_frame})"
            )

    def contains(self, frame: int) -> bool:
        return self.start_frame <= frame <= self.end_frame


def check_play_segments(segments: Iterable[PlaySegment]) -> None:
    """Raises ValueError if any two Play Segments share a frame."""
    ordered = sorted(segments, key=lambda s: s.start_frame)
    for before, after in itertools.pairwise(ordered):
        if after.start_frame <= before.end_frame:
            raise ValueError(
                f"Play Segments overlap: frames {before.start_frame}-{before.end_frame} "
                f"and {after.start_frame}-{after.end_frame}"
            )


@dataclass(frozen=True)
class ImagePoint:
    """A point in the video frame, in normalised image coordinates (0 to 1 across and down)."""

    x: float
    y: float


@dataclass(frozen=True)
class PlacedLandmark:
    """A Landmark clicked on a specific video frame, in normalised image coordinates (0 to 1)."""

    x: float
    y: float
    frame: int

    def __post_init__(self) -> None:
        if self.frame < 0:
            raise ValueError(f"Landmark frame cannot be negative: {self.frame}")
        if not (0 <= self.x <= 1 and 0 <= self.y <= 1):
            raise ValueError(f"Landmark point is outside the video frame: ({self.x}, {self.y})")

    @property
    def point(self) -> ImagePoint:
        return ImagePoint(self.x, self.y)

    @classmethod
    def at(cls, point: ImagePoint, frame: int) -> PlacedLandmark:
        return cls(point.x, point.y, frame)


@dataclass(frozen=True)
class Calibration:
    """Landmarks clicked in one Camera View, in effect from `effective_from_frame` on.

    The Calibration in effect at a frame is the latest of that frame's Camera View that starts at
    or before it, or else the earliest of that view. `reference_frame` is the frame the court
    mapping is anchored to; each placed Landmark records the `frame` it was clicked on, so clicks
    from other frames are mapped back to `reference_frame` via Camera Motion before fitting.
    `not_visible` records Landmarks deliberately marked as not visible in this Calibration.
    Only the clicked points are kept; the court mapping is fitted from them when needed.
    """

    camera_view: CameraView
    effective_from_frame: int
    reference_frame: int
    landmarks: dict[Landmark, PlacedLandmark] = field(default_factory=dict)
    not_visible: frozenset[Landmark] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        if self.effective_from_frame < 0 or self.reference_frame < 0:
            raise ValueError("Calibration frames cannot be negative")
        overlap = self.not_visible.intersection(self.landmarks)
        if overlap:
            names = ", ".join(sorted(lm.value for lm in overlap))
            raise ValueError(f"Landmarks cannot be both placed and not visible: {names}")

    @property
    def has_off_reference_landmarks(self) -> bool:
        """Whether any placed Landmark was clicked on a frame other than `reference_frame`."""
        return any(placed.frame != self.reference_frame for placed in self.landmarks.values())


def check_calibrations(calibrations: Iterable[Calibration]) -> None:
    """Raises ValueError if two Calibrations of one Camera View start at the same frame."""
    seen: set[tuple[CameraView, int]] = set()
    for calibration in calibrations:
        key = (calibration.camera_view, calibration.effective_from_frame)
        if key in seen:
            raise ValueError(
                f"two {calibration.camera_view} Calibrations start at frame "
                f"{calibration.effective_from_frame}"
            )
        seen.add(key)


@dataclass(frozen=True)
class SourceVideo:
    """Broadcast footage downloaded on disk for a Match.

    `path` points to the original downloaded file. Callers that play or index frames
    derive the constant 60 fps copy (`<stem>.60fps.mp4`) via
    `pb_tokei.convert.converted_path_for`.
    """

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
    calibrations: tuple[Calibration, ...] = ()

    def __post_init__(self) -> None:
        if self.team_a_id == self.team_b_id:
            raise ValueError("a Match needs two different Teams")
        check_play_segments(self.play_segments)
        check_calibrations(self.calibrations)

    def other_team_id(self, team_id: TeamId) -> TeamId:
        """The Receiving Team, given the Serving Team (and the other way round)."""
        if team_id == self.team_a_id:
            return self.team_b_id
        if team_id == self.team_b_id:
            return self.team_a_id
        raise ValueError(f"Team {team_id} is not in Match {self.id}")


@dataclass(frozen=True)
class MatchSummary:
    """A Match's roster, by name, without its Games: one line of a Match listing."""

    id: MatchId
    tournament: str
    team_a: tuple[str, str]
    team_b: tuple[str, str]
    franchise_a: str | None
    franchise_b: str | None
    source_video: SourceVideo | None
    franchise_match_id: FranchiseMatchId | None = None

    @property
    def has_video(self) -> bool:
        return self.source_video is not None
