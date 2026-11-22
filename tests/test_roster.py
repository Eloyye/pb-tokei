import tomllib
from dataclasses import replace
from pathlib import Path
from uuid import UUID, uuid4

import pytest

from pb_tokei import main
from pb_tokei.rally_log import (
    Game,
    Handedness,
    MatchId,
    RallyLog,
    Tour,
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
        video={"url": "https://youtu.be/abc", "video_id": "abc", "path": "footage/abc.mp4"},
    )
    roster_file.write_text(filled)
    code, out, _ = run(capsys, "match", "add", str(roster_file), "--db", db)
    assert code == 0
    assert out.strip() == str(match_id)

    code, out, _ = run(capsys, "match", "list", "--db", db)
    assert code == 0
    assert out.splitlines() == [
        f"{match_id}  PPA Atlanta Open 2026  Anna Bright / Ben Johns  vs  Cara Lee / Dan Kim  video"
    ]

    with RallyLog.open(db) as log:
        match = log.load_match(MatchId(match_id))
    assert match.games == ()
    assert match.source_video is not None
    assert match.source_video.path == Path("footage/abc.mp4")


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


def test_second_meeting_needs_a_pinned_franchise_match(tmp_path: Path) -> None:
    group, final = uuid4(), uuid4()
    with RallyLog.open(tmp_path / "log.duckdb") as log:
        for pinned in (group, final):
            set_up_match(
                log,
                parse_roster(
                    roster_toml(
                        tournament=MLP, franchise_match={**DALLAS_VS_MIAMI, "id": str(pinned)}
                    )
                ),
            )
        with pytest.raises(RosterError, match="met more than once"):
            set_up_match(
                log, parse_roster(roster_toml(tournament=MLP, franchise_match=DALLAS_VS_MIAMI))
            )
        pinned_final = set_up_match(
            log,
            parse_roster(
                roster_toml(tournament=MLP, franchise_match={**DALLAS_VS_MIAMI, "id": str(final)})
            ),
        )
        assert pinned_final.franchise_match_id == final


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
        with pytest.raises(RosterError, match="other Franchises"):
            set_up_match(log, parse_roster(roster_toml(tournament=MLP, franchise_match=other)))


# --- Malformed Roster Files ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "message"),
    [
        (roster_toml(tournament=MLP), "needs a \\[franchise_match\\]"),
        (roster_toml(franchise_match=DALLAS_VS_MIAMI), "only for MLP"),
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
