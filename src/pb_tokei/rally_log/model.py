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

import datetime
import itertools
import math
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal, NewType, TypeGuard
from uuid import UUID, uuid4

PlayerId = NewType("PlayerId", UUID)
TeamId = NewType("TeamId", UUID)
TournamentId = NewType("TournamentId", UUID)
FranchiseId = NewType("FranchiseId", UUID)
FranchiseMatchId = NewType("FranchiseMatchId", UUID)
MatchId = NewType("MatchId", UUID)

BROADCAST_FPS = 60
ASSISTED_RATIO_BUDGET = 0.25


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


class Gender(StrEnum):
    MALE = "male"
    FEMALE = "female"


class Discipline(StrEnum):
    """Derived doubles category of a Team or Match (ADR 0003; never stored)."""

    MENS_DOUBLES = "mens_doubles"
    WOMENS_DOUBLES = "womens_doubles"
    MIXED_DOUBLES = "mixed_doubles"

    @property
    def label(self) -> str:
        return _DISCIPLINE_LABELS[self]


_DISCIPLINE_LABELS: dict[Discipline, str] = {
    Discipline.MENS_DOUBLES: "Men's Doubles",
    Discipline.WOMENS_DOUBLES: "Women's Doubles",
    Discipline.MIXED_DOUBLES: "Mixed Doubles",
}


def team_discipline(genders: tuple[Gender | None, Gender | None]) -> Discipline | None:
    """Derives a Team's Discipline from its two Players' genders, or None if either is unset."""
    first, second = genders
    if first is None or second is None:
        return None
    if first is second:
        return Discipline.MENS_DOUBLES if first is Gender.MALE else Discipline.WOMENS_DOUBLES
    return Discipline.MIXED_DOUBLES


def lineup_conflict(
    team_a: tuple[Gender | None, Gender | None],
    team_b: tuple[Gender | None, Gender | None],
) -> tuple[Discipline, Discipline] | None:
    """Returns `(disc_a, disc_b)` when both Teams are fully gendered with incompatible Disciplines.

    Partial lineups (where at least one Player has `gender = None`, including e.g. `(male, male)`
    vs `(female, None)`) return `None` until all four Players are gendered.
    """
    disc_a = team_discipline(team_a)
    disc_b = team_discipline(team_b)
    if disc_a is None or disc_b is None or disc_a is disc_b:
        return None
    return (disc_a, disc_b)


def check_match_lineup(
    team_a: tuple[Gender | None, Gender | None],
    team_b: tuple[Gender | None, Gender | None],
) -> Discipline | None:
    """Validates a Match's four-Player gender lineup.

    Returns the derived Discipline when all four Players have compatible genders, returns None
    for any partial lineup (when at least one Player has `gender = None`, including e.g.
    `(male, male)` vs `(female, None)`, until all four Players are gendered), and raises
    `ValueError` when a fully-gendered Match does not form Men's Doubles, Women's Doubles, or
    Mixed Doubles.
    """
    conflict = lineup_conflict(team_a, team_b)
    if conflict is not None:
        disc_a, disc_b = conflict
        raise ValueError(
            f"Invalid Match lineup: {disc_a.label} vs {disc_b.label} "
            "(must be Men's Doubles, Women's Doubles, or Mixed Doubles)"
        )
    disc_a = team_discipline(team_a)
    disc_b = team_discipline(team_b)
    return disc_a if disc_a is not None and disc_b is not None else None


def match_discipline(
    team_a: tuple[Gender | None, Gender | None],
    team_b: tuple[Gender | None, Gender | None],
) -> Discipline | None:
    """Derives a Match's Discipline when all four Players have compatible genders, else None."""
    try:
        return check_match_lineup(team_a, team_b)
    except ValueError:
        return None


class Zone(StrEnum):
    FRONTCOURT = "frontcourt"
    MIDCOURT = "midcourt"
    BACKCOURT = "backcourt"


FRONTCOURT_MAX_Y_FT = 9.0
"""Inclusive outer boundary of the Frontcourt, in feet from the net (kitchen 7 ft + 2 ft)."""

