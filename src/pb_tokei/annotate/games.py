"""HTTP models for a Match's Games, Rallies, Shots and Observation Gaps (`/games`).

Every fact travels as `{value, certainty}` with `value` null exactly when the certainty is
Unknown, and a Rally's entries as a list tagged `type: "shot"` or `type: "gap"`. No field has a
default, so requests and responses share one schema.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

from pb_tokei.rally_log import (
    Certainty,
    Challenge,
    ContactKind,
    CourtPoint,
    Error,
    ErrorKind,
    Fact,
    Game,
    ObservationGap,
    Parity,
    PlayerId,
    PlayerPosition,
    Rally,
    RallyStatus,
    RefereeCall,
    Ruling,
    Score,
    Shot,
    ShotClass,
    TeamId,
    WinnerSource,
    Zone,
)


class FactIO[T](BaseModel):
    """A value with how we know it; `value` is null exactly when `certainty` is unknown."""

    value: T | None
    certainty: Certainty

    @model_validator(mode="after")
    def _value_matches_certainty(self) -> FactIO[T]:
        if (self.value is None) != (self.certainty is Certainty.UNKNOWN):
            raise ValueError(f"a {self.certainty} fact cannot have value {self.value!r}")
        return self

    def to_domain[D](self, convert: Callable[[T], D]) -> Fact[D]:
        if self.value is None:
            return Fact(None, Certainty.UNKNOWN)
        return Fact(convert(self.value), self.certainty)

    @classmethod
    def from_domain(cls, fact: Fact[Any], convert: Callable[[Any], Any] = lambda v: v) -> Any:
        return cls(
            value=None if fact.value is None else convert(fact.value), certainty=fact.certainty
        )


def _same[T](value: T) -> T:
    return value


class CourtPointIO(BaseModel):
    """A court point in feet (origin at the centre of the net)."""

    x: float
    y: float


class ScoreIO(BaseModel):
    """The score called before a Rally: serving, receiving, server number."""

    serving: int = Field(ge=0)
    receiving: int = Field(ge=0)
    server_number: Literal[1, 2]


class PlayerPositionIO(BaseModel):
    position: FactIO[CourtPointIO]
    settled: FactIO[bool]


class ErrorIO(BaseModel):
    kind: FactIO[ErrorKind]
    player_id: FactIO[UUID]


class ShotIO(BaseModel):
    type: Literal["shot"]
    shot_number: FactIO[int]
    hitter_id: FactIO[UUID]
    contact_frame: FactIO[int]
    contact_zone: FactIO[Zone]
    shot_class: FactIO[ShotClass]
    contact_kind: FactIO[ContactKind]
    erne: FactIO[bool]
    atp: FactIO[bool]
    landing: FactIO[CourtPointIO]
    error: ErrorIO | None
    positions: dict[UUID, PlayerPositionIO]


class GapIO(BaseModel):
    """An Observation Gap: Shots that happened but were not seen, an odd or even number."""

    type: Literal["gap"]
    missing: Parity


class ChallengeIO(BaseModel):
    challenger_id: FactIO[UUID]
    original_call: FactIO[str]
    ruling: FactIO[Ruling]


EntryIO = Annotated[ShotIO | GapIO, Field(discriminator="type")]


class RallyIO(BaseModel):
    number: int = Field(ge=1)
    start_frame: int | None = Field(ge=0)
    end_frame: int | None = Field(ge=0)
    status: RallyStatus
    score: FactIO[ScoreIO]
    serving_team_id: FactIO[UUID]
    server_id: FactIO[UUID]
    returner_id: FactIO[UUID]
    referee_call: FactIO[RefereeCall]
    challenge: ChallengeIO | None
    winner_id: FactIO[UUID]
    winner_source: WinnerSource | None
    scoreboard_winner_id: FactIO[UUID]
    entries: list[EntryIO]


class GameIO(BaseModel):
    number: int = Field(ge=1)
    rallies: list[RallyIO]

    def to_domain(self) -> Game:
        return Game(self.number, tuple(_rally(r) for r in self.rallies))

    @classmethod
    def from_domain(cls, game: Game) -> GameIO:
        return GameIO(number=game.number, rallies=[_rally_io(r) for r in game.rallies])


def games_from_domain(games: Iterable[Game]) -> list[GameIO]:
    return [GameIO.from_domain(g) for g in games]


def frames_in(games: Iterable[GameIO]) -> Iterable[tuple[str, int]]:
    """Every frame the Games refer to, with what it is, for checking against the video."""
    for game in games:
        for rally in game.rallies:
            where = f"Game {game.number} Rally {rally.number}"
            if rally.start_frame is not None:
                yield f"{where} start", rally.start_frame
            if rally.end_frame is not None:
                yield f"{where} end", rally.end_frame
            for entry in rally.entries:
                if isinstance(entry, ShotIO) and entry.contact_frame.value is not None:
                    yield f"{where} Shot contact", entry.contact_frame.value


# --- Conversion ---------------------------------------------------------------------------


def _point(p: CourtPointIO) -> CourtPoint:
    return CourtPoint(p.x, p.y)


def _point_io(p: CourtPoint) -> CourtPointIO:
    return CourtPointIO(x=p.x, y=p.y)


def _score(s: ScoreIO) -> Score:
    return Score(s.serving, s.receiving, s.server_number)


def _score_io(s: Score) -> ScoreIO:
    return ScoreIO(serving=s.serving, receiving=s.receiving, server_number=s.server_number)


def _shot(s: ShotIO) -> Shot:
    return Shot(
        shot_number=s.shot_number.to_domain(_same),
        hitter_id=s.hitter_id.to_domain(PlayerId),
        contact_frame=s.contact_frame.to_domain(_same),
        contact_zone=s.contact_zone.to_domain(_same),
        shot_class=s.shot_class.to_domain(_same),
        contact_kind=s.contact_kind.to_domain(_same),
        erne=s.erne.to_domain(_same),
        atp=s.atp.to_domain(_same),
        landing=s.landing.to_domain(_point),
        error=None
        if s.error is None
        else Error(s.error.kind.to_domain(_same), s.error.player_id.to_domain(PlayerId)),
        positions={
            PlayerId(pid): PlayerPosition(p.position.to_domain(_point), p.settled.to_domain(_same))
            for pid, p in s.positions.items()
        },
    )


def _shot_io(s: Shot) -> ShotIO:
    return ShotIO(
        type="shot",
        shot_number=FactIO[int].from_domain(s.shot_number),
        hitter_id=FactIO[UUID].from_domain(s.hitter_id),
        contact_frame=FactIO[int].from_domain(s.contact_frame),
        contact_zone=FactIO[Zone].from_domain(s.contact_zone),
        shot_class=FactIO[ShotClass].from_domain(s.shot_class),
        contact_kind=FactIO[ContactKind].from_domain(s.contact_kind),
        erne=FactIO[bool].from_domain(s.erne),
        atp=FactIO[bool].from_domain(s.atp),
        landing=FactIO[CourtPointIO].from_domain(s.landing, _point_io),
        error=None
        if s.error is None
        else ErrorIO(
            kind=FactIO[ErrorKind].from_domain(s.error.kind),
            player_id=FactIO[UUID].from_domain(s.error.player_id),
        ),
        positions={
            pid: PlayerPositionIO(
                position=FactIO[CourtPointIO].from_domain(p.position, _point_io),
                settled=FactIO[bool].from_domain(p.settled),
            )
            for pid, p in s.positions.items()
        },
    )


def _rally(r: RallyIO) -> Rally:
    challenge = r.challenge
    return Rally(
        number=r.number,
        start_frame=r.start_frame,
        end_frame=r.end_frame,
        score=r.score.to_domain(_score),
        serving_team_id=r.serving_team_id.to_domain(TeamId),
        server_id=r.server_id.to_domain(PlayerId),
        returner_id=r.returner_id.to_domain(PlayerId),
        referee_call=r.referee_call.to_domain(_same),
        challenge=None
        if challenge is None
        else Challenge(
            challenger_id=challenge.challenger_id.to_domain(PlayerId),
            original_call=challenge.original_call.to_domain(_same),
            ruling=challenge.ruling.to_domain(_same),
        ),
        winner_id=r.winner_id.to_domain(TeamId),
        winner_source=r.winner_source,
        entries=tuple(
            _shot(e) if isinstance(e, ShotIO) else ObservationGap(e.missing) for e in r.entries
        ),
        scoreboard_winner_id=r.scoreboard_winner_id.to_domain(TeamId),
        status=r.status,
    )


def _rally_io(r: Rally) -> RallyIO:
    challenge = r.challenge
    return RallyIO(
        number=r.number,
        start_frame=r.start_frame,
        end_frame=r.end_frame,
        status=r.status,
        score=FactIO[ScoreIO].from_domain(r.score, _score_io),
        serving_team_id=FactIO[UUID].from_domain(r.serving_team_id),
        server_id=FactIO[UUID].from_domain(r.server_id),
        returner_id=FactIO[UUID].from_domain(r.returner_id),
        referee_call=FactIO[RefereeCall].from_domain(r.referee_call),
        challenge=None
        if challenge is None
        else ChallengeIO(
            challenger_id=FactIO[UUID].from_domain(challenge.challenger_id),
            original_call=FactIO[str].from_domain(challenge.original_call),
            ruling=FactIO[Ruling].from_domain(challenge.ruling),
        ),
        winner_id=FactIO[UUID].from_domain(r.winner_id),
        winner_source=r.winner_source,
        scoreboard_winner_id=FactIO[UUID].from_domain(r.scoreboard_winner_id),
        entries=[
            _shot_io(e) if isinstance(e, Shot) else GapIO(type="gap", missing=e.missing)
            for e in r.entries
        ],
    )
