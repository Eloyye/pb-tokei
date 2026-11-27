"""Shot Outcomes: Advantage, Neutral or Disadvantage for every Shot, Derived by rule (ADR 0003).

Built on the Derived facts of `derived.py` (issue #16). A Shot is judged over its **reply** (the
next Shot, by the opponents) and its Team's **follow-up** (the Shot after that). The checks run
in this order and the first one that applies decides the Outcome (issue #17):

1. Unknown in, None out: wherever a fact the deciding check needs is Unknown, the Outcome is
   `None`, with no best guess. A check that cannot tell whether it applies stops the judgment
   too, because it might have decided it. Facts a check does not need may stay Unknown: a Winner
   of Unknown Shot Type is still an Advantage.
2. Rally-ending checks: the Shot is a Winner, the Shot is the hitter's own Error, the reply is
   the opponent's Error, the reply is a Winner.
3. Popup: a Soft Shot (but not a Serve) answered by an Overhead or a Put-away.
4. A Soft Shot or Lob (but not a Serve or Return) answered by an Attack takes the mirror of that
   Attack's exchange, with the Lob zone upgrade.
5. The row rule for the Shot Type. Within a row, Disadvantage clauses come before Advantage
   clauses.

Every judgment carries the `OutcomeReason` naming the clause that decided it, or `None` with an
Outcome of `None`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from pb_tokei.rally_log.model import (
    ContactKind,
    MatchRoster,
    Ruling,
    ShotClass,
    Zone,
    zone_for_point,
)

from .derived import (
    RETURN_SHOT_NUMBER,
    SERVE_SHOT_NUMBER,
    DerivedRally,
    DerivedShot,
    ExchangeOutcome,
    ShotType,
    TeamStatus,
    resolve_attack_exchange,
)


class ShotOutcome(StrEnum):
    ADVANTAGE = "advantage"
    NEUTRAL = "neutral"
    DISADVANTAGE = "disadvantage"


class OutcomeReason(StrEnum):
    """The clause that decided a Shot Outcome."""

    # Check 2: rally-ending
    WINNER = "winner"
    ERROR = "error"
    REPLY_ERROR = "reply_error"
    REPLY_WINNER = "reply_winner"
    # Check 3
    POPUP = "popup"
    # Check 4: the mirror of the reply's attack exchange
    ATTACK_WON = "attack_won"
    """Disadvantage: the opponents' attacking reply won its exchange."""
    ATTACK_NEUTRALISED = "attack_neutralised"
    """Neutral: the opponents' attacking reply was neutralised."""
    ATTACK_LOST = "attack_lost"
    """Advantage: the opponents' attacking reply lost its exchange."""
    LOB_PUSHED_BACK = "lob_pushed_back"
    """A Lob whose attacking reply came from the Midcourt or Backcourt and was neutralised."""
    # Check 5: Serve and Return depth
    DEEP_SERVE = "deep_serve"
    MIDCOURT_SERVE = "midcourt_serve"
    SHORT_SERVE = "short_serve"
    DEEP_RETURN = "deep_return"
    MIDCOURT_RETURN = "midcourt_return"
    SHORT_RETURN = "short_return"
    # Check 5: Drop, Reset, Block, Dink
    FOLLOW_UP_POPUP = "follow_up_popup"
    ESTABLISHED_AT_FOLLOW_UP = "established_at_follow_up"
    TEAM_MOVED_UP = "team_moved_up"
    """The Team's Team Status is better at its follow-up than at the Shot."""
    NO_GAIN = "no_gain"
    SOFT_REPLY = "soft_reply"
    LOB_REPLY = "lob_reply"
    REPLY_POPUP = "reply_popup"
    VOLLEYED_REPLY = "volleyed_reply"
    DINKING_GOES_ON = "dinking_goes_on"
    """A Dink whose reply is neither a Popup nor known to be a Volley."""
    # Check 5: Lobs
    OPPONENTS_NOT_ESTABLISHED = "opponents_not_established"
    OPPONENTS_STILL_ESTABLISHED = "opponents_still_established"
    # Check 5: Drive and Overhead
    COUNTER_WON = "counter_won"
    PARTNER_PUT_AWAY = "partner_put_away"
    REPLY_KEEPS_RALLY_GOING = "reply_keeps_rally_going"
    REPLY_FROM_BACKCOURT = "reply_from_backcourt"
    """An Overhead answered by a Defensive Lob or Reset from the opponents' Backcourt."""
    # Check 5: Speedup and Counter
    EXCHANGE_WON = "exchange_won"
    """Advantage: the Speedup's or Counter's own exchange was won by its Team."""
    EXCHANGE_NEUTRAL = "exchange_neutral"
    EXCHANGE_LOST = "exchange_lost"
    """Disadvantage: the Speedup's or Counter's own exchange was lost by its Team."""