MIDCOURT_MAX_Y_FT = 18.0
"""Inclusive outer boundary of the Midcourt, in feet from the net."""


def zone_for_y(y_ft: float) -> Zone:
    """Zone for a court `y` coordinate in feet, with inclusive inner bounds."""
    dist = abs(y_ft)
    if dist <= FRONTCOURT_MAX_Y_FT:
        return Zone.FRONTCOURT
    if dist <= MIDCOURT_MAX_Y_FT:
        return Zone.MIDCOURT
    return Zone.BACKCOURT


def zone_for_point(point: CourtPoint) -> Zone:
    """Zone for a `CourtPoint`, ignoring lateral position."""
    return zone_for_y(point.y)


class AnchorKind(StrEnum):
    """How an operator anchored a Player on a frame.

    `identity` binds the Player to the detected person box containing the click and uses its
    detected foot point; `position` overrides the Player's foot position directly without snapping
    back to a detection box.
    """

    IDENTITY = "identity"
    POSITION = "position"


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


class RallyStatus(StrEnum):
    """How far an operator has got annotating a Rally (workflow state, ignored by Event
    Processing; ADR 0013)."""

    EMPTY = "empty"
    IN_PROGRESS = "in_progress"
    DONE = "done"


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
    gender: Gender | None = None


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
class PlayerPosition:
    """One Player's court position and Settled fact at a Shot's contact."""

    position: Fact[CourtPoint] = _unknown()
    settled: Fact[bool] = _unknown()


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
    positions: dict[PlayerId, PlayerPosition] = field(default_factory=dict)


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
    # The winner shown by the broadcast scoreboard, kept apart from `winner_id` so a Referee
    # Call and the scoreboard can be compared (ADR 0013).
    scoreboard_winner_id: Fact[TeamId] = _unknown()
    status: RallyStatus = RallyStatus.EMPTY

    @property
    def shots(self) -> tuple[Shot, ...]:
        return tuple(e for e in self.entries if isinstance(e, Shot))


@dataclass(frozen=True)
class Game:
    number: int  # 1-based within its Match
    rallies: tuple[Rally, ...] = ()


MAX_STORED_INT = 2**31 - 1
"""The largest number the Rally Log's INTEGER columns hold (frames, numbers, scores)."""


class RosterMismatchError(ValueError):
    """A Player or Team id does not belong to the Match."""


def check_games(games: Iterable[Game], roster: MatchRoster) -> None:
    """Raises ValueError unless the Games fit the Match: unique positive Game and Rally numbers,
    frame bounds in order, every number small enough to store, and every Team and Player one of
    the Match's."""
    teams = {roster.team_a_id, roster.team_b_id}

    def storable(value: int | None, what: str) -> None:
        if value is not None and value > MAX_STORED_INT:
            raise ValueError(f"{what} is too large to store: {value}")

    players = roster.player_ids
    game_numbers: set[int] = set()

    def team(fact: Fact[TeamId], what: str) -> None:
        if fact.value is not None and fact.value not in teams:
            raise RosterMismatchError(
                f"{what}: Team {fact.value} is not in Match {roster.match_id}"
            )

    def player(fact: Fact[PlayerId], what: str) -> None:
        if fact.value is not None and fact.value not in players:
            raise RosterMismatchError(
                f"{what}: Player {fact.value} is not in Match {roster.match_id}"
            )

    for game in games:
        if game.number < 1:
            raise ValueError(f"Game number must be 1 or more: {game.number}")
        storable(game.number, "Game number")
        if game.number in game_numbers:
            raise ValueError(f"two Games numbered {game.number}")
        game_numbers.add(game.number)
        rally_numbers: set[int] = set()
        for rally in game.rallies:
            where = f"Game {game.number} Rally {rally.number}"
            if rally.number < 1:
                raise ValueError(f"Rally number must be 1 or more: {where}")
            storable(rally.number, f"{where} number")
            storable(rally.start_frame, f"{where} start frame")
            storable(rally.end_frame, f"{where} end frame")
            score = rally.score.value
            if score is not None:
                storable(score.serving, f"{where} serving score")
                storable(score.receiving, f"{where} receiving score")
            if rally.number in rally_numbers:
                raise ValueError(f"two Rallies numbered {rally.number} in Game {game.number}")
            rally_numbers.add(rally.number)
            if rally.start_frame is not None and rally.start_frame < 0:
                raise ValueError(f"{where} cannot start before frame 0: {rally.start_frame}")
            if rally.end_frame is not None:
                if rally.start_frame is None:
                    raise ValueError(f"{where} has an end frame but no start frame")
                if rally.end_frame < rally.start_frame:
                    raise ValueError(
                        f"{where} ends (frame {rally.end_frame}) before it starts "
                        f"(frame {rally.start_frame})"
                    )
            team(rally.serving_team_id, f"{where} Serving Team")
            team(rally.winner_id, f"{where} winner")
            team(rally.scoreboard_winner_id, f"{where} scoreboard winner")
            player(rally.server_id, f"{where} Server")
            player(rally.returner_id, f"{where} Returner")
            if rally.challenge is not None:
                player(rally.challenge.challenger_id, f"{where} challenger")
            for shot in rally.shots:
                frame = shot.contact_frame.value
                if frame is not None and frame < 0:
                    raise ValueError(f"{where} has a Shot before frame 0: {frame}")
                storable(frame, f"{where} Shot contact frame")
                storable(shot.shot_number.value, f"{where} Shot Number")
                player(shot.hitter_id, f"{where} hitter")
                if shot.error is not None:
                    player(shot.error.player_id, f"{where} Error")
                for player_id in shot.positions:
                    if player_id not in players:
                        raise RosterMismatchError(
                            f"{where} position: Player {player_id} is not in Match "
                            f"{roster.match_id}"
                        )


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


