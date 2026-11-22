from dataclasses import replace
from pathlib import Path

import pytest

from pb_tokei.rally_log import (
    UNKNOWN,
    CameraView,
    Certainty,
    Challenge,
    ContactKind,
    CourtPoint,
    Error,
    ErrorKind,
    Fact,
    Game,
    Handedness,
    Match,
    MatchId,
    ObservationGap,
    Parity,
    Player,
    PlayerId,
    PlaySegment,
    Rally,
    RallyLog,
    RefereeCall,
    Ruling,
    Score,
    Shot,
    ShotClass,
    SourceVideo,
    Team,
    TeamId,
    Tour,
    Tournament,
    TournamentId,
    WinnerSource,
    Zone,
    inferred,
    new_id,
    observed,
)

TOURNAMENT = Tournament(TournamentId(new_id()), "Test Open", Tour.PPA)
P1 = Player(PlayerId(new_id()), "Server One", Handedness.RIGHT)
P2 = Player(PlayerId(new_id()), "Partner Two", Handedness.LEFT)
P3 = Player(PlayerId(new_id()), "Returner Three", Handedness.RIGHT)
P4 = Player(PlayerId(new_id()), "Partner Four", Handedness.RIGHT)
SERVERS = Team(TeamId(new_id()), (P1.id, P2.id))
RECEIVERS = Team(TeamId(new_id()), (P3.id, P4.id))


def at(x: float, y: float) -> Fact[CourtPoint]:
    return observed(CourtPoint(x, y))


def small_match() -> Match:
    serve = Shot(
        shot_number=observed(1),
        hitter_id=observed(P1.id),
        contact_frame=observed(120),
        contact_zone=observed(Zone.BACKCOURT),
        shot_class=observed(ShotClass.HARD),
        contact_kind=observed(ContactKind.BOUNCE),
        erne=observed(False),
        atp=observed(False),
        landing=inferred(CourtPoint(2.5, 18.0)),
        positions={
            P1.id: at(-5.0, -22.0),
            P2.id: at(5.0, -21.0),
            P3.id: at(5.0, 22.5),
            P4.id: at(-4.0, 8.0),
        },
    )
    ret = Shot(
        shot_number=observed(2),
        hitter_id=observed(P3.id),
        contact_frame=observed(178),
        contact_zone=observed(Zone.BACKCOURT),
        shot_class=observed(ShotClass.HARD),
        contact_kind=observed(ContactKind.BOUNCE),
        positions={P1.id: at(-5.0, -20.0), P2.id: UNKNOWN, P3.id: at(4.5, 21.0)},
    )
    after_gap = Shot(
        hitter_id=inferred(P2.id),
        contact_frame=observed(410),
        contact_zone=observed(Zone.FRONTCOURT),
        shot_class=observed(ShotClass.SOFT),
        contact_kind=observed(ContactKind.VOLLEY),
        erne=observed(True),
        error=Error(kind=observed(ErrorKind.NET), player_id=inferred(P2.id)),
    )
    rally_with_gap = Rally(
        number=1,
        start_frame=100,
        end_frame=430,
        score=inferred(Score(0, 0, 2)),
        serving_team_id=observed(SERVERS.id),
        server_id=observed(P1.id),
        returner_id=inferred(P3.id),
        referee_call=observed(RefereeCall.SIDE_OUT),
        winner_id=inferred(RECEIVERS.id),
        winner_source=WinnerSource.REFEREE_CALL,
        entries=(serve, ret, ObservationGap(Parity.ODD), after_gap),
    )
    challenged_rally = Rally(
        number=2,
        start_frame=900,
        score=inferred(Score(0, 0, 1)),
        serving_team_id=inferred(RECEIVERS.id),
        server_id=observed(P3.id),
        referee_call=observed(RefereeCall.SIDE_OUT),
        challenge=Challenge(
            challenger_id=observed(P4.id),
            original_call=observed("serve out"),
            ruling=observed(Ruling.OVERTURNED),
        ),
        winner_id=observed(RECEIVERS.id),
        winner_source=WinnerSource.CHALLENGE,
        entries=(ObservationGap(Parity.EVEN),),
    )
    unseen_rally = Rally(number=3)
    return Match(
        id=MatchId(new_id()),
        tournament_id=TOURNAMENT.id,
        team_a_id=SERVERS.id,
        team_b_id=RECEIVERS.id,
        games=(Game(1, (rally_with_gap, challenged_rally, unseen_rally)),),
        play_segments=(
            PlaySegment(90, 450, CameraView.MAIN),
            PlaySegment(880, 1000, CameraView.SIDELINE),
        ),
    )


