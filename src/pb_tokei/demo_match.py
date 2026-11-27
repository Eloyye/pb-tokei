"""The synthetic three-Game Match shared by the demo command and stat tests."""

from __future__ import annotations

from dataclasses import replace

from pb_tokei.rally_log import (
    UNKNOWN,
    Challenge,
    CourtPoint,
    Error,
    ErrorKind,
    Game,
    Handedness,
    MatchId,
    MatchRoster,
    ObservationGap,
    Parity,
    Player,
    PlayerId,
    PlayerPosition,
    Rally,
    RallyLog,
    RallyStatus,
    Ruling,
    Score,
    Shot,
    ShotClass,
    TeamId,
    Tour,
    new_id,
    observed,
)
from pb_tokei.roster import Roster, RosterPlayer, set_up_match

DEMO_TOURNAMENT = "Synthetic Doubles Open"


def demo_games(roster: MatchRoster) -> tuple[Game, ...]:
    """Exercise every stat and Shot Type, plus long Rallies and missing observations."""
    a1, a2, b1, b2 = roster.players
    team_a, team_b = roster.team_a_id, roster.team_b_id

    def court(
        a1: tuple[float, float] = (-5, -7),
        a2: tuple[float, float] = (5, -7),
        b1: tuple[float, float] = (5, 7),
        b2: tuple[float, float] = (-5, 7),
    ) -> dict[PlayerId, PlayerPosition]:
        return {
            player.id: PlayerPosition(observed(CourtPoint(*point)))
            for player, point in zip(roster.players, (a1, a2, b1, b2), strict=True)
        }

    front = court()
    baseline = court(a1=(-5, -22), a2=(5, -22), b1=(5, 22))
    back = court(a1=(-5, -16), a2=(5, -17))
    soft, hard, lob, overhead = ShotClass.SOFT, ShotClass.HARD, ShotClass.LOB, ShotClass.OVERHEAD

    def hit(
        player: Player | None,
        shot_class: ShotClass = soft,
        positions: dict[PlayerId, PlayerPosition] | None = None,
        *,
        landing: CourtPoint | None = None,
        error: Error | None = None,
    ) -> Shot:
        return Shot(
            hitter_id=UNKNOWN if player is None else observed(player.id),
            shot_class=observed(shot_class),
            positions=front if positions is None else positions,
            landing=UNKNOWN if landing is None else observed(landing),
            error=error,
        )

    def fault(kind: ErrorKind, player: Player) -> Error:
        return Error(observed(kind), observed(player.id))

    def rally(
        *entries: Shot,
        winner: TeamId | None = None,
        server: Player = a1,
        returner: Player = b1,
    ) -> Rally:
        return Rally(
            number=1,
            entries=entries,
            serving_team_id=observed(roster.team_id_for(server.id)),
            server_id=observed(server.id),
            returner_id=observed(returner.id),
            winner_id=UNKNOWN if winner is None else observed(winner),
            status=RallyStatus.DONE,
        )

    def game(number: int, *rallies: Rally) -> Game:
        return Game(number, tuple(replace(r, number=i) for i, r in enumerate(rallies, start=1)))

    serve = hit(a1, hard, baseline, landing=CourtPoint(5, 20))
    start = (serve, hit(b1, soft, baseline, landing=CourtPoint(-5, -20)))
    drive_and_speedup = rally(
        *start,
        hit(a2, hard, back),
        hit(b1),
        hit(a1, positions=back),
        hit(b2),
        hit(a2, hard),
        hit(b1, hard),
        hit(a1, overhead, error=fault(ErrorKind.BODY_HIT, b2)),
    )
    lobs_and_reset = rally(
        *start,
        hit(a2, lob, back),
        hit(b1, overhead),
        hit(a1, positions=back),
        hit(b2, lob),
        hit(a2),
        winner=team_a,
    )
    popups = rally(*start, hit(a2), hit(b1), hit(a1, overhead), winner=team_a)
    challenge = replace(
        rally(replace(serve, error=fault(ErrorKind.OUT, a1)), winner=team_a),
        challenge=Challenge(observed(a1.id), ruling=observed(Ruling.OVERTURNED)),
        score=observed(Score(10, 8, 1)),
    )
    never_arrived = rally(*start, hit(a2, positions=back), hit(b1, positions=back), winner=team_b)
    kitchen = replace(
        rally(*start, hit(a2, error=fault(ErrorKind.KITCHEN_FAULT, a2))),
        score=observed(Score(9, 10, 1)),
    )

    other_serve = hit(b1, hard, baseline, landing=CourtPoint(-5, -20))
    other_return = hit(a2, soft, baseline, landing=CourtPoint(5, 20))
    long_rally = replace(
        rally(
            other_serve,
            other_return,
            hit(b2),
            hit(a1),
            hit(b1),
            hit(a2),
            hit(b2, hard),
            hit(a1, hard),
            hit(b1),
            hit(a2),
            hit(b2),
            winner=team_b,
            server=b1,
            returner=a2,
        ),
        score=observed(Score(10, 7, 1)),
    )
    return_error = rally(
        other_serve,
        replace(other_return, error=fault(ErrorKind.NET, a2)),
        server=b1,
        returner=a2,
    )
    partial = Rally(
        number=1,
        entries=(ObservationGap(Parity.ODD), hit(b2, positions={}), hit(None, positions={})),
        status=RallyStatus.IN_PROGRESS,
    )
    return (
        game(1, drive_and_speedup, challenge),
        game(2, lobs_and_reset, never_arrived, return_error, long_rally),
        game(3, popups, Rally(number=1), partial, kitchen),
    )


def write_demo_match(log: RallyLog) -> MatchId:
    """Append the demo to a Rally Log using a fresh Match ID."""
    names = Roster(
        match_id=MatchId(new_id()),
        tournament=DEMO_TOURNAMENT,
        tour=Tour.PPA,
        team_a=(
            RosterPlayer("Alex One", Handedness.RIGHT),
            RosterPlayer("Avery Two", Handedness.LEFT),
        ),
        team_b=(
            RosterPlayer("Blake One", Handedness.RIGHT),
            RosterPlayer("Brook Two", Handedness.RIGHT),
        ),
    )
    with log.transaction():
        match = set_up_match(log, names)
        log.replace_games(match.id, demo_games(log.get_match_roster(match.id)))
    return match.id
