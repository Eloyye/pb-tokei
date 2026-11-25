import tomllib
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from dataclasses import replace
from pathlib import Path
from threading import Barrier, BrokenBarrierError
from uuid import UUID, uuid4

import pytest

from pb_tokei import main
from pb_tokei.rally_log import (
    Franchise,
    FranchiseId,
    Game,
    Handedness,
    MatchId,
    Player,
    PlayerId,
    RallyLog,
    Tour,
    Tournament,
    TournamentId,
)
from pb_tokei.roster import RosterError, parse_roster, roster_template, set_up_match

PPA = {"name": "PPA Atlanta Open 2026", "tour": "ppa"}


def roster_toml(
    *,
    match_id: UUID | None = None,
    tournament: dict[str, str] = PPA,
    team_a: tuple[tuple[str, str], ...] = (("Anna Bright", "right"), ("Ben Johns", "right")),
    team_b: tuple[tuple[str, str], ...] = (("Cara Lee", "left"), ("Dan Kim", "right")),
    franchise_match: dict[str, str] | None = None,
    video: dict[str, str] | None = None,
) -> str:
    lines = [f'id = "{match_id or uuid4()}"', "", "[tournament]"]
    lines += [f'{key} = "{value}"' for key, value in tournament.items()]
    for team, players in (("team_a", team_a), ("team_b", team_b)):
        for name, handedness in players:
            lines += ["", f"[[{team}.players]]", f'name = "{name}"', f'handedness = "{handedness}"']
    for section, table in (("franchise_match", franchise_match), ("video", video)):
        if table is not None:
            lines += ["", f"[{section}]"]
            lines += [f'{key} = "{value}"' for key, value in table.items()]
    return "\n".join(lines) + "\n"


def write(tmp_path: Path, text: str, name: str = "match.toml") -> Path:
    path = tmp_path / name
    path.write_text(text)
    return path


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, str, str]:
    code = main(list(argv))
    out, err = capsys.readouterr()
    return code, out, err


# --- CLI round trip -----------------------------------------------------------------------