@dataclass(frozen=True)
class ShotJudgment:
    """A Shot's Outcome and the clause that decided it; both `None` when the Rally Log cannot
    settle it."""

    shot: DerivedShot
    outcome: ShotOutcome | None
    reason: OutcomeReason | None


# --- Public entry points ------------------------------------------------------------------


def judge_rally(derived: DerivedRally, roster: MatchRoster) -> tuple[ShotJudgment, ...]:
    """The Shot Outcome of every Shot in a Derived Rally, in `DerivedRally.shots` order."""
    by_entry = _by_entry(derived)
    return tuple(_judge(derived, roster, s, by_entry) for s in derived.shots)


def judge_shot(derived: DerivedRally, roster: MatchRoster, shot_index: int) -> ShotJudgment:
    """The Shot Outcome of the Shot at `shot_index` of `DerivedRally.shots`."""
    return _judge(derived, roster, derived.shots[shot_index], _by_entry(derived))


def _by_entry(derived: DerivedRally) -> dict[int, DerivedShot]:
    return {s.entry_index: s for s in derived.shots}


def _judge(
    derived: DerivedRally,
    roster: MatchRoster,
    shot: DerivedShot,
    by_entry: dict[int, DerivedShot],
) -> ShotJudgment:
    team = shot.hitter_team_id
    reply = by_entry.get(shot.entry_index + 1)
    if reply is not None and team is not None and reply.hitter_team_id == team:
        reply = None  # a messy Rally: the next Shot is not the opponents' reply
    follow_up = None if reply is None else by_entry.get(shot.entry_index + 2)
    if (
        follow_up is not None
        and team is not None
        and follow_up.hitter_team_id is not None
        and follow_up.hitter_team_id != team
    ):
        follow_up = None  # a messy Rally: the Shot after the reply is not the Team's
    ctx = _Context(derived, roster, shot, reply, follow_up)
    for check in (_rally_ending, _popup, _mirrored_exchange, _row_rule):
        verdict = check(ctx)
        if verdict is not None:
            outcome, reason = verdict
            return ShotJudgment(shot, outcome, reason)
    return ShotJudgment(shot, None, None)  # pragma: no cover - the row rule always decides


# --- The checks ---------------------------------------------------------------------------

_Verdict = tuple[ShotOutcome | None, OutcomeReason | None]
"""What a check decided. A check returns `None` instead when it does not apply."""

_UNDECIDED: _Verdict = (None, None)
_ADVANTAGE, _NEUTRAL, _DISADVANTAGE = (
    ShotOutcome.ADVANTAGE,
    ShotOutcome.NEUTRAL,
    ShotOutcome.DISADVANTAGE,
)

_STATUS_RANK = {TeamStatus.BACK: 0, TeamStatus.SPLIT: 1, TeamStatus.ESTABLISHED: 2}


@dataclass(frozen=True)
class _Context:
    """The Shot being judged, its reply and its Team's follow-up (`None` where an Observation
    Gap or the Rally's end comes instead)."""

    derived: DerivedRally
    roster: MatchRoster
    shot: DerivedShot
    reply: DerivedShot | None
    follow_up: DerivedShot | None

    def is_last_shot(self, shot: DerivedShot) -> bool:
        return shot.entry_index == len(self.derived.rally.entries) - 1

    def exchange_from(self, start: DerivedShot) -> ExchangeOutcome | None:
        """How the attack exchange from `start` ends, for `start`'s Team."""
        rally = self.derived.rally
        return resolve_attack_exchange(
            rally, self.roster, self.derived.shots, start.entry_index, start.hitter_team_id
        ).outcome


def _lost_on(ctx: _Context, shot: DerivedShot) -> bool:
    """Whether the Rally's last Shot, known not to be a Winner, lost it with its hitter's Error
    (recorded, or a call overturned against it)."""
    challenge = ctx.derived.rally.challenge
    overturned = challenge is not None and challenge.ruling.value is Ruling.OVERTURNED
    return shot.shot.error is not None or overturned