def save_roster(log: RallyLog) -> None:
    log.save_tournament(TOURNAMENT)
    for player in (P1, P2, P3, P4):
        log.save_player(player)
    log.save_team(SERVERS)
    log.save_team(RECEIVERS)


@pytest.fixture
def log(tmp_path: Path) -> RallyLog:
    log = RallyLog.open(tmp_path / "rally_log.duckdb")
    save_roster(log)
    return log


def test_a_match_round_trips(log: RallyLog) -> None:
    match = small_match()

    log.save_match(match)

    assert log.load_match(match.id) == match


def test_a_match_survives_reopening_the_file(tmp_path: Path) -> None:
    path = tmp_path / "rally_log.duckdb"
    match = small_match()
    with RallyLog.open(path) as log:
        save_roster(log)
        log.save_match(match)

    with RallyLog.open(path) as log:
        assert log.load_match(match.id) == match


def test_saving_a_match_again_replaces_its_rallies(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    first_game = match.games[0]
    edited = replace(match, games=(replace(first_game, rallies=first_game.rallies[:1]),))

    log.save_match(edited)

    assert log.load_match(match.id) == edited


def test_roster_records_round_trip(log: RallyLog) -> None:
    assert log.get_player(P2.id) == P2
    assert log.get_team(SERVERS.id) == SERVERS
    assert log.get_tournament(TOURNAMENT.id) == TOURNAMENT


def test_the_same_pair_is_the_same_team(log: RallyLog) -> None:
    assert log.find_team(P2.id, P1.id) == SERVERS
    with pytest.raises(Exception, match="(?i)constraint"):
        log.save_team(Team(TeamId(new_id()), (P2.id, P1.id)))


def test_an_unknown_fact_has_no_value() -> None:
    with pytest.raises(ValueError):
        Fact(3, Certainty.UNKNOWN)
    with pytest.raises(ValueError):
        Fact(None, Certainty.OBSERVED)


def test_roster_records_can_be_edited_after_a_match_uses_them(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    renamed = replace(P1, name="Server Renamed")

    log.save_player(renamed)
    log.save_tournament(replace(TOURNAMENT, name="Renamed Open"))

    assert log.get_player(P1.id) == renamed
    assert log.load_match(match.id) == match


def test_match_source_video_round_trips(log: RallyLog) -> None:
    video = SourceVideo(
        url="https://www.youtube.com/watch?v=abc123XYZ00",
        video_id="abc123XYZ00",
        path=Path("footage/abc123XYZ00.mp4"),
    )
    match = replace(small_match(), source_video=video)

    log.save_match(match)

    assert log.load_match(match.id) == match


def test_recording_source_video_against_existing_match_preserves_rallies(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    video = SourceVideo(
        url="https://www.youtube.com/watch?v=abc123XYZ00",
        video_id="abc123XYZ00",
        path=Path("footage/abc123XYZ00.mkv"),
    )

    log.set_match_source_video(match.id, video)

    assert log.load_match(match.id) == replace(match, source_video=video)


def test_recording_source_video_for_missing_match_fails(log: RallyLog) -> None:
    video = SourceVideo(
        url="https://www.youtube.com/watch?v=abc123XYZ00",
        video_id="abc123XYZ00",
        path=Path("footage/abc123XYZ00.mp4"),
    )

    with pytest.raises(KeyError):
        log.set_match_source_video(MatchId(new_id()), video)


def test_source_video_rejects_empty_fields() -> None:
    with pytest.raises(ValueError):
        SourceVideo("", "abc123", Path("footage/abc123.mp4"))
    with pytest.raises(ValueError):
        SourceVideo("https://example.com/v", "   ", Path("footage/abc123.mp4"))
    with pytest.raises(ValueError):
        SourceVideo("https://example.com/v", "abc123", Path(""))