_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MIN_MATCH_YEAR = 1000
"""Minimum valid Match year, matching the UI's inline date input (which ignores partial years)."""


def is_calendar_date(value: object) -> TypeGuard[datetime.date]:
    """Whether `value` is a `datetime.date` and not a `datetime.datetime`."""
    return isinstance(value, datetime.date) and not isinstance(value, datetime.datetime)


def check_match_date(value: datetime.date | None, *, required: bool = False) -> None:
    if value is None:
        if required:
            raise ValueError("Match date cannot be cleared")
        return
    if not is_calendar_date(value):
        raise ValueError("Match date must be a calendar date")
    if value.year < MIN_MATCH_YEAR:
        raise ValueError(f"Match date year must be {MIN_MATCH_YEAR} or later, not {value.year}")


def parse_match_date(value: str) -> datetime.date:
    """Parses a calendar date in strict YYYY-MM-DD format (4-digit year >= 1000)."""
    if not isinstance(value, str) or not _ISO_DATE_RE.fullmatch(value):
        raise ValueError(f"Match date must be YYYY-MM-DD, not {value!r}")
    try:
        parsed = datetime.date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"Invalid Match date: {value!r}") from None
    check_match_date(parsed, required=True)
    return parsed


def check_video_frames(frames: int | None) -> None:
    if frames is not None and frames <= 0:
        raise ValueError("Source video frame count must be positive")


class AnnotationMode(StrEnum):
    GOLD = "gold"
    ASSISTED = "assisted"


class OperatorWorkspace(StrEnum):
    CALIBRATE = "calibrate"
    ANNOTATE = "annotate"
    REVIEW = "review"


@dataclass(frozen=True)
class OperatorSession:
    """The cumulative active time recorded during one visit to a Match workspace."""

    session_id: UUID
    workspace: OperatorWorkspace
    started_at: datetime.datetime
    ended_at: datetime.datetime
    active_seconds: float

    def __post_init__(self) -> None:
        if not math.isfinite(self.active_seconds) or self.active_seconds < 0:
            raise ValueError("Operator session active time must be finite and nonnegative")
        if self.started_at.utcoffset() is None or self.ended_at.utcoffset() is None:
            raise ValueError("Operator session timestamps require a time zone")
        try:
            start = self.started_at.astimezone(UTC)
            end = self.ended_at.astimezone(UTC)
        except OverflowError:
            raise ValueError("Operator session timestamps must be representable in UTC") from None
        if end < start:
            raise ValueError("Operator session cannot end before it starts")
        if self.active_seconds > (end - start).total_seconds():
            raise ValueError("Operator session active time cannot exceed its elapsed time")
        object.__setattr__(self, "started_at", start)
        object.__setattr__(self, "ended_at", end)