def _rally_ending(ctx: _Context) -> _Verdict | None:
    shot, reply = ctx.shot, ctx.reply
    if shot.is_winner is None:
        return _UNDECIDED
    if shot.is_winner:
        return _ADVANTAGE, OutcomeReason.WINNER
    if ctx.is_last_shot(shot):
        # The Rally ended on this Shot and it was not a Winner: the hitter's Error, or a Rally
        # Log that does not say how it ended.
        return (_DISADVANTAGE, OutcomeReason.ERROR) if _lost_on(ctx, shot) else _UNDECIDED
    if reply is None:
        return _UNDECIDED  # an Observation Gap, or a Shot by the same Team, comes next
    if reply.is_winner is None:
        return _UNDECIDED
    if reply.is_winner:
        return _DISADVANTAGE, OutcomeReason.REPLY_WINNER
    if not ctx.is_last_shot(reply):
        return None
    if not _lost_on(ctx, reply):
        return _UNDECIDED
    if shot.shot_type is not ShotType.SERVE:
        reply_class = reply.shot.shot_class.value
        if shot.is_popup is True and reply_class is ShotClass.OVERHEAD:
            # A failed Overhead counts against the Overhead, not for the Soft Shot it answered:
            # the Popup check judges this Shot instead.
            return None
        if shot.is_popup is None and reply_class in (ShotClass.OVERHEAD, None):
            return _UNDECIDED  # it might be a Popup answered by a failed Overhead
    return _ADVANTAGE, OutcomeReason.REPLY_ERROR


def _popup(ctx: _Context) -> _Verdict | None:
    shot = ctx.shot
    if shot.shot_type is ShotType.SERVE:
        return None
    if shot.is_popup is None:
        # A Shot of Unknown Shot Class is still no Popup if its reply can't make it one.
        reply = ctx.reply
        if (
            reply is not None
            and reply.shot.shot_class.value not in (ShotClass.OVERHEAD, None)
            and reply.is_put_away is False
        ):
            return None
        return _UNDECIDED
    return (_DISADVANTAGE, OutcomeReason.POPUP) if shot.is_popup else None


def _is_serve_or_return(shot: DerivedShot) -> bool | None:
    number = shot.shot_number
    if number is not None:
        return number in (SERVE_SHOT_NUMBER, RETURN_SHOT_NUMBER)
    return None if shot.min_shot_number <= RETURN_SHOT_NUMBER else False


def _mirrored_exchange(ctx: _Context) -> _Verdict | None:
    shot, reply = ctx.shot, ctx.reply
    shot_class = shot.shot.shot_class.value
    if shot_class is not None and shot_class not in (ShotClass.SOFT, ShotClass.LOB):
        return None
    opening_pair = _is_serve_or_return(shot)
    if opening_pair:
        return None
    if shot_class is None or opening_pair is None:
        return _UNDECIDED
    assert reply is not None  # the rally-ending checks stop at a missing reply
    if reply.is_attack is None:
        return _UNDECIDED
    if not reply.is_attack:
        return None
    match ctx.exchange_from(reply):
        case ExchangeOutcome.WON:
            return _DISADVANTAGE, OutcomeReason.ATTACK_WON
        case ExchangeOutcome.LOST:
            return _ADVANTAGE, OutcomeReason.ATTACK_LOST
        case ExchangeOutcome.NEUTRAL:
            if shot_class is not ShotClass.LOB:
                return _NEUTRAL, OutcomeReason.ATTACK_NEUTRALISED
            match reply.contact_zone:
                case Zone.MIDCOURT | Zone.BACKCOURT:
                    return _ADVANTAGE, OutcomeReason.LOB_PUSHED_BACK
                case Zone.FRONTCOURT:
                    return _NEUTRAL, OutcomeReason.ATTACK_NEUTRALISED
                case _:
                    return _UNDECIDED
        case _:
            return _UNDECIDED


# --- Check 5: the row rule for each Shot Type ---------------------------------------------


def _row_rule(ctx: _Context) -> _Verdict:
    match ctx.shot.shot_type:
        case ShotType.SERVE:
            return _depth(
                ctx,
                OutcomeReason.DEEP_SERVE,
                OutcomeReason.MIDCOURT_SERVE,
                OutcomeReason.SHORT_SERVE,
            )
        case ShotType.RETURN:
            return _depth(
                ctx,
                OutcomeReason.DEEP_RETURN,
                OutcomeReason.MIDCOURT_RETURN,
                OutcomeReason.SHORT_RETURN,
            )
        case ShotType.DROP:
            return _drop(ctx)
        case ShotType.RESET | ShotType.BLOCK:
            return _reset_or_block(ctx)
        case ShotType.DINK:
            return _dink(ctx)
        case ShotType.OFFENSIVE_LOB:
            return _offensive_lob(ctx)
        case ShotType.DEFENSIVE_LOB:
            return _defensive_lob(ctx)
        case ShotType.DRIVE:
            return _drive(ctx)
        case ShotType.OVERHEAD:
            return _overhead(ctx)
        case ShotType.SPEEDUP | ShotType.COUNTER:
            return _speedup_or_counter(ctx)
        case _:
            return _UNDECIDED