def test_new_add_list_round_trip(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    db = str(tmp_path / "log.duckdb")
    roster_file = tmp_path / "rosters" / "atlanta" / "qf.toml"

    code, out, _ = run(capsys, "match", "new", str(roster_file))
    assert code == 0
    assert out.strip() == str(roster_file)
    template = tomllib.loads(roster_file.read_text())
    match_id = UUID(template["id"])

    filled = roster_toml(
        match_id=match_id,
        video={"url": "https://youtu.be/abc", "video_id": "abc", "path": "../../footage/abc.mp4"},
    )
    roster_file.write_text(filled)
    code, out, err = run(capsys, "match", "add", str(roster_file), "--db", db)
    assert code == 0
    assert out.strip() == str(match_id)
    assert f"Rally Log: {Path(db).resolve()}" in err

    code, out, err = run(capsys, "match", "list", "--db", db)
    assert code == 0
    assert f"Rally Log: {Path(db).resolve()}" in err
    assert out.splitlines() == [
        f"{match_id}  PPA Atlanta Open 2026  Anna Bright / Ben Johns  vs  Cara Lee / Dan Kim  video"
    ]

    with RallyLog.open(db) as log:
        match = log.load_match(MatchId(match_id))
    assert match.games == ()
    assert match.source_video is not None
    assert match.source_video.path == Path("footage/abc.mp4")


def test_roster_video_path_recording_rules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    proj = tmp_path / "proj"
    external = tmp_path / "external"
    cwd = tmp_path / "unrelated_cwd"
    for d in (proj / "rosters", external, cwd):
        d.mkdir(parents=True)
    monkeypatch.chdir(cwd)
    db = proj / "rally_log.duckdb"

    cases = [
        # Relative to Roster File inside Rally Log dir -> recorded relative to Rally Log dir.
        (proj / "rosters" / "a.toml", "../footage/a.mp4", Path("footage/a.mp4")),
        # Relative to Roster File outside Rally Log dir -> recorded absolute.
        (external / "b.toml", "clips/b.mp4", (external / "clips" / "b.mp4").resolve()),
        # Absolute path inside Rally Log dir -> recorded relative to Rally Log dir.
        (external / "c.toml", str((proj / "footage" / "c.mp4").resolve()), Path("footage/c.mp4")),
        # Absolute path outside Rally Log dir -> recorded absolute.
        (
            proj / "rosters" / "d.toml",
            str((external / "d.mp4").resolve()),
            (external / "d.mp4").resolve(),
        ),
    ]
    for roster_path, raw_video_path, expected in cases:
        mid = uuid4()
        roster_path.write_text(
            roster_toml(
                match_id=mid,
                video={"url": "https://youtu.be/v", "video_id": "v", "path": raw_video_path},
            )
        )
        code, _, _ = run(capsys, "match", "add", str(roster_path), "--db", str(db))
        assert code == 0, roster_path
        with RallyLog.open(db) as log:
            loaded = log.load_match(MatchId(mid))
        assert loaded.source_video is not None
        assert loaded.source_video.path == expected


def test_match_add_warns_when_roster_video_is_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "rally_log.duckdb"
    (tmp_path / "footage").mkdir()
    present_video = tmp_path / "footage" / "present.mp4"
    present_video.write_bytes(b"video")

    missing_roster = write(
        tmp_path,
        roster_toml(
            video={"url": "https://youtu.be/m", "video_id": "m", "path": "footage/nope.mp4"}
        ),
        "missing.toml",
    )
    code, _, err = run(capsys, "match", "add", str(missing_roster), "--db", str(db))
    assert code == 0
    assert "warning: source video not found" in err

    present_roster = write(
        tmp_path,
        roster_toml(
            video={"url": "https://youtu.be/p", "video_id": "p", "path": "footage/present.mp4"}
        ),
        "present.toml",
    )
    code, _, err = run(capsys, "match", "add", str(present_roster), "--db", str(db))
    assert code == 0
    assert "warning:" not in err


def test_new_refuses_to_overwrite(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    existing = write(tmp_path, "keep me")
    code, _, err = run(capsys, "match", "new", str(existing))
    assert code == 1
    assert "already exists" in err
    assert existing.read_text() == "keep me"


def test_template_is_a_roster_file_once_filled_in() -> None:
    text = roster_template()
    for name in ["Open 2026", "A1", "A2", "B1", "B2"]:
        text = text.replace('name = ""', f'name = "{name}"', 1)
    roster = parse_roster(text)
    assert roster.tour is Tour.PPA
    assert roster.video is None


def test_list_without_database_fails(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, _, err = run(capsys, "match", "list", "--db", str(tmp_path / "missing.duckdb"))
    assert code == 1
    assert "not found" in err


def test_list_filters_by_tournament(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    db = str(tmp_path / "log.duckdb")
    other = {"name": "APP Chicago 2026", "tour": "app"}
    run(capsys, "match", "add", str(write(tmp_path, roster_toml(), "a.toml")), "--db", db)
    run(
        capsys,
        "match",
        "add",
        str(write(tmp_path, roster_toml(tournament=other), "b.toml")),
        "--db",
        db,
    )

    code, out, _ = run(capsys, "match", "list", "--db", db, "--tournament", "APP Chicago 2026")
    assert code == 0
    assert len(out.splitlines()) == 1
    assert "APP Chicago 2026" in out


# --- Reuse and refusal --------------------------------------------------------------------


def test_players_and_teams_are_reused_across_matches(tmp_path: Path) -> None:
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        first = set_up_match(log, parse_roster(roster_toml()))
        # Same pair, listed the other way round, against new opponents.
        second = set_up_match(
            log,
            parse_roster(
                roster_toml(
                    team_a=(("Ben Johns", "right"), ("Anna Bright", "right")),
                    team_b=(("Eve Park", "left"), ("Finn Ross", "right")),
                )
            ),
        )
        assert second.tournament_id == first.tournament_id
        assert second.team_a_id == first.team_a_id
        assert second.team_b_id != first.team_b_id
        # The reused Team means its Players were found by name, not added again.
        anna, ben = log.find_player("Anna Bright"), log.find_player("Ben Johns")
        assert anna is not None and ben is not None
        assert set(log.get_team(second.team_a_id).player_ids) == {anna.id, ben.id}


def test_handedness_mismatch_fails_without_writing(tmp_path: Path) -> None:
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        set_up_match(log, parse_roster(roster_toml()))
        clash = parse_roster(
            roster_toml(
                team_a=(("Anna Bright", "left"), ("Zoe New", "right")),
                team_b=(("Cara Lee", "left"), ("Dan Kim", "right")),
            )
        )
        with pytest.raises(RosterError, match="Anna Bright is stored as right-handed"):
            set_up_match(log, clash)
        assert not log.has_match(clash.match_id)
        assert log.find_player("Zoe New") is None
        anna = log.find_player("Anna Bright")
        assert anna is not None
        assert anna.handedness is Handedness.RIGHT


def test_concurrent_match_setup_reuses_roster_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = tmp_path / "log.duckdb"
    with RallyLog.open(db):
        pass
    start = Barrier(2)
    reads = Barrier(2)
    list_players = RallyLog.list_players

    def read_players_together(log: RallyLog) -> list[Player]:
        players = list_players(log)
        # Without the setup lock, both connections see the empty roster before either writes.
        # With the lock, the first reader continues on timeout and commits before the second.
        with suppress(BrokenBarrierError):
            reads.wait(timeout=1.0)
        return players

    monkeypatch.setattr(RallyLog, "list_players", read_players_together)

    def create() -> MatchId:
        with RallyLog.open(db) as log:
            start.wait(timeout=5)
            return set_up_match(log, parse_roster(roster_toml())).id

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(create)
        second = pool.submit(create)
        assert first.result() != second.result()

    with RallyLog.open(db) as log:
        assert len(log.list_matches()) == 2
        assert len(log.list_tournaments()) == 1
        assert len(log.list_players()) == 4


def test_existing_match_is_refused_and_its_games_kept(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db = tmp_path / "log.duckdb"
    roster_file = write(tmp_path, roster_toml())
    assert run(capsys, "match", "add", str(roster_file), "--db", str(db))[0] == 0
    match_id = MatchId(UUID(tomllib.loads(roster_file.read_text())["id"]))
    with RallyLog.open(db) as log:
        match = log.load_match(match_id)
        log.save_match(replace(match, games=(Game(1),)))

    code, _, err = run(capsys, "match", "add", str(roster_file), "--db", str(db))
    assert code == 1
    assert "already exists" in err
    with RallyLog.open(db) as log:
        assert log.load_match(match_id).games == (Game(1),)


# --- MLP ----------------------------------------------------------------------------------

MLP = {"name": "MLP Dallas 2026", "tour": "mlp"}
DALLAS_VS_MIAMI = {"franchise_a": "Dallas Flash", "franchise_b": "Miami Pickleball Club"}


def test_roster_trims_outer_whitespace_and_reuses_records(tmp_path: Path) -> None:
    first = parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
    padded = parse_roster(
        roster_toml(
            tournament={**MLP, "name": " MLP Dallas 2026 "},
            team_a=(("Anna Bright ", "right"), (" Ben Johns", "right")),
            franchise_match={**DALLAS_VS_MIAMI, "franchise_a": "Dallas Flash "},
        )
    )
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        match = set_up_match(log, first)
        reused = set_up_match(log, padded)

        assert replace(reused, id=match.id) == match


@pytest.mark.parametrize(
    ("tournament", "team_a", "franchise_match", "suggestion"),
    [
        (
            MLP,
            (("  anna  BRIGHT ", "right"), ("Ben Johns", "right")),
            DALLAS_VS_MIAMI,
            "Anna Bright",
        ),
        (
            MLP,
            (("Anna Bright", "right"), ("Ben Johns", "right")),
            {**DALLAS_VS_MIAMI, "franchise_a": "dallas   flash"},
            "Dallas Flash",
        ),
        (
            {"name": "mlp  dallas 2026", "tour": "app"},
            (("Anna Bright", "right"), ("Ben Johns", "right")),
            None,
            MLP["name"],
        ),
    ],
)
def test_normalized_names_suggest_the_existing_spelling(
    tmp_path: Path,
    tournament: dict[str, str],
    team_a: tuple[tuple[str, str], ...],
    franchise_match: dict[str, str] | None,
    suggestion: str,
) -> None:
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        set_up_match(
            log, parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
        )
        roster = parse_roster(
            roster_toml(tournament=tournament, team_a=team_a, franchise_match=franchise_match)
        )
        with pytest.raises(RosterError, match=f"did you mean '{suggestion}'"):
            set_up_match(log, roster)
        assert not log.has_match(roster.match_id)


def test_tournament_name_cannot_be_reused_on_another_tour(tmp_path: Path) -> None:
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        set_up_match(log, parse_roster(roster_toml()))
        roster = parse_roster(roster_toml(tournament={**PPA, "tour": "app"}))
        with pytest.raises(RosterError, match="is on the PPA Tour"):
            set_up_match(log, roster)


def test_exact_match_wins_over_legacy_duplicates(tmp_path: Path) -> None:
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        following = parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
        first = set_up_match(
            log, parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
        )
        log.save_player(Player(PlayerId(uuid4()), "ANNA BRIGHT", Handedness.LEFT))
        log.save_tournament(Tournament(TournamentId(uuid4()), MLP["name"], Tour.APP))
        log.save_tournament(Tournament(TournamentId(uuid4()), MLP["name"].upper(), Tour.MLP))
        log.save_franchise(Franchise(FranchiseId(uuid4()), "DALLAS FLASH"))

        reused = set_up_match(log, following)

        assert reused.tournament_id == first.tournament_id
        assert reused.team_a_id == first.team_a_id
        assert reused.franchise_match_id == first.franchise_match_id
        assert len(log.list_players()) == 5
        assert len(log.list_tournaments()) == 3
        assert len(log.list_franchises()) == 3


def test_mlp_matches_share_one_franchise_match(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        womens = set_up_match(
            log, parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
        )
        # Entered with the Franchises the other way round: Miami's pair is Team A in the file.
        mens = set_up_match(
            log,
            parse_roster(
                roster_toml(
                    tournament=MLP,
                    team_a=(("Miami One", "right"), ("Miami Two", "left")),
                    team_b=(("Dallas One", "right"), ("Dallas Two", "right")),
                    franchise_match={
                        "franchise_a": "Miami Pickleball Club",
                        "franchise_b": "Dallas Flash",
                    },
                )
            ),
        )
        assert mens.franchise_match_id == womens.franchise_match_id
        assert womens.franchise_match_id is not None
        stored = log.get_franchise_match(womens.franchise_match_id)
        dallas = log.find_franchise("Dallas Flash")
        assert dallas is not None
        assert stored.franchise_a_id == dallas.id
        # Team A always plays for the Franchise Match's Franchise A (Dallas).
        dallas_one = log.find_player("Dallas One")
        assert dallas_one is not None
        assert dallas_one.id in log.get_team(mens.team_a_id).player_ids

        summaries = log.list_matches()
    assert {(s.franchise_a, s.franchise_b) for s in summaries} == {
        ("Dallas Flash", "Miami Pickleball Club")
    }


def test_mlp_listing_names_franchises(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    db = str(tmp_path / "log.duckdb")
    text = roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI)
    run(capsys, "match", "add", str(write(tmp_path, text)), "--db", db)
    _, out, _ = run(capsys, "match", "list", "--db", db)
    assert "(Dallas Flash vs Miami Pickleball Club)  no video" in out


def test_second_meeting_needs_a_pinned_franchise_match(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    group, final = uuid4(), uuid4()
    db = tmp_path / "log.duckdb"
    with RallyLog.open(db) as log:
        for pinned in (group, final):
            set_up_match(
                log,
                parse_roster(
                    roster_toml(
                        tournament=MLP, franchise_match={**DALLAS_VS_MIAMI, "id": str(pinned)}
                    )
                ),
            )
        ambiguous = parse_roster(
            roster_toml(
                tournament=MLP,
                team_a=(("New Dallas One", "right"), ("New Dallas Two", "left")),
                franchise_match=DALLAS_VS_MIAMI,
            )
        )
        with pytest.raises(RosterError, match="met more than once"):
            set_up_match(log, ambiguous)
        assert not log.has_match(ambiguous.match_id)
        assert log.find_player("New Dallas One") is None
        pinned_final = set_up_match(
            log,
            parse_roster(
                roster_toml(tournament=MLP, franchise_match={**DALLAS_VS_MIAMI, "id": str(final)})
            ),
        )
        assert pinned_final.franchise_match_id == final

    unpinned = write(tmp_path, roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
    code, _, err = run(capsys, "match", "add", str(unpinned), "--db", str(db))
    assert code == 1
    assert str(group) in err and str(final) in err
    assert "Give [franchise_match] id to pick one" in err


def test_pinned_franchise_match_must_agree(tmp_path: Path) -> None:
    pinned = str(uuid4())
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        set_up_match(
            log,
            parse_roster(
                roster_toml(tournament=MLP, franchise_match={**DALLAS_VS_MIAMI, "id": pinned})
            ),
        )
        other = {"franchise_a": "Dallas Flash", "franchise_b": "St. Louis Shock", "id": pinned}
        clash = parse_roster(
            roster_toml(
                tournament={"name": "MLP Columbus 2026", "tour": "mlp"},
                team_a=(("Shock One", "right"), ("Shock Two", "left")),
                franchise_match=other,
            )
        )
        with pytest.raises(RosterError, match="other Franchises"):
            set_up_match(log, clash)
        assert not log.has_match(clash.match_id)
        assert log.find_franchise("St. Louis Shock") is None
        assert log.find_player("Shock One") is None
        assert log.find_tournament("MLP Columbus 2026", Tour.MLP) is None


def test_failed_write_rolls_back_the_whole_setup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        roster = parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))

        def fail(*_: object) -> None:
            raise RuntimeError("disk full")

        monkeypatch.setattr(log, "_insert_content", fail)
        with pytest.raises(RuntimeError, match="disk full"):
            set_up_match(log, roster)
        assert not log.has_match(roster.match_id)
        assert log.find_tournament("MLP Dallas 2026", Tour.MLP) is None
        assert log.find_player("Anna Bright") is None
        assert log.find_franchise("Dallas Flash") is None

        monkeypatch.undo()
        set_up_match(log, roster)
        assert log.has_match(roster.match_id)


# --- Malformed Roster Files ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (roster_toml(tournament=MLP), "needs a Franchise Match"),
        (roster_toml(franchise_match=DALLAS_VS_MIAMI), "only MLP Matches"),
        (roster_toml(team_a=(("Solo", "right"),)), "exactly two"),
        (
            roster_toml(team_b=(("Anna Bright", "right"), ("Dan Kim", "right"))),
            "can't appear twice",
        ),
        (roster_toml(team_a=(("A", "ambi"), ("B", "right"))), "left \\| right"),
        (roster_toml(tournament={"name": "X", "tour": "wpt"}), "ppa \\| app \\| mlp"),
        (roster_toml(tournament={"name": " ", "tour": "ppa"}), "name must be non-empty"),
        ('id = "nope"\n' + roster_toml().split("\n", 1)[1], "not a UUID"),
        (roster_toml().split("\n", 1)[1], "missing id"),
        (roster_toml() + 'extra = "x"\n', "unknown keys: extra"),
        (roster_toml(video={"url": "u", "video_id": "v"}), "\\[video\\] is missing path"),
        ("id = [", "not valid TOML"),
        (
            roster_toml(
                tournament=MLP,
                franchise_match={"franchise_a": "Dallas Flash", "franchise_b": "Dallas Flash "},
            ),
            "can't play itself",
        ),
        (
            roster_toml(tournament=MLP, franchise_match={**DALLAS_VS_MIAMI, "id": "final"}),
            "\\[franchise_match\\] id is not a UUID",
        ),
        (
            roster_toml(tournament=MLP, franchise_match={**DALLAS_VS_MIAMI, "round": "final"}),
            "\\[franchise_match\\] has unknown keys: round",
        ),
    ],
)
def test_malformed_roster_files_are_rejected(text: str, message: str) -> None:
    with pytest.raises(RosterError, match=message):
        parse_roster(text)


def test_add_reports_bad_roster_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    path = write(tmp_path, roster_toml(tournament=MLP))
    code, _, err = run(capsys, "match", "add", str(path), "--db", str(tmp_path / "log.duckdb"))
    assert code == 1
    assert err.startswith(f"error: {path}:")


def test_add_reports_missing_roster_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "nope.toml"
    code, _, err = run(capsys, "match", "add", str(path), "--db", str(tmp_path / "log.duckdb"))
    assert code == 1
    assert "cannot read Roster File" in err


def test_existing_match_error_does_not_blame_the_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    db = str(tmp_path / "log.duckdb")
    path = write(tmp_path, roster_toml())
    run(capsys, "match", "add", str(path), "--db", db)
    code, _, err = run(capsys, "match", "add", str(path), "--db", db)
    assert code == 1
    assert err.splitlines()[-1].startswith("error: Match ")


@pytest.mark.parametrize("command", ["add", "list"])
def test_a_database_that_is_not_duckdb_is_an_error_not_a_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], command: str
) -> None:
    db = write(tmp_path, "not a database", "log.duckdb")
    args = ["match", command]
    if command == "add":
        args.append(str(write(tmp_path, roster_toml())))
    code, _, err = run(capsys, *args, "--db", str(db))
    assert code == 1
    assert err.splitlines()[-1].startswith("error: ")
    assert "Traceback" not in err