@dataclass(frozen=True)
class OperatorTimeSummary:
    calibrate_seconds: float = 0.0
    annotate_seconds: float = 0.0
    review_seconds: float = 0.0

    @property
    def total_seconds(self) -> float:
        return self.calibrate_seconds + self.annotate_seconds + self.review_seconds


@dataclass(frozen=True)
class PlayerAnchor:
    """An operator-placed anchor for one Player on one frame, in normalised image coordinates."""

    frame: int
    player_id: PlayerId
    kind: AnchorKind
    image_x: float
    image_y: float

    def __post_init__(self) -> None:
        if self.frame < 0:
            raise ValueError(f"Player anchor frame cannot be negative: {self.frame}")
        if not (
            math.isfinite(self.image_x)
            and math.isfinite(self.image_y)
            and 0.0 <= self.image_x <= 1.0
            and 0.0 <= self.image_y <= 1.0
        ):
            raise ValueError(
                f"Player anchor point is outside the video frame: ({self.image_x}, {self.image_y})"
            )

    @property
    def point(self) -> ImagePoint:
        return ImagePoint(self.image_x, self.image_y)


def check_player_anchors(anchors: Iterable[PlayerAnchor]) -> None:
    """Raises ValueError if two anchors target the same Player on the same frame."""
    seen: set[tuple[int, PlayerId]] = set()
    for anchor in anchors:
        key = (anchor.frame, anchor.player_id)
        if key in seen:
            raise ValueError(f"two anchors for Player {anchor.player_id} on frame {anchor.frame}")
        seen.add(key)


@dataclass(frozen=True)
class TeamEnd:
    """Which Team plays at the near end (y < 0, Main View end) from `effective_from_frame`."""

    effective_from_frame: int
    near_team_id: TeamId

    def __post_init__(self) -> None:
        if self.effective_from_frame < 0:
            raise ValueError(f"Team end frame cannot be negative: {self.effective_from_frame}")


def check_team_ends(team_ends: Iterable[TeamEnd]) -> None:
    """Raises ValueError if two TeamEnd records start at the same frame."""
    seen: set[int] = set()
    for team_end in team_ends:
        if team_end.effective_from_frame in seen:
            raise ValueError(f"two TeamEnd records start at frame {team_end.effective_from_frame}")
        seen.add(team_end.effective_from_frame)


def team_end_at(team_ends: Iterable[TeamEnd], frame: int) -> TeamEnd | None:
    """The TeamEnd in effect at `frame`: latest starting at or before it, or else the earliest."""
    ordered = sorted(team_ends, key=lambda te: te.effective_from_frame)
    started = [te for te in ordered if te.effective_from_frame <= frame]
    if started:
        return started[-1]
    return ordered[0] if ordered else None


