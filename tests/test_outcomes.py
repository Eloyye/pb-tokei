"""Shot Outcome rules on small hand-built Rallies (issue #17)."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from pb_tokei.events import (
    DerivedRally,
    OutcomeReason,
    ShotJudgment,
    ShotOutcome,
    ShotType,
    derive_rally,
    judge_rally,
    judge_shot,
)
from pb_tokei.rally_log import (
    UNKNOWN,
    Challenge,
    ContactKind,
    CourtPoint,
    Error,
    ErrorKind,
    Handedness,
    MatchId,
    MatchRoster,
    ObservationGap,
    Parity,
    Player,
    PlayerId,
    PlayerPosition,
    Rally,
    Ruling,
    Shot,
    ShotClass,
    TeamId,
    Zone,
    inferred,
    new_id,
    observed,
)

A1 = Player(PlayerId(new_id()), "Alex One", Handedness.RIGHT)
A2 = Player(PlayerId(new_id()), "Avery Two", Handedness.LEFT)
B1 = Player(PlayerId(new_id()), "Blake One", Handedness.RIGHT)
B2 = Player(PlayerId(new_id()), "Brook Two", Handedness.RIGHT)
TEAM_A = TeamId(new_id())  # plays at the near end (y < 0)
TEAM_B = TeamId(new_id())
ROSTER = MatchRoster(MatchId(new_id()), TEAM_A, TEAM_B, (A1, A2), (B1, B2))

SOFT, HARD, LOB, OVERHEAD = ShotClass.SOFT, ShotClass.HARD, ShotClass.LOB, ShotClass.OVERHEAD
FRONT, MID, BACK = Zone.FRONTCOURT, Zone.MIDCOURT, Zone.BACKCOURT
ODD = ObservationGap(Parity.ODD)
ADV, NEU, DIS = ShotOutcome.ADVANTAGE, ShotOutcome.NEUTRAL, ShotOutcome.DISADVANTAGE
R = OutcomeReason


def court(
    a1: float | None = None,
    a2: float | None = None,
    b1: float | None = None,
    b2: float | None = None,
) -> dict[PlayerId, PlayerPosition]:
    """Players at these distances from the net (Team A at the near end); None leaves one out."""
    positions = {}
    for player, depth, sign in ((A1, a1, -1), (A2, a2, -1), (B1, b1, 1), (B2, b2, 1)):
        if depth is not None:
            positions[player.id] = PlayerPosition(observed(CourtPoint(0.0, sign * depth)))
    return positions


ALL_FRONT = court(5, 5, 5, 5)


def hit(
    hitter: Player | None,
    shot_class: ShotClass | None = None,
    zone: Zone | None = None,
    *,
    positions: dict[PlayerId, PlayerPosition] | None = None,
    landing: CourtPoint | None = None,
    error: Error | None = None,
    kind: ContactKind | None = None,
) -> Shot:
    return Shot(
        hitter_id=UNKNOWN if hitter is None else observed(hitter.id),
        contact_zone=UNKNOWN if zone is None else observed(zone),
        shot_class=UNKNOWN if shot_class is None else inferred(shot_class),
        contact_kind=UNKNOWN if kind is None else observed(kind),
        landing=UNKNOWN if landing is None else observed(landing),
        error=error,
        positions=ALL_FRONT if positions is None else positions,
    )


def dink(hitter: Player, *, error: Error | None = None) -> Shot:
    """A Soft Shot from the Frontcourt with everyone at the net (a Dink or a Block)."""
    return hit(hitter, SOFT, FRONT, error=error)


def bang(hitter: Player, *, error: Error | None = None) -> Shot:
    """A Hard Shot from the Frontcourt with everyone at the net (a Speedup or a Counter)."""
    return hit(hitter, HARD, FRONT, error=error)


def lob(
    hitter: Player, zone: Zone = FRONT, *, positions: dict[PlayerId, PlayerPosition] | None = None
) -> Shot:
    return hit(hitter, LOB, zone, positions=positions)


def smash(hitter: Player, zone: Zone = FRONT, *, error: Error | None = None) -> Shot:
    return hit(hitter, OVERHEAD, zone, error=error)


def net(player: Player) -> Error:
    return Error(kind=observed(ErrorKind.NET), player_id=observed(player.id))


def serve(landing_ft: float = 20.0) -> Shot:
    """A Hard Serve by A1 landing `landing_ft` from the net on Team B's side."""
    return hit(A1, HARD, BACK, landing=CourtPoint(0.0, landing_ft), positions={})