def _depth(
    ctx: _Context, deep: OutcomeReason, midcourt: OutcomeReason, short: OutcomeReason
) -> _Verdict:
    """Serve and Return: by the Zone the ball lands in on the far side."""
    landing = ctx.shot.shot.landing.value
    if landing is None:
        return _UNDECIDED
    match zone_for_point(landing):
        case Zone.BACKCOURT:
            return _ADVANTAGE, deep
        case Zone.MIDCOURT:
            return _NEUTRAL, midcourt
        case Zone.FRONTCOURT:
            return _DISADVANTAGE, short


def _follow_up_popup(ctx: _Context) -> bool | None:
    return None if ctx.follow_up is None else ctx.follow_up.is_popup


def _established_at(ctx: _Context, shot: DerivedShot | None) -> bool | None:
    """Whether the judged Shot's Team is Established at `shot`'s contact."""
    team = ctx.shot.hitter_team_id
    if shot is None or team is None:
        return None
    return shot.team_established.get(team)


def _status_rank_bounds(ctx: _Context, shot: DerivedShot | None) -> tuple[int, int]:
    """The lowest and highest Team Status rank the judged Shot's Team can have at `shot`."""
    team = ctx.shot.hitter_team_id
    status = None if shot is None or team is None else shot.team_status.get(team)
    if status is not None:
        return _STATUS_RANK[status], _STATUS_RANK[status]
    if _established_at(ctx, shot) is False:
        return _STATUS_RANK[TeamStatus.BACK], _STATUS_RANK[TeamStatus.SPLIT]
    return _STATUS_RANK[TeamStatus.BACK], _STATUS_RANK[TeamStatus.ESTABLISHED]


def _moved_up(ctx: _Context) -> bool | None:
    """Whether the Team's Team Status is better at its follow-up than at the Shot."""
    before_lo, before_hi = _status_rank_bounds(ctx, ctx.shot)
    after_lo, after_hi = _status_rank_bounds(ctx, ctx.follow_up)
    if after_lo > before_hi:
        return True
    if after_hi <= before_lo:
        return False
    return None


def _opponents_established_at_reply(ctx: _Context) -> bool | None:
    team, reply = ctx.shot.hitter_team_id, ctx.reply
    assert team is not None  # a Lob's Shot Type needs its hitter's Team
    assert reply is not None
    return reply.team_established.get(ctx.roster.other_team_id(team))


def _drop(ctx: _Context) -> _Verdict:
    popup = _follow_up_popup(ctx)
    if popup is None:
        return _UNDECIDED
    if popup:
        return _DISADVANTAGE, OutcomeReason.FOLLOW_UP_POPUP
    established = _established_at(ctx, ctx.follow_up)
    if established:
        return _ADVANTAGE, OutcomeReason.ESTABLISHED_AT_FOLLOW_UP
    moved_up = _moved_up(ctx)
    if moved_up:
        return _ADVANTAGE, OutcomeReason.TEAM_MOVED_UP
    if moved_up is None or established is None:
        return _UNDECIDED
    return _NEUTRAL, OutcomeReason.NO_GAIN


def _reset_or_block(ctx: _Context) -> _Verdict:
    popup = _follow_up_popup(ctx)
    if popup is None:
        return _UNDECIDED
    if popup:
        return _DISADVANTAGE, OutcomeReason.FOLLOW_UP_POPUP
    assert ctx.reply is not None
    reply_class = ctx.reply.shot.shot_class.value
    if reply_class is ShotClass.SOFT:
        return _ADVANTAGE, OutcomeReason.SOFT_REPLY
    if reply_class is ShotClass.LOB:
        return _NEUTRAL, OutcomeReason.LOB_REPLY
    # The Popup and mirror checks judge every other reply, except on a messy Rally (a reply
    # whose recorded Shot Number makes it a Serve or Return, so never an Attack).
    return _UNDECIDED