@dataclass(frozen=True)
class MatchRoster:
    """The two Teams and four Players of a Match, each Team's Players in name order."""

    match_id: MatchId
    team_a_id: TeamId
    team_b_id: TeamId
    team_a_players: tuple[Player, Player]
    team_b_players: tuple[Player, Player]

    @property
    def players(self) -> tuple[Player, Player, Player, Player]:
        return (*self.team_a_players, *self.team_b_players)

    @property
    def player_ids(self) -> frozenset[PlayerId]:
        return frozenset(p.id for p in self.players)

    def team_genders(
        self, overrides: Mapping[PlayerId, Gender | None] | None = None
    ) -> tuple[tuple[Gender | None, Gender | None], tuple[Gender | None, Gender | None]]:
        """Returns `(team_a_genders, team_b_genders)` with optional per-Player gender overrides."""
        if not overrides:
            return (
                (self.team_a_players[0].gender, self.team_a_players[1].gender),
                (self.team_b_players[0].gender, self.team_b_players[1].gender),
            )
        return (
            (
                overrides.get(self.team_a_players[0].id, self.team_a_players[0].gender),
                overrides.get(self.team_a_players[1].id, self.team_a_players[1].gender),
            ),
            (
                overrides.get(self.team_b_players[0].id, self.team_b_players[0].gender),
                overrides.get(self.team_b_players[1].id, self.team_b_players[1].gender),
            ),
        )

    @property
    def discipline(self) -> Discipline | None:
        return match_discipline(*self.team_genders())

    def team_id_for(self, player_id: PlayerId) -> TeamId:
        if any(p.id == player_id for p in self.team_a_players):
            return self.team_a_id
        if any(p.id == player_id for p in self.team_b_players):
            return self.team_b_id
        raise ValueError(f"Player {player_id} is not in Match {self.match_id}")

    def team_players(self, team_id: TeamId) -> tuple[Player, Player]:
        if team_id == self.team_a_id:
            return self.team_a_players
        if team_id == self.team_b_id:
            return self.team_b_players
        raise ValueError(f"Team {team_id} is not in Match {self.match_id}")

    def other_team_id(self, team_id: TeamId) -> TeamId:
        if team_id == self.team_a_id:
            return self.team_b_id
        if team_id == self.team_b_id:
            return self.team_a_id
        raise ValueError(f"Team {team_id} is not in Match {self.match_id}")


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
    player_anchors: tuple[PlayerAnchor, ...] = ()
    team_ends: tuple[TeamEnd, ...] = ()
    annotation_mode: AnnotationMode = AnnotationMode.GOLD
    source_video_frames: int | None = None
    date: datetime.date | None = None

    def __post_init__(self) -> None:
        if self.team_a_id == self.team_b_id:
            raise ValueError("a Match needs two different Teams")
        check_match_date(self.date)
        check_video_frames(self.source_video_frames)
        if self.source_video_frames is not None and self.source_video is None:
            raise ValueError("Source video frames require a recorded source video")
        check_play_segments(self.play_segments)
        check_calibrations(self.calibrations)
        check_player_anchors(self.player_anchors)
        check_team_ends(self.team_ends)
        for team_end in self.team_ends:
            if team_end.near_team_id not in (self.team_a_id, self.team_b_id):
                raise ValueError(f"Team {team_end.near_team_id} is not in Match {self.id}")

    def other_team_id(self, team_id: TeamId) -> TeamId:
        """The Receiving Team, given the Serving Team (and the other way round)."""
        if team_id == self.team_a_id:
            return self.team_b_id
        if team_id == self.team_b_id:
            return self.team_a_id
        raise ValueError(f"Team {team_id} is not in Match {self.id}")


@dataclass(frozen=True, slots=True)
class MatchMetadata:
    """The competition metadata of a Match, without its Games."""

    id: MatchId
    tournament_id: TournamentId
    franchise_match_id: FranchiseMatchId | None
    date: datetime.date | None


@dataclass(frozen=True, slots=True)
class MatchGames(MatchMetadata):
    """A read-only snapshot of a Match's Games and competition metadata."""

    games: tuple[Game, ...]


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
    date: datetime.date | None = field(default=None, kw_only=True)
    annotation_mode: AnnotationMode = field(default=AnnotationMode.GOLD, kw_only=True)
    source_video_frames: int | None = field(default=None, kw_only=True)
    operator_time: OperatorTimeSummary = field(default_factory=OperatorTimeSummary, kw_only=True)
    franchise_match_id: FranchiseMatchId | None = None
    discipline: Discipline | None = field(default=None, kw_only=True)
    done_rallies: int = 0
    total_rallies: int = 0

    @property
    def has_video(self) -> bool:
        return self.source_video is not None

    @property
    def broadcast_seconds(self) -> float | None:
        return (
            None if self.source_video_frames is None else self.source_video_frames / BROADCAST_FPS
        )

    @property
    def active_seconds(self) -> float:
        return self.operator_time.total_seconds

    @property
    def operator_time_ratio(self) -> float | None:
        broadcast = self.broadcast_seconds
        return None if broadcast is None else self.active_seconds / broadcast