def ret(
    landing_ft: float = 20.0, shot_class: ShotClass = HARD, *, error: Error | None = None
) -> Shot:
    """A Return by B1 landing `landing_ft` from the net on Team A's side."""
    landing = CourtPoint(0.0, -landing_ft)
    return hit(B1, shot_class, BACK, landing=landing, positions={}, error=error)


OPENING = (serve(), ret())
"""A deep Serve and a deep Return; the third Shot is Team A's."""

OVERTURNED = Challenge(challenger_id=observed(A1.id), ruling=observed(Ruling.OVERTURNED))


@dataclass(frozen=True)
class Case:
    entries: tuple[Shot | ObservationGap, ...]
    shot_index: int
    outcome: ShotOutcome | None
    reason: OutcomeReason | None
    winner: TeamId | None = None
    challenge: Challenge | None = None
    shot_type: ShotType | None = None
    """The Shot Type the judged Shot must have, to keep each case honest about its row."""

    def derive(self) -> DerivedRally:
        rally = Rally(
            number=1,
            entries=self.entries,
            winner_id=UNKNOWN if self.winner is None else observed(self.winner),
            challenge=self.challenge,
        )
        return derive_rally(rally, ROSTER)


def case(
    *entries: Shot | ObservationGap,
    judge: int,
    expect: tuple[ShotOutcome | None, OutcomeReason | None],
    winner: TeamId | None = None,
    challenge: Challenge | None = None,
    shot_type: ShotType | None = None,
) -> Case:
    outcome, reason = expect
    return Case(entries, judge, outcome, reason, winner, challenge, shot_type)


UNDECIDED = (None, None)