def _dink(ctx: _Context) -> _Verdict:
    popup = _follow_up_popup(ctx)
    if popup is None:
        return _UNDECIDED
    if popup:
        return _DISADVANTAGE, OutcomeReason.FOLLOW_UP_POPUP
    reply = ctx.reply
    assert reply is not None
    if reply.is_popup is None:
        return _UNDECIDED
    if reply.is_popup:
        return _ADVANTAGE, OutcomeReason.REPLY_POPUP
    if reply.shot.contact_kind.value is ContactKind.VOLLEY:
        return _NEUTRAL, OutcomeReason.VOLLEYED_REPLY
    return _NEUTRAL, OutcomeReason.DINKING_GOES_ON


def _offensive_lob(ctx: _Context) -> _Verdict:
    established = _opponents_established_at_reply(ctx)
    if established is None:
        return _UNDECIDED
    if established:
        return _NEUTRAL, OutcomeReason.OPPONENTS_STILL_ESTABLISHED
    return _ADVANTAGE, OutcomeReason.OPPONENTS_NOT_ESTABLISHED


def _defensive_lob(ctx: _Context) -> _Verdict:
    moved_up = _moved_up(ctx)
    if moved_up:
        return _ADVANTAGE, OutcomeReason.TEAM_MOVED_UP
    established = _opponents_established_at_reply(ctx)
    if established is False:
        return _ADVANTAGE, OutcomeReason.OPPONENTS_NOT_ESTABLISHED
    if moved_up is None or established is None:
        return _UNDECIDED
    return _NEUTRAL, OutcomeReason.NO_GAIN


def _is_counter(shot: DerivedShot) -> bool | None:
    if shot.shot_type is not None:
        return shot.shot_type is ShotType.COUNTER
    shot_class = shot.shot.shot_class.value
    return None if shot_class in (ShotClass.HARD, None) else False


def _partner_put_away(ctx: _Context) -> bool | None:
    follow_up = ctx.follow_up
    if follow_up is None:
        return None
    if follow_up.is_put_away is False:
        return False
    hitter = ctx.shot.hitter_id
    if hitter is None or follow_up.hitter_id is None:
        return None
    partner = follow_up.hitter_team_id == ctx.shot.hitter_team_id and follow_up.hitter_id != hitter
    return follow_up.is_put_away if partner else False


def _drive(ctx: _Context) -> _Verdict:
    reply = ctx.reply
    assert reply is not None
    counter = _is_counter(reply)
    if counter is not False:
        exchange = ctx.exchange_from(reply)
        if exchange is ExchangeOutcome.WON:
            return (_DISADVANTAGE, OutcomeReason.COUNTER_WON) if counter else _UNDECIDED
        if exchange is None:
            return _UNDECIDED
    put_away = _partner_put_away(ctx)
    if put_away:
        return _ADVANTAGE, OutcomeReason.PARTNER_PUT_AWAY
    if reply.shot.shot_class.value is ShotClass.SOFT:
        return _ADVANTAGE, OutcomeReason.SOFT_REPLY
    if put_away is None:
        return _UNDECIDED
    return _NEUTRAL, OutcomeReason.REPLY_KEEPS_RALLY_GOING


def _overhead(ctx: _Context) -> _Verdict:
    reply = ctx.reply
    assert reply is not None
    if reply.shot.shot_class.value in (ShotClass.HARD, ShotClass.OVERHEAD):
        return _NEUTRAL, OutcomeReason.REPLY_KEEPS_RALLY_GOING  # never a Defensive Lob or Reset
    zone = reply.contact_zone
    if zone is None:
        return _UNDECIDED
    if zone is not Zone.BACKCOURT:
        return _NEUTRAL, OutcomeReason.REPLY_KEEPS_RALLY_GOING
    if reply.shot_type is None:
        return _UNDECIDED
    if reply.shot_type in (ShotType.DEFENSIVE_LOB, ShotType.RESET):
        return _ADVANTAGE, OutcomeReason.REPLY_FROM_BACKCOURT
    return _NEUTRAL, OutcomeReason.REPLY_KEEPS_RALLY_GOING


def _speedup_or_counter(ctx: _Context) -> _Verdict:
    match ctx.exchange_from(ctx.shot):
        case ExchangeOutcome.WON:
            return _ADVANTAGE, OutcomeReason.EXCHANGE_WON
        case ExchangeOutcome.NEUTRAL:
            return _NEUTRAL, OutcomeReason.EXCHANGE_NEUTRAL
        case ExchangeOutcome.LOST:
            return _DISADVANTAGE, OutcomeReason.EXCHANGE_LOST
        case _:
            return _UNDECIDED
