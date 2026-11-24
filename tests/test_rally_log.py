from dataclasses import replace
from pathlib import Path

import duckdb
import pytest

from pb_tokei.rally_log import (
    UNKNOWN,
    Calibration,
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
    ImagePoint,
    Landmark,
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
        calibrations=(MAIN_CALIBRATION, Calibration(CameraView.SIDELINE, 880, 900)),
    )


MAIN_CALIBRATION = Calibration(
    CameraView.MAIN,
    effective_from_frame=90,
    reference_frame=120,
    landmarks={
        Landmark.NEAR_BASELINE_LEFT: ImagePoint(0.12, 0.93),
        Landmark.NEAR_BASELINE_RIGHT: ImagePoint(0.88, 0.93),
        Landmark.FAR_BASELINE_LEFT: ImagePoint(0.32, 0.18),
        Landmark.FAR_BASELINE_RIGHT: ImagePoint(0.68, 0.18),
    },
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


def test_match_summary_is_one_match_of_the_listing(log: RallyLog) -> None:
    video = SourceVideo(
        url="https://www.youtube.com/watch?v=abc123XYZ00",
        video_id="abc123XYZ00",
        path=Path("footage/abc123XYZ00.mkv"),
    )
    with_video = replace(small_match(), id=MatchId(new_id()), source_video=video)
    without_video = replace(small_match(), id=MatchId(new_id()))
    log.save_match(with_video)
    log.save_match(without_video)

    summary = log.get_match_summary(with_video.id)
    bare = log.get_match_summary(without_video.id)

    assert summary.id == with_video.id
    assert summary.tournament == TOURNAMENT.name
    assert summary.team_a == ("Partner Two", "Server One")
    assert summary.source_video == video
    assert summary.has_video
    assert bare.source_video is None
    assert not bare.has_video
    assert sorted(log.list_matches(), key=lambda s: str(s.id)) == sorted(
        [summary, bare], key=lambda s: str(s.id)
    )


def test_match_summary_for_missing_match_fails(log: RallyLog) -> None:
    log.save_match(small_match())

    with pytest.raises(KeyError):
        log.get_match_summary(MatchId(new_id()))


def test_source_video_rejects_empty_fields() -> None:
    with pytest.raises(ValueError):
        SourceVideo("", "abc123", Path("footage/abc123.mp4"))
    with pytest.raises(ValueError):
        SourceVideo("https://example.com/v", "   ", Path("footage/abc123.mp4"))
    with pytest.raises(ValueError):
        SourceVideo("https://example.com/v", "abc123", Path(""))


def test_saving_a_match_without_source_video_preserves_recorded_video(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    video = SourceVideo(
        url="https://www.youtube.com/watch?v=abc123XYZ00",
        video_id="abc123XYZ00",
        path=Path("footage/abc123XYZ00.mkv"),
    )
    log.set_match_source_video(match.id, video)

    # Saving the Match again with source_video=None keeps the recorded source video.
    edited = replace(match, games=())
    log.save_match(edited)

    assert log.load_match(match.id) == replace(edited, source_video=video)


def test_saving_a_match_with_new_source_video_replaces_recorded_video(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    first = SourceVideo(
        url="https://www.youtube.com/watch?v=first000001",
        video_id="first000001",
        path=Path("footage/first000001.mp4"),
    )
    second = SourceVideo(
        url="https://www.youtube.com/watch?v=second00002",
        video_id="second00002",
        path=Path("footage/second00002.mkv"),
    )
    log.set_match_source_video(match.id, first)

    log.save_match(replace(match, source_video=second))

    assert log.load_match(match.id).source_video == second


def test_source_video_columns_are_all_or_nothing(tmp_path: Path) -> None:
    path = tmp_path / "rally_log.duckdb"
    match = small_match()
    with RallyLog.open(path) as log:
        save_roster(log)
        log.save_match(match)

    with duckdb.connect(str(path)) as conn, pytest.raises(duckdb.ConstraintException):
        conn.execute(
            "UPDATE matches SET source_video_url = 'https://example.com/v' WHERE id = ?",
            [match.id],
        )


def test_opening_an_older_database_adds_source_video_columns(tmp_path: Path) -> None:
    path = tmp_path / "legacy.duckdb"
    match_id = MatchId(new_id())
    with duckdb.connect(str(path)) as conn:
        conn.execute(
            "CREATE TABLE tournaments ("
            "id UUID PRIMARY KEY, name VARCHAR NOT NULL, tour VARCHAR NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE players ("
            "id UUID PRIMARY KEY, name VARCHAR NOT NULL, handedness VARCHAR NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE teams ("
            "id UUID PRIMARY KEY, player_low_id UUID NOT NULL, player_high_id UUID NOT NULL)"
        )
        conn.execute("CREATE TABLE franchises (id UUID PRIMARY KEY, name VARCHAR NOT NULL)")
        conn.execute(
            "CREATE TABLE franchise_matches ("
            "id UUID PRIMARY KEY, tournament_id UUID NOT NULL, "
            "franchise_a_id UUID NOT NULL, franchise_b_id UUID NOT NULL)"
        )
        # Pre-PR 5-column matches table without source_video_* columns.
        conn.execute(
            "CREATE TABLE matches ("
            "id UUID PRIMARY KEY, tournament_id UUID NOT NULL, "
            "team_a_id UUID NOT NULL, team_b_id UUID NOT NULL, franchise_match_id UUID)"
        )
        conn.execute(
            "INSERT INTO tournaments VALUES (?, ?, ?)",
            [TOURNAMENT.id, TOURNAMENT.name, TOURNAMENT.tour.value],
        )
        for player in (P1, P2, P3, P4):
            conn.execute(
                "INSERT INTO players VALUES (?, ?, ?)",
                [player.id, player.name, player.handedness.value],
            )
        conn.execute("INSERT INTO teams VALUES (?, ?, ?)", [SERVERS.id, *SERVERS.player_ids])
        conn.execute("INSERT INTO teams VALUES (?, ?, ?)", [RECEIVERS.id, *RECEIVERS.player_ids])
        conn.execute(
            "INSERT INTO matches VALUES (?, ?, ?, ?, NULL)",
            [match_id, TOURNAMENT.id, SERVERS.id, RECEIVERS.id],
        )

    video = SourceVideo(
        url="https://www.youtube.com/watch?v=legacy00001",
        video_id="legacy00001",
        path=Path("footage/legacy00001.mp4"),
    )
    with RallyLog.open(path) as log:
        assert log.load_match(match_id).source_video is None
        log.set_match_source_video(match_id, video)
        assert log.load_match(match_id).source_video == video


# --- Play Segments and Calibrations -------------------------------------------------------


def test_play_segments_can_be_replaced_without_touching_rallies(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    segments = [PlaySegment(500, 500, CameraView.SIDELINE), PlaySegment(10, 499, CameraView.MAIN)]

    log.replace_play_segments(match.id, segments)

    assert log.get_play_segments(match.id) == (segments[1], segments[0])
    assert log.load_match(match.id).games == match.games


def test_overlapping_play_segments_are_refused(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    overlapping = [PlaySegment(10, 100, CameraView.MAIN), PlaySegment(100, 200, CameraView.MAIN)]

    with pytest.raises(ValueError, match="overlap"):
        log.replace_play_segments(match.id, overlapping)
    with pytest.raises(ValueError, match="overlap"):
        replace(match, play_segments=tuple(overlapping))

    assert log.get_play_segments(match.id) == match.play_segments


@pytest.mark.parametrize(("start", "end"), [(-1, 10), (10, 9)])
def test_a_play_segment_needs_frames_in_order(start: int, end: int) -> None:
    with pytest.raises(ValueError):
        PlaySegment(start, end, CameraView.MAIN)


def test_calibrations_of_one_view_can_be_replaced(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    later = Calibration(
        CameraView.MAIN, 5000, 5010, {Landmark.FAR_KITCHEN_CENTRE: ImagePoint(0.5, 0.4)}
    )

    log.replace_calibrations(match.id, CameraView.MAIN, [MAIN_CALIBRATION, later])

    saved = log.get_calibrations(match.id)
    assert [c for c in saved if c.camera_view is CameraView.MAIN] == [MAIN_CALIBRATION, later]
    sideline = [c for c in saved if c.camera_view is CameraView.SIDELINE]
    assert sideline == [Calibration(CameraView.SIDELINE, 880, 900)]


def test_calibrations_are_saved_under_their_own_view(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)

    with pytest.raises(ValueError, match="can't be saved as"):
        log.replace_calibrations(match.id, CameraView.SIDELINE, [MAIN_CALIBRATION])


def test_two_calibrations_of_a_view_cannot_start_at_one_frame(log: RallyLog) -> None:
    match = small_match()
    log.save_match(match)
    twin = replace(MAIN_CALIBRATION, reference_frame=400)

    with pytest.raises(ValueError, match="start at frame 90"):
        log.replace_calibrations(match.id, CameraView.MAIN, [MAIN_CALIBRATION, twin])


def test_calibration_landmarks_must_be_inside_the_frame() -> None:
    with pytest.raises(ValueError, match="outside the video frame"):
        Calibration(CameraView.MAIN, 0, 0, {Landmark.NEAR_KITCHEN_LEFT: ImagePoint(1.2, 0.5)})


def test_editing_a_missing_match_fails(log: RallyLog) -> None:
    missing = MatchId(new_id())

    with pytest.raises(KeyError):
        log.replace_play_segments(missing, [])
    with pytest.raises(KeyError):
        log.replace_calibrations(missing, CameraView.MAIN, [])
    with pytest.raises(KeyError):
        log.get_calibrations(missing)


def test_opening_an_older_database_allows_one_frame_play_segments(tmp_path: Path) -> None:
    path = tmp_path / "legacy.duckdb"
    match = small_match()
    with RallyLog.open(path) as log:
        save_roster(log)
        log.save_match(match)
    with duckdb.connect(str(path)) as conn:
        # The table as first released: end strictly after start.
        conn.execute("DROP TABLE play_segments")
        conn.execute(
            "CREATE TABLE play_segments (match_id UUID NOT NULL, start_frame INTEGER NOT NULL, "
            "end_frame INTEGER NOT NULL, camera_view VARCHAR NOT NULL, "
            "CHECK (start_frame < end_frame), PRIMARY KEY (match_id, start_frame))"
        )
        conn.execute("INSERT INTO play_segments VALUES (?, 90, 450, 'main')", [match.id])

    with RallyLog.open(path) as log:
        assert log.get_play_segments(match.id) == (PlaySegment(90, 450, CameraView.MAIN),)
        log.replace_play_segments(match.id, [PlaySegment(7, 7, CameraView.MAIN)])
        assert log.get_play_segments(match.id) == (PlaySegment(7, 7, CameraView.MAIN),)