CASES: dict[str, Case] = {
    # --- Check 2: rally-ending --------------------------------------------------------------
    "winner": case(*OPENING, bang(A2), judge=2, expect=(ADV, R.WINNER), winner=TEAM_A),
    "winner of unknown shot type": case(
        *OPENING, hit(A2), judge=2, expect=(ADV, R.WINNER), winner=TEAM_A
    ),
    "own error": case(
        *OPENING, bang(A2, error=net(A2)), judge=2, expect=(DIS, R.ERROR), winner=TEAM_B
    ),
    "own error by an overturned call": case(
        *OPENING, bang(A2), judge=2, expect=(DIS, R.ERROR), winner=TEAM_B, challenge=OVERTURNED
    ),
    "overhead's own error": case(
        *OPENING,
        dink(A2),
        smash(B1, error=net(B1)),
        judge=3,
        expect=(DIS, R.ERROR),
        winner=TEAM_A,
        shot_type=ShotType.OVERHEAD,
    ),
    "reply error": case(
        serve(), ret(error=net(B1)), judge=0, expect=(ADV, R.REPLY_ERROR), winner=TEAM_A
    ),
    "reply winner": case(serve(), ret(), judge=0, expect=(DIS, R.REPLY_WINNER), winner=TEAM_B),
    "deep return whose third shot is a winner": case(
        *OPENING, bang(A2), judge=1, expect=(DIS, R.REPLY_WINNER), winner=TEAM_A
    ),
    # --- Check 3: Popup ---------------------------------------------------------------------
    "popup by an overhead": case(
        *OPENING, dink(A2), smash(B1), dink(A1), judge=2, expect=(DIS, R.POPUP)
    ),
    "popup by a failed overhead": case(
        *OPENING,
        dink(A2),
        smash(B1, error=net(B1)),
        judge=2,
        expect=(DIS, R.POPUP),
        winner=TEAM_A,
    ),
    "popup by a put-away": case(
        *OPENING,
        dink(A2),
        bang(B1),
        dink(A1, error=net(A1)),
        judge=2,
        expect=(DIS, R.POPUP),
        winner=TEAM_B,
    ),
    "soft return popup": case(
        serve(),
        ret(shot_class=SOFT),
        smash(A2, BACK),
        dink(B1),
        dink(A1),
        judge=1,
        expect=(DIS, R.POPUP),
    ),
    "serve is never a popup": case(
        hit(A1, SOFT, BACK, landing=CourtPoint(0.0, 20.0), positions={}),
        hit(B1, OVERHEAD, BACK, positions={}),
        dink(A2),
        judge=0,
        expect=(ADV, R.DEEP_SERVE),
    ),
    # --- Check 4: mirrored attack exchange --------------------------------------------------
    "attacked and the attack won": case(
        *OPENING,
        dink(A2),
        bang(B1),
        bang(A1),
        bang(B2),
        judge=2,
        expect=(DIS, R.ATTACK_WON),
        winner=TEAM_B,
    ),
    "attacked and the attack lost": case(
        *OPENING, dink(A2), bang(B1), bang(A1), judge=2, expect=(ADV, R.ATTACK_LOST), winner=TEAM_A
    ),
    "attacked and the attack neutralised": case(
        *OPENING,
        dink(A2),
        bang(B1),
        dink(A1),
        dink(B2),
        dink(A2),
        judge=2,
        expect=(NEU, R.ATTACK_NEUTRALISED),
    ),
    "lob pushes the overhead back": case(
        *OPENING,
        lob(A2),
        smash(B1, MID),
        hit(A1, SOFT, MID),
        dink(B2),
        dink(A2),
        judge=2,
        expect=(ADV, R.LOB_PUSHED_BACK),
    ),
    "lob answered from the frontcourt stays neutral": case(
        *OPENING,
        lob(A2),
        smash(B1, FRONT),
        hit(A1, SOFT, MID),
        dink(B2),
        dink(A2),
        judge=2,
        expect=(NEU, R.ATTACK_NEUTRALISED),
    ),
    "lob answered from an unknown zone": case(
        *OPENING,
        lob(A2),
        hit(B1, OVERHEAD, positions={}),
        hit(A1, SOFT, MID),
        dink(B2),
        dink(A2),
        judge=2,
        expect=UNDECIDED,
    ),
    "attack exchange cut by an observation gap": case(
        *OPENING, dink(A2), bang(B1), bang(A1), ODD, dink(B2), judge=2, expect=UNDECIDED
    ),
    "return never mirrors the third shot's exchange": case(
        serve(),
        ret(shot_class=SOFT),
        hit(A2, HARD, BACK),
        bang(B1),
        bang(A2),
        judge=1,
        expect=(ADV, R.DEEP_RETURN),
        winner=TEAM_A,
    ),
    # --- Check 5: Serve and Return depth ----------------------------------------------------
    "deep serve": case(*OPENING, dink(A2), judge=0, expect=(ADV, R.DEEP_SERVE)),
    "midcourt serve": case(serve(12), ret(), dink(A2), judge=0, expect=(NEU, R.MIDCOURT_SERVE)),
    "short serve": case(serve(8), ret(), dink(A2), judge=0, expect=(DIS, R.SHORT_SERVE)),
    "serve with no landing": case(
        hit(A1, HARD, BACK, positions={}), ret(), dink(A2), judge=0, expect=UNDECIDED
    ),
    "deep return": case(*OPENING, dink(A2), dink(B2), judge=1, expect=(ADV, R.DEEP_RETURN)),
    "midcourt return": case(
        serve(), ret(9.5), dink(A2), dink(B2), judge=1, expect=(NEU, R.MIDCOURT_RETURN)
    ),
    "short return in the kitchen": case(
        serve(), ret(5), dink(A2), dink(B2), judge=1, expect=(DIS, R.SHORT_RETURN)
    ),
    "return with no landing": case(
        serve(), hit(B1, HARD, BACK, positions={}), dink(A2), judge=1, expect=UNDECIDED
    ),
    # --- Check 5: Drop ----------------------------------------------------------------------
    "drop then established": case(
        *OPENING,
        hit(A2, SOFT, MID, positions=court(20, 15, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(12, 10, 5, 5)),
        hit(A1, SOFT, FRONT, positions=court(5, 5, 5, 5)),
        dink(B2),
        judge=2,
        expect=(ADV, R.ESTABLISHED_AT_FOLLOW_UP),
        shot_type=ShotType.DROP,
    ),
    "drop then split from back": case(
        *OPENING,
        hit(A2, SOFT, MID, positions=court(20, 15, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(15, 10, 5, 5)),
        hit(A1, SOFT, MID, positions=court(15, 5, 5, 5)),
        dink(B2),
        judge=2,
        expect=(ADV, R.TEAM_MOVED_UP),
        shot_type=ShotType.DROP,
    ),
    "drop with no gain": case(
        *OPENING,
        hit(A2, SOFT, MID, positions=court(20, 15, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(20, 15, 5, 5)),
        hit(A1, SOFT, MID, positions=court(18, 15, 5, 5)),
        dink(B2),
        judge=2,
        expect=(NEU, R.NO_GAIN),
        shot_type=ShotType.DROP,
    ),
    "drop whose follow-up pops up, even though the team moved up": case(
        *OPENING,
        hit(A2, SOFT, MID, positions=court(20, 15, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(12, 10, 5, 5)),
        hit(A1, SOFT, FRONT, positions=court(5, 5, 5, 5)),
        smash(B2),
        dink(A2),
        judge=2,
        expect=(DIS, R.FOLLOW_UP_POPUP),
        shot_type=ShotType.DROP,
    ),
    "drop whose follow-up is not seen": case(
        *OPENING,
        hit(A2, SOFT, MID, positions=court(20, 15, 5, 5)),
        hit(B1, SOFT, FRONT),
        ODD,
        dink(A1),
        judge=2,
        expect=UNDECIDED,
        shot_type=ShotType.DROP,
    ),
    "drop with unknown positions at the follow-up": case(
        *OPENING,
        hit(A2, SOFT, MID, positions=court(20, 15, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(20, 15, 5, 5)),
        hit(A1, SOFT, MID, positions=court(None, 15, 5, 5)),
        dink(B2),
        judge=2,
        expect=UNDECIDED,
        shot_type=ShotType.DROP,
    ),
    # --- Check 5: Reset and Block -----------------------------------------------------------
    "block answered soft": case(
        *OPENING,
        bang(A2),
        dink(B1),
        dink(A1),
        dink(B2),
        dink(A2),
        judge=3,
        expect=(ADV, R.SOFT_REPLY),
        shot_type=ShotType.BLOCK,
    ),
    "block answered by a lob": case(
        *OPENING,
        bang(A2),
        dink(B1),
        lob(A1),
        dink(B2),
        dink(A2),
        judge=3,
        expect=(NEU, R.LOB_REPLY),
        shot_type=ShotType.BLOCK,
    ),
    "block whose follow-up pops up": case(
        *OPENING,
        bang(A2),
        dink(B1),
        dink(A1),
        dink(B2),
        smash(A2),
        dink(B1),
        judge=3,
        expect=(DIS, R.FOLLOW_UP_POPUP),
        shot_type=ShotType.BLOCK,
    ),
    "reset answered soft": case(
        *OPENING,
        hit(A2, HARD, BACK),
        hit(B1, SOFT, MID),
        dink(A1),
        dink(B2),
        dink(A2),
        judge=3,
        expect=(ADV, R.SOFT_REPLY),
        shot_type=ShotType.RESET,
    ),
    # --- Check 5: Dink ----------------------------------------------------------------------
    "dink answered by a popup": case(
        *OPENING,
        dink(A2),
        dink(B1),
        smash(A1),
        judge=2,
        expect=(ADV, R.REPLY_POPUP),
        winner=TEAM_A,
        shot_type=ShotType.DINK,
    ),
    "dink answered by a volley": case(
        *OPENING,
        dink(A2),
        hit(B1, SOFT, FRONT, kind=ContactKind.VOLLEY),
        dink(A1),
        dink(B2),
        judge=2,
        expect=(NEU, R.VOLLEYED_REPLY),
        shot_type=ShotType.DINK,
    ),
    "dinking goes on": case(
        *OPENING,
        dink(A2),
        hit(B1, SOFT, FRONT, kind=ContactKind.BOUNCE),
        dink(A1),
        dink(B2),
        judge=2,
        expect=(NEU, R.DINKING_GOES_ON),
        shot_type=ShotType.DINK,
    ),
    "dink whose follow-up pops up": case(
        *OPENING,
        dink(A2),
        dink(B1),
        dink(A1),
        smash(B2),
        dink(A2),
        judge=2,
        expect=(DIS, R.FOLLOW_UP_POPUP),
        shot_type=ShotType.DINK,
    ),
    "dink answered by a shot of unknown shot class": case(
        *OPENING, dink(A2), hit(B1), dink(A1), dink(B2), judge=2, expect=UNDECIDED
    ),
    # --- Check 5: Lobs ----------------------------------------------------------------------
    "offensive lob that breaks the opponents": case(
        *OPENING,
        lob(A2, positions=ALL_FRONT),
        hit(B1, SOFT, FRONT, positions=court(5, 5, 15, 5)),
        dink(A1),
        dink(B2),
        judge=2,
        expect=(ADV, R.OPPONENTS_NOT_ESTABLISHED),
        shot_type=ShotType.OFFENSIVE_LOB,
    ),
    "offensive lob the opponents stay established against": case(
        *OPENING,
        lob(A2, positions=ALL_FRONT),
        hit(B1, SOFT, FRONT, positions=court(5, 5, 11, 5)),
        dink(A1),
        dink(B2),
        judge=2,
        expect=(NEU, R.OPPONENTS_STILL_ESTABLISHED),
        shot_type=ShotType.OFFENSIVE_LOB,
    ),
    "offensive lob with the opponents' positions unknown": case(
        *OPENING,
        lob(A2, positions=ALL_FRONT),
        hit(B1, SOFT, FRONT, positions=court(5, 5, None, 5)),
        dink(A1),
        dink(B2),
        judge=2,
        expect=UNDECIDED,
        shot_type=ShotType.OFFENSIVE_LOB,
    ),
    "defensive lob that lets the team move up": case(
        *OPENING,
        lob(A2, BACK, positions=court(20, 20, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(10, 10, 5, 5)),
        hit(A1, SOFT, FRONT, positions=ALL_FRONT),
        dink(B2),
        judge=2,
        expect=(ADV, R.TEAM_MOVED_UP),
        shot_type=ShotType.DEFENSIVE_LOB,
    ),
    "defensive lob that breaks the opponents": case(
        *OPENING,
        lob(A2, BACK, positions=court(20, 20, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(20, 20, 15, 5)),
        hit(A1, SOFT, BACK, positions=court(20, 20, 15, 5)),
        dink(B2),
        judge=2,
        expect=(ADV, R.OPPONENTS_NOT_ESTABLISHED),
        shot_type=ShotType.DEFENSIVE_LOB,
    ),
    "defensive lob with no gain": case(
        *OPENING,
        lob(A2, BACK, positions=court(20, 20, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(20, 20, 5, 5)),
        hit(A1, SOFT, BACK, positions=court(20, 20, 5, 5)),
        dink(B2),
        judge=2,
        expect=(NEU, R.NO_GAIN),
        shot_type=ShotType.DEFENSIVE_LOB,
    ),
    "defensive lob with unknown positions at the follow-up": case(
        *OPENING,
        lob(A2, BACK, positions=court(20, 20, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(20, 20, 5, 5)),
        hit(A1, SOFT, BACK, positions={}),
        dink(B2),
        judge=2,
        expect=UNDECIDED,
        shot_type=ShotType.DEFENSIVE_LOB,
    ),
    # --- Check 5: Drive ---------------------------------------------------------------------
    "drive answered by a counter that wins": case(
        *OPENING,
        hit(A2, HARD, BACK),
        bang(B1),
        bang(A1),
        bang(B2),
        judge=2,
        expect=(DIS, R.COUNTER_WON),
        winner=TEAM_B,
        shot_type=ShotType.DRIVE,
    ),
    "drive whose partner puts away the reply": case(
        *OPENING,
        hit(A2, HARD, BACK),
        bang(B1),
        bang(A1),
        judge=2,
        expect=(ADV, R.PARTNER_PUT_AWAY),
        winner=TEAM_A,
        shot_type=ShotType.DRIVE,
    ),
    "drive answered soft": case(
        *OPENING,
        hit(A2, HARD, BACK),
        dink(B1),
        dink(A1),
        dink(B2),
        judge=2,
        expect=(ADV, R.SOFT_REPLY),
        shot_type=ShotType.DRIVE,
    ),
    "drive answered hard": case(
        *OPENING,
        hit(A2, HARD, BACK),
        hit(B1, HARD, MID),
        dink(A1),
        dink(B2),
        judge=2,
        expect=(NEU, R.REPLY_KEEPS_RALLY_GOING),
        shot_type=ShotType.DRIVE,
    ),
    "drive whose own hitter puts away the reply": case(
        *OPENING,
        hit(A2, HARD, BACK),
        hit(B1, HARD, MID),
        smash(A2),
        judge=2,
        expect=(NEU, R.REPLY_KEEPS_RALLY_GOING),
        winner=TEAM_A,
        shot_type=ShotType.DRIVE,
    ),
    "drive answered by a counter whose exchange is cut": case(
        *OPENING,
        hit(A2, HARD, BACK),
        bang(B1),
        bang(A1),
        ODD,
        dink(A2),
        judge=2,
        expect=UNDECIDED,
        shot_type=ShotType.DRIVE,
    ),
    # --- Check 5: Overhead ------------------------------------------------------------------
    "overhead answered by a defensive lob from the backcourt": case(
        *OPENING,
        dink(A2),
        lob(B1),
        smash(A1),
        lob(B2, BACK, positions=court(5, 5, 20, 20)),
        smash(A2),
        judge=4,
        expect=(ADV, R.REPLY_FROM_BACKCOURT),
        winner=TEAM_A,
        shot_type=ShotType.OVERHEAD,
    ),
    "overhead answered by a reset from the backcourt": case(
        *OPENING,
        dink(A2),
        lob(B1),
        smash(A1),
        hit(B2, SOFT, BACK, positions=court(5, 5, 20, 20)),
        dink(A2),
        dink(B1),
        judge=4,
        expect=(ADV, R.REPLY_FROM_BACKCOURT),
        shot_type=ShotType.OVERHEAD,
    ),
    "overhead answered by a drive from the backcourt": case(
        *OPENING,
        dink(A2),
        lob(B1),
        smash(A1),
        hit(B2, HARD, BACK, positions=court(5, 5, 20, 20)),
        dink(A2),
        dink(B1),
        judge=4,
        expect=(NEU, R.REPLY_KEEPS_RALLY_GOING),
        shot_type=ShotType.OVERHEAD,
    ),
    "overhead blocked at the net": case(
        *OPENING,
        dink(A2),
        lob(B1),
        smash(A1),
        dink(B2),
        dink(A2),
        dink(B1),
        judge=4,
        expect=(NEU, R.REPLY_KEEPS_RALLY_GOING),
        shot_type=ShotType.OVERHEAD,
    ),
    # --- Check 5: Speedup and Counter -------------------------------------------------------
    "speedup whose exchange is won": case(
        *OPENING,
        dink(A2),
        dink(B1),
        bang(A1),
        bang(B2),
        bang(A2),
        bang(B1, error=net(B1)),
        judge=4,
        expect=(ADV, R.EXCHANGE_WON),
        winner=TEAM_A,
        shot_type=ShotType.SPEEDUP,
    ),
    "speedup whose exchange is neutralised": case(
        *OPENING,
        dink(A2),
        dink(B1),
        bang(A1),
        dink(B2),
        dink(A2),
        dink(B1),
        judge=4,
        expect=(NEU, R.EXCHANGE_NEUTRAL),
        shot_type=ShotType.SPEEDUP,
    ),
    "speedup whose exchange is lost": case(
        *OPENING,
        dink(A2),
        dink(B1),
        bang(A1),
        bang(B2),
        bang(A2),
        bang(B1),
        judge=4,
        expect=(DIS, R.EXCHANGE_LOST),
        winner=TEAM_B,
        shot_type=ShotType.SPEEDUP,
    ),
    "counter whose exchange is won": case(
        *OPENING,
        dink(A2),
        dink(B1),
        bang(A1),
        bang(B2),
        bang(A2),
        bang(B1),
        judge=5,
        expect=(ADV, R.EXCHANGE_WON),
        winner=TEAM_B,
        shot_type=ShotType.COUNTER,
    ),
    "speedup whose exchange is cut by an observation gap": case(
        *OPENING,
        dink(A2),
        dink(B1),
        bang(A1),
        bang(B2),
        ODD,
        dink(A2),
        judge=4,
        expect=UNDECIDED,
        shot_type=ShotType.SPEEDUP,
    ),
    # --- Check 1: Unknown in, None out ------------------------------------------------------
    "last shot of a rally with an unknown winner": case(
        *OPENING, bang(A2), judge=2, expect=UNDECIDED
    ),
    "last shot lost with no error recorded": case(
        *OPENING, bang(A2), judge=2, expect=UNDECIDED, winner=TEAM_B
    ),
    "reply not seen": case(*OPENING, dink(A2), ODD, dink(A1), judge=2, expect=UNDECIDED),
    "unknown shot class": case(
        *OPENING, hit(A2), dink(B1), dink(A1), dink(B2), judge=2, expect=UNDECIDED
    ),
    "unknown shot type": case(
        *OPENING,
        hit(A2, HARD, positions={}),
        dink(B1),
        dink(A1),
        dink(B2),
        judge=2,
        expect=UNDECIDED,
    ),
    "soft shot that might be the return, answered by an attack": case(
        ODD, hit(B1, SOFT, BACK), bang(A2), dink(B2), dink(A1), judge=0, expect=UNDECIDED
    ),
    "serve of unknown shot class is still judged by depth": case(
        hit(A1, None, BACK, landing=CourtPoint(0.0, 20.0), positions={}),
        ret(),
        dink(A2),
        judge=0,
        expect=(ADV, R.DEEP_SERVE),
    ),
    "reply ended the rally with no error recorded": case(
        serve(), ret(), judge=0, expect=UNDECIDED, winner=TEAM_A
    ),
    "drop by an unknown hitter": case(
        *OPENING,
        hit(None, SOFT, MID, positions=court(20, 15, 5, 5)),
        hit(B1, SOFT, FRONT, positions=court(15, 10, 5, 5)),
        hit(A1, SOFT, MID, positions=court(15, 5, 5, 5)),
        dink(B2),
        judge=2,
        expect=UNDECIDED,
        shot_type=ShotType.DROP,
    ),
    "block whose follow-up is not seen": case(
        *OPENING, bang(A2), dink(B1), dink(A1), ODD, dink(A2), judge=3, expect=UNDECIDED
    ),
    "dink whose follow-up is not seen": case(
        *OPENING, dink(A2), dink(B1), ODD, dink(A2), judge=2, expect=UNDECIDED
    ),
    "dink whose reply might be a popup": case(
        *OPENING, dink(A2), dink(B1), bang(A1), ODD, dink(A2), judge=2, expect=UNDECIDED
    ),
    "lob answered by a shot of unknown shot class": case(
        *OPENING, lob(A2), hit(B1), dink(A1), dink(B2), judge=2, expect=UNDECIDED
    ),
    "drive answered soft from an unknown zone": case(
        *OPENING,
        hit(A2, HARD, BACK),
        hit(B1, SOFT, positions={}),
        dink(A1),
        dink(B2),
        judge=2,
        expect=(ADV, R.SOFT_REPLY),
        shot_type=ShotType.DRIVE,
    ),
    "drive answered hard from an unknown zone": case(
        *OPENING,
        hit(A2, HARD, BACK),
        hit(B1, HARD, positions={}),
        dink(A1),
        dink(B2),
        judge=2,
        expect=UNDECIDED,
    ),
    "drive whose follow-up is not seen": case(
        *OPENING, hit(A2, HARD, BACK), hit(B1, HARD, MID), ODD, dink(A2), judge=2, expect=UNDECIDED
    ),
    "overhead answered from an unknown zone": case(
        *OPENING,
        dink(A2),
        lob(B1),
        smash(A1),
        hit(B2, SOFT, positions={}),
        dink(A2),
        dink(B1),
        judge=4,
        expect=UNDECIDED,
    ),
    "overhead answered from the backcourt by a shot of unknown shot type": case(
        *OPENING,
        dink(A2),
        lob(B1),
        smash(A1),
        lob(B2, BACK, positions={}),
        dink(A2),
        dink(B1),
        judge=4,
        expect=UNDECIDED,
    ),
}


@pytest.mark.parametrize("name", CASES)
def test_shot_outcome(name: str) -> None:
    c = CASES[name]
    derived = c.derive()
    judged = judge_shot(derived, ROSTER, c.shot_index)
    assert judged.shot is derived.shots[c.shot_index]
    if c.shot_type is not None:
        assert judged.shot.shot_type is c.shot_type
    assert (judged.outcome, judged.reason) == (c.outcome, c.reason)


def test_every_reason_has_a_case() -> None:
    covered = {c.reason for c in CASES.values()}
    assert set(OutcomeReason) <= covered


def test_every_outcome_and_none_have_a_case() -> None:
    assert {c.outcome for c in CASES.values()} == {*ShotOutcome, None}


def test_judge_rally_judges_every_shot_in_order() -> None:
    derived = CASES["speedup whose exchange is won"].derive()
    judged = judge_rally(derived, ROSTER)
    assert [j.shot for j in judged] == list(derived.shots)
    assert judged == tuple(judge_shot(derived, ROSTER, i) for i in range(len(derived.shots)))
    assert judged[4] == ShotJudgment(derived.shots[4], ADV, R.EXCHANGE_WON)
    assert judged[-1].reason is R.ERROR


def test_judge_rally_on_an_empty_rally() -> None:
    assert judge_rally(derive_rally(Rally(number=1), ROSTER), ROSTER) == ()
