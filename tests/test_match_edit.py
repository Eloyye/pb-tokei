"""Tests for editing, merging, and deleting Match set-up (issue #112, ADR 0016)."""

from __future__ import annotations

import subprocess
import threading
from collections.abc import Sequence
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

import duckdb
import pytest
from fastapi.testclient import TestClient
from test_footage_jobs import LOCAL, URL_A
from test_roster import DALLAS_VS_MIAMI, MLP, roster_toml

from pb_tokei.annotate.app import STALE_MATCH_MESSAGE, create_app
from pb_tokei.annotate.games import games_from_domain
from pb_tokei.footage import CommandCancelledError
from pb_tokei.player_tracking import default_player_cache_dir
from pb_tokei.process import LineCallback
from pb_tokei.rally_log import (
    AnchorKind,
    Calibration,
    CameraView,
    Challenge,
    ContactKind,
    CourtPoint,
    Discipline,
    Error,
    ErrorKind,
    Game,
    Gender,
    Landmark,
    MatchId,
    ObservationGap,
    OperatorSession,
    OperatorWorkspace,
    Parity,
    PlacedLandmark,
    Player,
    PlayerAnchor,
    PlayerId,
    PlayerPosition,
    PlaySegment,
    Rally,
    RallyLog,
    RallyStatus,
    RefereeCall,
    Ruling,
    Score,
    Shot,
    ShotClass,
    SourceVideo,
    TeamEnd,
    TeamId,
    WinnerSource,
    Zone,
    inferred,
    new_id,
    observed,
)
from pb_tokei.rally_log.schema import MATCH_CONTENT_TABLES
from pb_tokei.roster import parse_roster, set_up_match


@pytest.fixture
def db(tmp_path: Path) -> Path:
    path = tmp_path / "log.duckdb"
    with RallyLog.open(path):
        pass
    return path


@pytest.fixture
def client(db: Path) -> TestClient:
    return TestClient(create_app(db), base_url=LOCAL, headers={"Origin": LOCAL})


def _add_match(db: Path, **roster_kwargs: Any) -> MatchId:
    with RallyLog.open(db) as log:
        return set_up_match(log, parse_roster(roster_toml(**roster_kwargs))).id


def _populate_full_match(db: Path, match_id: MatchId) -> dict[str, Any]:
    """Populates every annotation table and every Player/Team reference column for `match_id`."""
    with RallyLog.open(db) as log:
        roster = log.get_match_roster(match_id)
        a1, a2 = roster.team_a_players
        b1, b2 = roster.team_b_players
        team_a, team_b = roster.team_a_id, roster.team_b_id

        serve = Shot(
            shot_number=observed(1),
            hitter_id=observed(a1.id),
            contact_frame=observed(120),
            contact_zone=observed(Zone.BACKCOURT),
            shot_class=observed(ShotClass.HARD),
            contact_kind=observed(ContactKind.BOUNCE),
            erne=observed(False),
            atp=observed(False),
            landing=observed(CourtPoint(2.0, 18.0)),
            positions={
                a1.id: PlayerPosition(observed(CourtPoint(-4.0, -22.0)), observed(False)),
                a2.id: PlayerPosition(observed(CourtPoint(4.0, -21.0)), observed(False)),
                b1.id: PlayerPosition(observed(CourtPoint(4.0, 22.0)), observed(False)),
                b2.id: PlayerPosition(observed(CourtPoint(-4.0, 8.0)), observed(True)),
            },
        )
        ret = Shot(
            shot_number=observed(2),
            hitter_id=observed(b1.id),
            contact_frame=observed(180),
            contact_zone=observed(Zone.BACKCOURT),
            shot_class=observed(ShotClass.HARD),
            contact_kind=observed(ContactKind.BOUNCE),
            positions={
                a1.id: PlayerPosition(observed(CourtPoint(-4.0, -20.0)), observed(False)),
                b1.id: PlayerPosition(observed(CourtPoint(4.0, 20.0)), observed(False)),
            },
        )
        third = Shot(
            shot_number=observed(3),
            hitter_id=observed(a1.id),
            contact_frame=observed(240),
            contact_zone=observed(Zone.MIDCOURT),
            shot_class=observed(ShotClass.SOFT),
            contact_kind=observed(ContactKind.BOUNCE),
            error=Error(kind=observed(ErrorKind.NET), player_id=observed(a1.id)),
            positions={
                a1.id: PlayerPosition(observed(CourtPoint(-3.0, -14.0)), observed(False)),
            },
        )
        rally_1 = Rally(
            number=1,
            start_frame=100,
            end_frame=260,
            score=observed(Score(0, 0, 2)),
            serving_team_id=observed(team_a),
            server_id=observed(a1.id),
            returner_id=observed(b1.id),
            referee_call=observed(RefereeCall.SIDE_OUT),
            challenge=Challenge(
                challenger_id=observed(a1.id),
                original_call=observed("foot fault"),
                ruling=observed(Ruling.UPHELD),
            ),
            winner_id=observed(team_b),
            winner_source=WinnerSource.REFEREE_CALL,
            scoreboard_winner_id=observed(team_b),
            entries=(serve, ret, third),
            status=RallyStatus.DONE,
        )
        rally_2 = Rally(
            number=2,
            start_frame=300,
            end_frame=450,
            score=observed(Score(0, 0, 1)),
            serving_team_id=observed(team_b),
            server_id=observed(b1.id),
            returner_id=observed(a1.id),
            referee_call=observed(RefereeCall.SIDE_OUT),
            winner_id=inferred(team_a),
            winner_source=WinnerSource.REFEREE_CALL,
            scoreboard_winner_id=observed(team_a),
            entries=(
                Shot(
                    shot_number=observed(1),
                    hitter_id=observed(b1.id),
                    contact_frame=observed(320),
                    contact_zone=observed(Zone.BACKCOURT),
                    shot_class=observed(ShotClass.HARD),
                    contact_kind=observed(ContactKind.BOUNCE),
                ),
                ObservationGap(Parity.ODD),
                Shot(
                    shot_number=observed(4),
                    hitter_id=observed(a1.id),
                    contact_frame=observed(420),
                    contact_zone=observed(Zone.FRONTCOURT),
                    shot_class=observed(ShotClass.HARD),
                    contact_kind=observed(ContactKind.VOLLEY),
                    positions={
                        a1.id: PlayerPosition(observed(CourtPoint(-2.0, -7.5)), observed(True)),
                    },
                ),
            ),
            status=RallyStatus.DONE,
        )
        log.replace_games(match_id, [Game(1, (rally_1, rally_2))])
        log.replace_play_segments(
            match_id,
            [PlaySegment(90, 270, CameraView.MAIN), PlaySegment(290, 460, CameraView.SIDELINE)],
        )
        log.replace_calibrations(
            match_id,
            CameraView.MAIN,
            [
                Calibration(
                    CameraView.MAIN,
                    90,
                    120,
                    {
                        Landmark.NEAR_BASELINE_LEFT: PlacedLandmark(0.1, 0.9, 120),
                        Landmark.NEAR_BASELINE_RIGHT: PlacedLandmark(0.9, 0.9, 120),
                        Landmark.FAR_BASELINE_LEFT: PlacedLandmark(0.3, 0.2, 120),
                        Landmark.FAR_BASELINE_RIGHT: PlacedLandmark(0.7, 0.2, 120),
                    },
                    frozenset({Landmark.NEAR_KITCHEN_CENTRE}),
                )
            ],
        )
        log.replace_player_anchors(
            match_id,
            [
                PlayerAnchor(120, a1.id, AnchorKind.IDENTITY, 0.3, 0.8),
                PlayerAnchor(180, b1.id, AnchorKind.POSITION, 0.7, 0.2),
            ],
        )
        log.replace_team_ends(match_id, [TeamEnd(0, team_a), TeamEnd(300, team_b)])
        start = datetime(2026, 4, 12, 10, 0, tzinfo=UTC)
        log.upsert_operator_session(
            match_id,
            OperatorSession(
                new_id(),
                OperatorWorkspace.ANNOTATE,
                start,
                start + timedelta(minutes=5),
                120,
            ),
        )
        return {"a1": a1, "a2": a2, "b1": b1, "b2": b2, "team_a": team_a, "team_b": team_b}


# --- Replace Player -----------------------------------------------------------------------


def test_replace_player_rewrites_every_reference_column_and_updates_report(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(db)
    m2 = _add_match(
        db,
        tournament={"name": "PPA Austin Open 2026", "tour": "ppa"},
    )
    refs_1 = _populate_full_match(db, m1)
    refs_2 = _populate_full_match(db, m2)
    old_player: Player = refs_1["a1"]  # Anna Bright
    partner: Player = refs_1["a2"]  # Ben Johns
    old_team: TeamId = refs_1["team_a"]

    before_report = client.get(f"/api/matches/{m1}/report").json()
    old_player_stats = {
        row["id"]: row["values"][str(old_player.id)]
        for row in before_report["stats"]
        if str(old_player.id) in row["values"]
    }
    old_team_stats = {
        row["id"]: row["values"][str(old_team)]
        for row in before_report["stats"]
        if str(old_team) in row["values"]
    }
    assert old_player_stats
    assert old_team_stats

    resp = client.post(
        f"/api/matches/{m1}/replace-player",
        json={
            "from": str(old_player.id),
            "to": {"name": "Eve Park", "handedness": "left", "gender": "female"},
        },
    )
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    eve = next(p for p in detail["players"] if p["name"] == "Eve Park")
    new_team_id = TeamId(UUID(detail["team_a_id"]))
    eve_id = PlayerId(UUID(eve["id"]))
    assert eve["handedness"] == "left"
    assert new_team_id != old_team

    # Every reference column in m1 points at Eve / new_team_id, while m2 is completely untouched.
    with RallyLog.open(db) as log:
        loaded_1 = log.load_match(m1)
        assert loaded_1.team_a_id == new_team_id
        r1, r2 = loaded_1.games[0].rallies
        assert r1.serving_team_id == observed(new_team_id)
        assert r1.server_id == observed(eve_id)
        assert r1.challenge is not None and r1.challenge.challenger_id == observed(eve_id)
        assert r1.shots[0].hitter_id == observed(eve_id)
        assert eve_id in r1.shots[0].positions and old_player.id not in r1.shots[0].positions
        assert r1.shots[2].error is not None and r1.shots[2].error.player_id == observed(eve_id)
        assert r2.returner_id == observed(eve_id)
        assert r2.winner_id == inferred(new_team_id)
        assert r2.scoreboard_winner_id == observed(new_team_id)
        assert loaded_1.player_anchors[0].player_id == eve_id
        assert loaded_1.team_ends[0].near_team_id == new_team_id
        assert log.find_team(eve_id, partner.id) is not None

        # m2 still has old_player and old_team (not orphaned because m2 uses them).
        loaded_2 = log.load_match(m2)
        assert loaded_2.team_a_id == refs_2["team_a"]
        assert loaded_2.games[0].rallies[0].server_id == observed(old_player.id)
        assert log.get_player(old_player.id).name == "Anna Bright"

    # Match Report credits Eve and the new Team with every stat the old Player/Team had.
    after_report = client.get(f"/api/matches/{m1}/report").json()
    new_player_stats = {
        row["id"]: row["values"][str(eve_id)]
        for row in after_report["stats"]
        if str(eve_id) in row["values"]
    }
    new_team_stats = {
        row["id"]: row["values"][str(new_team_id)]
        for row in after_report["stats"]
        if str(new_team_id) in row["values"]
    }
    assert new_player_stats == old_player_stats
    assert new_team_stats == old_team_stats


def test_replace_player_reuses_existing_team_deletes_orphans_and_refuses_duplicates(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(db)
    # Second match already pairs Eve Park with Ben Johns -> Team(Eve, Ben) exists.
    m2 = _add_match(
        db,
        team_a=(("Eve Park", "left", "female"), ("Ben Johns", "right", "male")),
        team_b=(("Cara Lee", "left", "female"), ("Dan Kim", "right", "male")),
    )
    with RallyLog.open(db) as log:
        r1 = log.get_match_roster(m1)
        r2 = log.get_match_roster(m2)
        anna = next(p for p in r1.players if p.name == "Anna Bright")
        ben = next(p for p in r1.players if p.name == "Ben Johns")
        cara = next(p for p in r1.players if p.name == "Cara Lee")
        eve = next(p for p in r2.players if p.name == "Eve Park")
        existing_eve_ben_team = r2.team_a_id
        old_anna_ben_team = r1.team_a_id

    # Refused if target Player is already in the Match (partner, opponent, or same slot).
    for target in (ben.id, cara.id, anna.id):
        res = client.post(
            f"/api/matches/{m1}/replace-player", json={"from": str(anna.id), "to": str(target)}
        )
        assert res.status_code == 422

    # Near-duplicate new Player name is refused.
    near = client.post(
        f"/api/matches/{m1}/replace-player",
        json={
            "from": str(anna.id),
            "to": {"name": "eve  park", "handedness": "left", "gender": "female"},
        },
    )
    assert near.status_code == 422
    assert "did you mean" in near.json()["detail"]

    # Valid replace with existing Player id reuses existing Team and deletes orphaned Anna
    # and the old Team.
    ok = client.post(
        f"/api/matches/{m1}/replace-player", json={"from": str(anna.id), "to": str(eve.id)}
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["team_a_id"] == str(existing_eve_ben_team)
    with RallyLog.open(db) as log:
        assert log.find_player("Anna Bright") is None
        with pytest.raises(KeyError):
            log.get_team(old_anna_ben_team)


# --- Match details (Tournament & Franchise Match) -----------------------------------------


def test_patch_match_repoints_tournament_and_cleans_up_orphan_tournament(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(db, tournament={"name": "PPA Typo Open", "tour": "ppa"})
    m2 = _add_match(db, tournament={"name": "PPA Real Open 2026", "tour": "ppa"})
    with RallyLog.open(db) as log:
        t_typo = log.load_match(m1).tournament_id
        t_real = log.load_match(m2).tournament_id

    # Re-point m1 to existing Tournament -> t_typo becomes an orphan and is deleted.
    res = client.patch(f"/api/matches/{m1}", json={"tournament": str(t_real)})
    assert res.status_code == 200, res.text
    assert res.json()["tournament_id"] == str(t_real)
    assert res.json()["tournament"] == "PPA Real Open 2026"
    with RallyLog.open(db) as log, pytest.raises(KeyError):
        log.get_tournament(t_typo)

    # Re-point m1 to a brand-new Tournament by name & Tour (near-duplicate refused first).
    bad = client.patch(
        f"/api/matches/{m1}",
        json={"tournament": {"name": "ppa real open 2026", "tour": "ppa"}},
    )
    assert bad.status_code == 422
    created = client.patch(
        f"/api/matches/{m1}",
        json={"tournament": {"name": "APP Chicago 2026", "tour": "app"}},
    )
    assert created.status_code == 200, created.text
    assert created.json()["tournament"] == "APP Chicago 2026"
    assert created.json()["tour"] == "app"
    # t_real is still used by m2, so it survives.
    with RallyLog.open(db) as log:
        assert log.get_tournament(t_real).name == "PPA Real Open 2026"


def test_patch_match_franchise_match_set_change_swap_ambiguous_and_clear(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(db, tournament=MLP, franchise_match=DALLAS_VS_MIAMI)
    with RallyLog.open(db) as log:
        initial = log.load_match(m1)
        fm1_id = initial.franchise_match_id
        assert fm1_id is not None

    # Swap A and B when m1 is the sole Match in fm1: flips fm1 in place, keeps Team A order.
    swapped = client.patch(
        f"/api/matches/{m1}",
        json={
            "franchise_match": {
                "franchise_a": "Miami Pickleball Club",
                "franchise_b": "Dallas Flash",
                "id": str(fm1_id),
            }
        },
    )
    assert swapped.status_code == 200, swapped.text
    assert swapped.json()["franchise_a"] == "Miami Pickleball Club"
    assert swapped.json()["franchise_b"] == "Dallas Flash"
    assert swapped.json()["team_a_id"] == str(initial.team_a_id)

    # Change Franchise B to a new Franchise -> old Dallas Flash becomes an orphan and is deleted.
    changed = client.patch(
        f"/api/matches/{m1}",
        json={
            "franchise_match": {
                "franchise_a": "Miami Pickleball Club",
                "franchise_b": "Texas Ranchers",
            }
        },
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["franchise_b"] == "Texas Ranchers"
    with RallyLog.open(db) as log:
        assert log.find_franchise("Dallas Flash") is None

    # Create a second Match in a new meeting of the same two Franchises -> two meetings exist.
    m2 = _add_match(
        db,
        tournament=MLP,
        franchise_match={"franchise_a": "Miami Pickleball Club", "franchise_b": "Texas Ranchers"},
    )
    created_second = client.patch(
        f"/api/matches/{m2}",
        json={
            "franchise_match": {
                "franchise_a": "Miami Pickleball Club",
                "franchise_b": "Texas Ranchers",
                "id": None,
            }
        },
    )
    assert created_second.status_code == 200, created_second.text
    fm_a_id = changed.json()["franchise_match_id"]
    fm_b_id = created_second.json()["franchise_match_id"]
    assert fm_a_id != fm_b_id

    # Omitting `id` when two meetings exist raises AmbiguousFranchiseMatchError (422).
    ambiguous = client.patch(
        f"/api/matches/{m1}",
        json={
            "franchise_match": {
                "franchise_a": "Miami Pickleball Club",
                "franchise_b": "Texas Ranchers",
            }
        },
    )
    assert ambiguous.status_code == 422
    assert "met more than once" in ambiguous.json()["detail"]

    # Joining m2's meeting with reversed Franchises swaps m1's Team A/B without mutating m2!
    joined_swapped = client.patch(
        f"/api/matches/{m1}",
        json={
            "franchise_match": {
                "franchise_a": "Texas Ranchers",
                "franchise_b": "Miami Pickleball Club",
                "id": fm_b_id,
            }
        },
    )
    assert joined_swapped.status_code == 200, joined_swapped.text
    assert joined_swapped.json()["franchise_match_id"] == fm_b_id
    assert joined_swapped.json()["team_a_id"] == str(initial.team_b_id)
    assert client.get(f"/api/matches/{m2}").json()["franchise_a"] == "Miami Pickleball Club"

    # Clear Franchise Match on m1, then set it again.
    cleared = client.patch(f"/api/matches/{m1}", json={"franchise_match": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["franchise_match_id"] is None
    assert cleared.json()["franchise_a"] is None

    re_set = client.patch(
        f"/api/matches/{m1}",
        json={
            "franchise_match": {
                "franchise_a": "Miami Pickleball Club",
                "franchise_b": "Texas Ranchers",
            }
        },
    )
    assert re_set.status_code == 200, re_set.text
    assert re_set.json()["franchise_match_id"] == fm_b_id

    # Setting a Franchise Match on a PPA Match is refused.
    ppa_match = _add_match(db)
    refused = client.patch(
        f"/api/matches/{ppa_match}",
        json={
            "franchise_match": {
                "franchise_a": "Miami Pickleball Club",
                "franchise_b": "Texas Ranchers",
            }
        },
    )
    assert refused.status_code == 422


# --- Shared edits, dry runs, exact-name conflicts, and merges -----------------------------


def test_player_rename_handedness_dry_run_and_merge(client: TestClient, db: Path) -> None:
    m1 = _add_match(
        db,
        team_a=(("Anna Brigth", "left", "female"), ("Ben Johns", "right", "male")),
    )
    m2 = _add_match(
        db,
        team_a=(("Anna Brigth", "left", "female"), ("Cara Lee", "left", "female")),
        team_b=(("Grace Lin", "right", "female"), ("Eve Park", "right", "female")),
    )
    m3 = _add_match(
        db,
        team_a=(("Anna Bright", "right", "female"), ("Frank Wu", "right", "male")),
        team_b=(("Cara Lee", "left", "female"), ("Dan Kim", "right", "male")),
    )
    _populate_full_match(db, m1)
    with RallyLog.open(db) as log:
        typo = log.find_player("Anna Brigth")
        real = log.find_player("Anna Bright")
        ben = log.find_player("Ben Johns")
        assert typo and real and ben

    # Dry run returns affected Match count without saving.
    dry = client.patch(
        f"/api/players/{typo.id}",
        params={"dry_run": "true"},
        json={"name": "Anna B.", "handedness": "right"},
    )
    assert dry.status_code == 200, dry.text
    assert dry.json() == {
        "player": {
            "id": str(typo.id),
            "name": "Anna B.",
            "handedness": "right",
            "gender": "female",
        },
        "affected_matches": 2,
        "dry_run": True,
    }
    with RallyLog.open(db) as log:
        assert log.get_player(typo.id).name == "Anna Brigth"

    # Near-duplicate refusal (case/space mismatch against another Player).
    near = client.patch(f"/api/players/{typo.id}", json={"name": "anna  bright"})
    assert near.status_code == 422
    assert "did you mean" in near.json()["detail"]

    # Self case/spacing fix is allowed!
    self_fix = client.patch(
        f"/api/players/{typo.id}", json={"name": "anna brigth", "handedness": "right"}
    )
    assert self_fix.status_code == 200, self_fix.text
    assert self_fix.json()["affected_matches"] == 2

    # Renaming to another Player's exact name is refused with 409 + existing target info.
    conflict = client.patch(f"/api/players/{typo.id}", json={"name": "Anna Bright"})
    assert conflict.status_code == 409
    assert conflict.json()["existing_id"] == str(real.id)
    assert conflict.json()["existing_name"] == "Anna Bright"

    # Merging two Players who share a Match (typo and ben both play in m1) is refused.
    same_match = client.post(f"/api/players/{typo.id}/merge", json={"into": str(ben.id)})
    assert same_match.status_code == 422

    # Merge dry-run returns count without writing.
    merge_dry = client.post(
        f"/api/players/{typo.id}/merge",
        params={"dry_run": "true"},
        json={"into": str(real.id)},
    )
    assert merge_dry.status_code == 200, merge_dry.text
    assert merge_dry.json() == {
        "player": {
            "id": str(real.id),
            "name": "Anna Bright",
            "handedness": "right",
            "gender": "female",
        },
        "affected_matches": 2,
        "dry_run": True,
    }
    with RallyLog.open(db) as log:
        assert log.get_player(typo.id).name == "anna brigth"

    # Real merge rewrites m1 & m2 (including all annotation rows) and deletes typo + orphan Teams.
    merged = client.post(f"/api/players/{typo.id}/merge", json={"into": str(real.id)})
    assert merged.status_code == 200, merged.text
    assert merged.json()["affected_matches"] == 2
    assert merged.json()["dry_run"] is False
    with RallyLog.open(db) as log:
        with pytest.raises(KeyError):
            log.get_player(typo.id)
        assert len(log.list_match_rosters(player_id=real.id)) == 3
        m1_loaded = log.load_match(m1)
        assert m1_loaded.games[0].rallies[0].server_id == observed(real.id)
        assert m1_loaded.player_anchors[0].player_id == real.id
        assert real.id in {p.id for p in log.get_match_roster(m2).team_a_players}
        # m3 untouched.
        assert real.id in log.get_match_roster(m3).player_ids


def test_tournament_rename_tour_fix_dry_run_and_merge(client: TestClient, db: Path) -> None:
    m1 = _add_match(db, tournament={"name": "PPA Atl", "tour": "ppa"})
    m2 = _add_match(db, tournament={"name": "PPA Atlanta Open 2026", "tour": "ppa"})
    m3 = _add_match(db, tournament={"name": "APP Chicago 2026", "tour": "app"})
    m4 = _add_match(db, tournament=MLP, franchise_match=DALLAS_VS_MIAMI)
    with RallyLog.open(db) as log:
        t_short = log.load_match(m1).tournament_id
        t_full = log.load_match(m2).tournament_id
        t_app = log.load_match(m3).tournament_id
        t_mlp = log.load_match(m4).tournament_id

    # Dry run rename.
    dry = client.patch(
        f"/api/tournaments/{t_short}", params={"dry_run": "true"}, json={"name": "PPA ATL"}
    )
    assert dry.status_code == 200
    assert dry.json()["affected_matches"] == 1
    assert dry.json()["dry_run"] is True

    # Exact-name conflict on same Tour -> 409.
    conflict = client.patch(f"/api/tournaments/{t_short}", json={"name": "PPA Atlanta Open 2026"})
    assert conflict.status_code == 409
    assert conflict.json()["existing_id"] == str(t_full)

    # Combined rename + Tour change colliding with an existing Tournament on either Tour -> 422
    # (never offers a merge that would drop the Tour change or fail cross-Tour merge).
    combo_old_tour = client.patch(
        f"/api/tournaments/{t_short}",
        json={"name": "PPA Atlanta Open 2026", "tour": "mlp"},
    )
    assert combo_old_tour.status_code == 422
    combo_new_tour = client.patch(
        f"/api/tournaments/{t_short}",
        json={"name": MLP["name"], "tour": "mlp"},
    )
    assert combo_new_tour.status_code == 422
    assert "Tour" in combo_new_tour.json()["detail"]

    # Exact-name on a different Tour -> 422 (cannot merge across Tours).
    cross_rename = client.patch(f"/api/tournaments/{t_short}", json={"name": "APP Chicago 2026"})
    assert cross_rename.status_code == 422

    # Merge across Tours is refused.
    cross_merge = client.post(f"/api/tournaments/{t_short}/merge", json={"into": str(t_app)})
    assert cross_merge.status_code == 422

    # Merge on same Tour moves Matches and deletes source Tournament.
    merged = client.post(f"/api/tournaments/{t_short}/merge", json={"into": str(t_full)})
    assert merged.status_code == 200, merged.text
    assert merged.json()["affected_matches"] == 1
    with RallyLog.open(db) as log:
        assert log.load_match(m1).tournament_id == t_full
        with pytest.raises(KeyError):
            log.get_tournament(t_short)

    # Fixing an MLP Tournament's Tour to PPA clears Franchise Matches & deletes orphans.
    fix_tour = client.patch(f"/api/tournaments/{t_mlp}", json={"tour": "ppa"})
    assert fix_tour.status_code == 200, fix_tour.text
    assert fix_tour.json()["tournament"]["tour"] == "ppa"
    with RallyLog.open(db) as log:
        assert log.load_match(m4).franchise_match_id is None
        assert log.list_franchise_matches() == []
        assert log.list_franchises() == []


def test_tournament_merge_moves_franchise_matches_too(client: TestClient, db: Path) -> None:
    m1 = _add_match(
        db,
        tournament={"name": "MLP Dallas Day 1", "tour": "mlp"},
        franchise_match=DALLAS_VS_MIAMI,
    )
    m2 = _add_match(
        db,
        tournament={"name": "MLP Dallas 2026", "tour": "mlp"},
        franchise_match={"franchise_a": "Dallas Flash", "franchise_b": "Texas Ranchers"},
    )
    with RallyLog.open(db) as log:
        t1 = log.load_match(m1).tournament_id
        t2 = log.load_match(m2).tournament_id
        fm1 = log.load_match(m1).franchise_match_id
        assert fm1 is not None

    merged = client.post(f"/api/tournaments/{t1}/merge", json={"into": str(t2)})
    assert merged.status_code == 200, merged.text
    with RallyLog.open(db) as log:
        assert log.load_match(m1).tournament_id == t2
        assert log.get_franchise_match(fm1).tournament_id == t2
        with pytest.raises(KeyError):
            log.get_tournament(t1)


def test_franchise_rename_dry_run_and_merge(client: TestClient, db: Path) -> None:
    m1 = _add_match(
        db,
        tournament=MLP,
        franchise_match={"franchise_a": "Dallas", "franchise_b": "Texas Ranchers"},
    )
    m2 = _add_match(
        db,
        tournament=MLP,
        franchise_match={"franchise_a": "Dallas Flash", "franchise_b": "Miami Pickleball Club"},
    )
    with RallyLog.open(db) as log:
        f_short = log.find_franchise("Dallas")
        f_full = log.find_franchise("Dallas Flash")
        f_texas = log.find_franchise("Texas Ranchers")
        assert f_short and f_full and f_texas

    # Dry run rename.
    dry = client.patch(
        f"/api/franchises/{f_short.id}", params={"dry_run": "true"}, json={"name": "Dallas F."}
    )
    assert dry.status_code == 200
    assert dry.json()["affected_matches"] == 1
    assert dry.json()["dry_run"] is True

    # Near-duplicate refused.
    near = client.patch(f"/api/franchises/{f_short.id}", json={"name": "dallas  flash"})
    assert near.status_code == 422

    # Exact-name conflict -> 409.
    conflict = client.patch(f"/api/franchises/{f_short.id}", json={"name": "Dallas Flash"})
    assert conflict.status_code == 409
    assert conflict.json()["existing_id"] == str(f_full.id)

    # Merging Franchises that play each other in a Franchise Match is refused!
    both_sides = client.post(f"/api/franchises/{f_short.id}/merge", json={"into": str(f_texas.id)})
    assert both_sides.status_code == 422

    # Valid merge moves Franchise Match and deletes old Franchise.
    merged = client.post(f"/api/franchises/{f_short.id}/merge", json={"into": str(f_full.id)})
    assert merged.status_code == 200, merged.text
    assert merged.json()["affected_matches"] == 1
    with RallyLog.open(db) as log:
        assert log.find_franchise("Dallas") is None
        fm1 = log.load_match(m1).franchise_match_id
        assert fm1 is not None
        assert log.get_franchise_match(fm1).franchise_a_id == f_full.id
        assert log.load_match(m2).franchise_match_id is not None


# --- Delete Match -------------------------------------------------------------------------


class _BlockingRunner:
    """Blocks inside download until cancelled, simulating a running footage job."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.cancelled = threading.Event()

    def __call__(
        self,
        args: Sequence[str],
        *,
        on_stdout_line: LineCallback | None = None,
        on_stderr_line: LineCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> subprocess.CompletedProcess[str]:
        self.started.set()
        assert cancel is not None
        if cancel.wait(timeout=5.0):
            self.cancelled.set()
            raise CommandCancelledError("cancelled")
        return subprocess.CompletedProcess(list(args), 0, "", "")


def test_delete_match_clears_all_tables_and_orphans_keeps_footage_and_cancels_job(
    db: Path, tmp_path: Path
) -> None:
    m1 = _add_match(db, tournament=MLP, franchise_match=DALLAS_VS_MIAMI)
    m2 = _add_match(
        db,
        tournament={"name": "PPA Other 2026", "tour": "ppa"},
        team_a=(("Anna Bright", "right", "female"), ("Zoe Smith", "left", "male")),
        team_b=(("Max Lee", "right", "female"), ("Sam Park", "right", "male")),
    )
    _populate_full_match(db, m1)
    _populate_full_match(db, m2)

    # Create footage files and Player Tracking cache files on disk.
    footage_dir = tmp_path / "footage"
    footage_dir.mkdir(exist_ok=True)
    orig = footage_dir / "abc123.webm"
    conv = footage_dir / "abc123.60fps.mp4"
    orig.write_bytes(b"original-video")
    conv.write_bytes(b"converted-video")
    cache_dir = default_player_cache_dir(db)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / "l1_sample.npz"
    cache_file.write_bytes(b"cached-detections")
    with RallyLog.open(db) as log:
        log.set_match_source_video(m1, SourceVideo(URL_A, "abc123", Path("footage/abc123.webm")))

    runner = _BlockingRunner()
    app = create_app(db, footage_runner=runner)
    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as client:
        # Start a running footage job for m1 (fetching a new URL so it downloads).
        fetch_resp = client.post(
            f"/api/matches/{m1}/footage/fetch",
            json={"url": "https://www.youtube.com/watch?v=newvid00001"},
        )
        assert fetch_resp.status_code == 200
        assert runner.started.wait(timeout=5.0)

        deleted = client.delete(f"/api/matches/{m1}")
        assert deleted.status_code == 200, deleted.text
        assert deleted.json() == {"id": str(m1)}
        assert runner.cancelled.is_set()

        # Footage files and Player Tracking cache are kept.
        assert orig.is_file()
        assert conv.is_file()
        assert cache_file.is_file()

        # Deleting again returns 404.
        assert client.delete(f"/api/matches/{m1}").status_code == 404

    # Every table in MATCH_CONTENT_TABLES, operator_sessions, and matches has 0 rows for m1,
    # while m2's rows and shared Player (Anna Bright) survive, and m1-only orphans are gone.
    with duckdb.connect(str(db), read_only=True) as conn:
        for table in (*MATCH_CONTENT_TABLES, "operator_sessions"):
            (m1_count,) = conn.execute(
                f"SELECT count(*) FROM {table} WHERE match_id = ?", [m1]
            ).fetchone() or (0,)
            (m2_count,) = conn.execute(
                f"SELECT count(*) FROM {table} WHERE match_id = ?", [m2]
            ).fetchone() or (0,)
            assert m1_count == 0, f"{table} still has rows for deleted Match"
            assert m2_count > 0, f"{table} lost rows for surviving Match"
        (m1_row,) = conn.execute("SELECT count(*) FROM matches WHERE id = ?", [m1]).fetchone() or (
            0,
        )
        assert m1_row == 0

    with RallyLog.open(db) as log:
        assert log.find_player("Anna Bright") is not None
        assert log.find_player("Ben Johns") is None
        assert log.find_player("Cara Lee") is None
        assert log.find_player("Dan Kim") is None
        assert log.list_franchise_matches() == []
        assert log.list_franchises() == []
        assert [t.name for t in log.list_tournaments()] == ["PPA Other 2026"]


def test_failed_delete_does_not_cancel_running_footage_job(
    db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    m1 = _add_match(db)
    runner = _BlockingRunner()
    app = create_app(db, footage_runner=runner)

    def fail_delete(*_args: Any, **_kwargs: Any) -> None:
        raise duckdb.IOException("database locked by CLI")

    monkeypatch.setattr("pb_tokei.annotate.app.delete_match_record", fail_delete)

    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as client:
        fetch_resp = client.post(
            f"/api/matches/{m1}/footage/fetch",
            json={"url": "https://www.youtube.com/watch?v=newvid00002"},
        )
        assert fetch_resp.status_code == 200
        assert runner.started.wait(timeout=5.0)

        failed = client.delete(f"/api/matches/{m1}")
        assert failed.status_code == 503
        assert not runner.cancelled.is_set()
        assert client.get(f"/api/matches/{m1}/footage").json()["state"] == "downloading"
        # Clean up the running job before exiting TestClient.
        assert client.post(f"/api/matches/{m1}/footage/cancel").status_code == 200
        assert runner.cancelled.wait(timeout=5.0)


# --- Stale workspace writes ---------------------------------------------------------------


def test_stale_workspace_writes_are_rejected_after_replace_and_delete(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(db)
    refs = _populate_full_match(db, m1)
    stale_games = client.get(f"/api/matches/{m1}/games").json()
    stale_anchors = client.get(f"/api/matches/{m1}/player-anchors").json()
    stale_ends = client.get(f"/api/matches/{m1}/team-ends").json()

    # Replace Anna Bright with Eve Park in another tab.
    resp = client.post(
        f"/api/matches/{m1}/replace-player",
        json={
            "from": str(refs["a1"].id),
            "to": {"name": "Eve Park", "handedness": "left", "gender": "female"},
        },
    )
    assert resp.status_code == 200

    # Stale workspace's next saves carrying old Player/Team ids are rejected with reload message.
    for url, payload in (
        (f"/api/matches/{m1}/games", stale_games),
        (f"/api/matches/{m1}/player-anchors", stale_anchors),
        (f"/api/matches/{m1}/team-ends", stale_ends),
    ):
        res = client.put(url, json=payload)
        assert res.status_code == 422, f"{url} -> {res.status_code}"
        assert STALE_MATCH_MESSAGE in res.json()["detail"]

    # Delete the Match; every stale write endpoint returns 404 with reload message.
    assert client.delete(f"/api/matches/{m1}").status_code == 200
    session_body = {
        "workspace": "annotate",
        "started_at": "2026-04-12T10:00:00Z",
        "ended_at": "2026-04-12T10:01:00Z",
        "active_seconds": 30,
    }
    for url, payload in (
        (f"/api/matches/{m1}/games", []),
        (f"/api/matches/{m1}/play-segments", []),
        (f"/api/matches/{m1}/calibrations/main", []),
        (f"/api/matches/{m1}/player-anchors", []),
        (f"/api/matches/{m1}/team-ends", []),
        (f"/api/matches/{m1}/operator-sessions/{uuid4()}", session_body),
    ):
        res = client.put(url, json=payload)
        assert res.status_code == 404, f"{url} -> {res.status_code}"
        assert res.json()["detail"] == STALE_MATCH_MESSAGE


def test_concurrent_workspace_write_and_replace_player_never_commits_deleted_player(
    db: Path,
) -> None:
    """Serializing workspace writes with set-up edits prevents DuckDB snapshot isolation from
    committing Rallies referencing a Player replaced and orphan-deleted concurrently."""
    app = create_app(db)
    with TestClient(app, base_url=LOCAL, headers={"Origin": LOCAL}) as client:
        for iteration in range(6):
            m1 = _add_match(
                db,
                tournament={"name": f"PPA Race {iteration}", "tour": "ppa"},
                team_a=(
                    (f"Old Player {iteration}", "right", "female"),
                    (f"Partner {iteration}", "right", "male"),
                ),
                team_b=(
                    (f"Opp A {iteration}", "left", "female"),
                    (f"Opp B {iteration}", "right", "male"),
                ),
            )
            with RallyLog.open(db) as log:
                roster = log.get_match_roster(m1)
                old_player = next(
                    p for p in roster.team_a_players if p.name == f"Old Player {iteration}"
                )
                team_a = roster.team_a_id

            games_payload = [
                g.model_dump(mode="json")
                for g in games_from_domain(
                    (
                        Game(
                            1,
                            (
                                Rally(
                                    number=1,
                                    start_frame=100,
                                    end_frame=200,
                                    serving_team_id=observed(team_a),
                                    server_id=observed(old_player.id),
                                    status=RallyStatus.IN_PROGRESS,
                                ),
                            ),
                        ),
                    )
                )
            ]

            barrier = threading.Barrier(2)
            results: dict[str, Any] = {}

            def save_games(
                mid: MatchId = m1,
                body: list[dict[str, Any]] = games_payload,
                gate: threading.Barrier = barrier,
                out: dict[str, Any] = results,
            ) -> None:
                gate.wait()
                out["save"] = client.put(f"/api/matches/{mid}/games", json=body)

            def replace_player(
                mid: MatchId = m1,
                pid: PlayerId = old_player.id,
                idx: int = iteration,
                gate: threading.Barrier = barrier,
                out: dict[str, Any] = results,
            ) -> None:
                gate.wait()
                out["replace"] = client.post(
                    f"/api/matches/{mid}/replace-player",
                    json={
                        "from": str(pid),
                        "to": {
                            "name": f"New Player {idx}",
                            "handedness": "left",
                            "gender": "female",
                        },
                    },
                )

            t1 = threading.Thread(target=save_games)
            t2 = threading.Thread(target=replace_player)
            t1.start()
            t2.start()
            t1.join()
            t2.join()

            assert results["replace"].status_code == 200
            save_res = results["save"]
            with RallyLog.open(db) as log:
                assert log.find_player(f"Old Player {iteration}") is None
                new_player = log.find_player(f"New Player {iteration}")
                assert new_player is not None
                loaded = log.load_match(m1)
                if save_res.status_code == 200:
                    # Save ran before replace: replace must have rewritten the saved Rally.
                    assert loaded.games[0].rallies[0].server_id == observed(new_player.id)
                else:
                    # Replace ran before save: save must have been rejected with reload message.
                    assert save_res.status_code == 422
                    assert STALE_MATCH_MESSAGE in save_res.json()["detail"]
                    assert loaded.games == ()


# --- Legacy FK schema migration -----------------------------------------------------------


def test_legacy_database_with_foreign_keys_migrates_for_edits_and_deletes(tmp_path: Path) -> None:
    path = tmp_path / "legacy_fk.duckdb"
    t_id, p1, p2, p3, p4 = new_id(), new_id(), new_id(), new_id(), new_id()
    team_a, team_b, match_id = new_id(), new_id(), new_id()
    f_a, f_b, fm_id = new_id(), new_id(), new_id()
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
            "CREATE TABLE teams (id UUID PRIMARY KEY, "
            "player_low_id UUID NOT NULL REFERENCES players (id), "
            "player_high_id UUID NOT NULL REFERENCES players (id), "
            "CHECK (player_low_id < player_high_id), UNIQUE (player_low_id, player_high_id))"
        )
        conn.execute("CREATE TABLE franchises (id UUID PRIMARY KEY, name VARCHAR NOT NULL)")
        conn.execute(
            "CREATE TABLE franchise_matches (id UUID PRIMARY KEY, "
            "tournament_id UUID NOT NULL REFERENCES tournaments (id), "
            "franchise_a_id UUID NOT NULL REFERENCES franchises (id), "
            "franchise_b_id UUID NOT NULL REFERENCES franchises (id))"
        )
        # Deliberately put columns in legacy ALTER TABLE ADD COLUMN order (annotation_mode and
        # date at the end) to verify column-name copy rather than positional SELECT *.
        conn.execute(
            "CREATE TABLE matches (id UUID PRIMARY KEY, "
            "tournament_id UUID NOT NULL REFERENCES tournaments (id), "
            "team_a_id UUID NOT NULL REFERENCES teams (id), "
            "team_b_id UUID NOT NULL REFERENCES teams (id), "
            "franchise_match_id UUID REFERENCES franchise_matches (id), "
            "source_video_url VARCHAR, source_video_id VARCHAR, "
            "source_video_path VARCHAR, source_video_frames INTEGER, "
            "annotation_mode VARCHAR NOT NULL DEFAULT 'gold', "
            "date DATE)"
        )
        conn.execute("INSERT INTO tournaments VALUES (?, 'MLP Legacy', 'mlp')", [t_id])
        for pid, name in ((p1, "A1"), (p2, "A2"), (p3, "B1"), (p4, "B2")):
            conn.execute("INSERT INTO players VALUES (?, ?, 'right')", [pid, name])
        low_a, high_a = sorted((p1, p2))
        low_b, high_b = sorted((p3, p4))
        conn.execute("INSERT INTO teams VALUES (?, ?, ?)", [team_a, low_a, high_a])
        conn.execute("INSERT INTO teams VALUES (?, ?, ?)", [team_b, low_b, high_b])
        conn.execute("INSERT INTO franchises VALUES (?, 'FA'), (?, 'FB')", [f_a, f_b])
        conn.execute("INSERT INTO franchise_matches VALUES (?, ?, ?, ?)", [fm_id, t_id, f_a, f_b])
        conn.execute(
            "INSERT INTO matches (id, tournament_id, team_a_id, team_b_id, franchise_match_id, "
            "annotation_mode, date) VALUES (?, ?, ?, ?, ?, 'assisted', DATE '2026-04-10')",
            [match_id, t_id, team_a, team_b, fm_id],
        )

    # Opening migrates away FKs by column name so values survive and delete_match + orphan
    # cleanup works in one transaction.
    with RallyLog.open(path) as log:
        summary = log.get_match_summary(MatchId(match_id))
        assert summary.date == datetime(2026, 4, 10, tzinfo=UTC).date()
        assert summary.annotation_mode.value == "assisted"
        log.delete_match(MatchId(match_id))
        assert log.list_matches() == []
        assert log.list_players() == []
        assert log.list_tournaments() == []
        assert log.list_franchises() == []
        assert log.list_franchise_matches() == []


# --- Origin & Rally Log checks on every endpoint ------------------------------------------


def test_every_edit_merge_and_delete_endpoint_checks_origin_and_rally_log(
    client: TestClient, db: Path, tmp_path: Path
) -> None:
    m1 = _add_match(db, tournament=MLP, franchise_match=DALLAS_VS_MIAMI)
    with RallyLog.open(db) as log:
        roster = log.get_match_roster(m1)
        p1 = roster.team_a_players[0]
        setup = log.get_match_setup(m1)
        t1 = setup.tournament
        assert setup.franchise_match is not None
        f1 = setup.franchise_match.franchise_a_id
        f2 = setup.franchise_match.franchise_b_id

    calls: list[tuple[str, str, dict[str, Any] | None]] = [
        ("PATCH", f"/api/matches/{m1}", {"date": "2026-05-01"}),
        (
            "POST",
            f"/api/matches/{m1}/replace-player",
            {
                "from": str(p1.id),
                "to": {"name": "New Player", "handedness": "left", "gender": "female"},
            },
        ),
        ("DELETE", f"/api/matches/{m1}", None),
        ("PATCH", f"/api/players/{p1.id}", {"name": "Renamed Player"}),
        ("POST", f"/api/players/{p1.id}/merge", {"into": str(uuid4())}),
        ("PATCH", f"/api/tournaments/{t1.id}", {"name": "Renamed Tournament"}),
        ("POST", f"/api/tournaments/{t1.id}/merge", {"into": str(uuid4())}),
        ("PATCH", f"/api/franchises/{f1}", {"name": "Renamed Franchise"}),
        ("POST", f"/api/franchises/{f1}/merge", {"into": str(f2)}),
    ]

    no_origin = TestClient(create_app(db), base_url=LOCAL)
    for method, url, payload in calls:
        missing = no_origin.request(method, url, json=payload)
        assert missing.status_code == 403, f"missing Origin allowed on {method} {url}"
        foreign = client.request(
            method, url, json=payload, headers={"Origin": "https://evil.example"}
        )
        assert foreign.status_code == 403, f"foreign Origin allowed on {method} {url}"

    # Verify switched Rally Log (409) blocks writes on the old Rally Log too.
    other = tmp_path / "other.duckdb"
    switched = client.post("/api/rally-log", json={"path": str(other), "create": True})
    assert switched.status_code == 200
    old_log = {"X-Rally-Log": quote(str(db.resolve()))}
    for method, url, payload in calls:
        stale = client.request(method, url, json=payload, headers=old_log)
        assert stale.status_code == 409, f"stale X-Rally-Log allowed on {method} {url}"

    # Original DB is completely unchanged.
    with RallyLog.open(db) as log:
        assert log.has_match(m1)
        assert log.get_player(p1.id).name == p1.name
        assert log.get_tournament(t1.id).name == t1.name
        assert log.get_franchise(f1).name == "Dallas Flash"


# --- Gender and Discipline invariants on edit / replace / merge (#119) ----------------------


def test_patch_player_sets_and_changes_gender_refuses_clear_and_names_conflicts(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(db)
    with RallyLog.open(db) as log:
        anna = log.find_player("Anna Bright")
        ben = log.find_player("Ben Johns")
        assert anna is not None and ben is not None
        log.save_player(replace(anna, gender=None))
        log.save_player(replace(ben, gender=None))

    # Clearing gender explicitly is rejected with 422.
    assert client.patch(f"/api/players/{anna.id}", json={"gender": None}).status_code == 422

    # While Ben still has gender=None, setting or changing Anna's gender keeps m1 partially
    # unclassified so both dry-run and real PATCH succeed.
    dry = client.patch(
        f"/api/players/{anna.id}", params={"dry_run": "true"}, json={"gender": "male"}
    )
    assert dry.status_code == 200, dry.text
    assert dry.json()["player"]["gender"] == "male"
    assert dry.json()["affected_matches"] == 1
    assert client.patch(f"/api/players/{anna.id}", json={"gender": "male"}).status_code == 200

    # Changing Anna back to female and then setting Ben to male completes Mixed Doubles.
    assert client.patch(f"/api/players/{anna.id}", json={"gender": "female"}).status_code == 200
    assert client.patch(f"/api/players/{ben.id}", json={"gender": "male"}).status_code == 200
    assert client.get(f"/api/matches/{m1}").json()["discipline"] == "mixed_doubles"

    # Now flipping Anna to male breaks m1 (Men's Doubles vs Mixed Doubles) -> 422 on both
    # dry_run=true and dry_run=false, naming the conflicting Match and leaving DB untouched.
    for dry_flag in ("true", "false"):
        bad = client.patch(
            f"/api/players/{anna.id}",
            params={"dry_run": dry_flag},
            json={"gender": "male"},
        )
        assert bad.status_code == 422
        assert "PPA Atlanta Open 2026" in bad.json()["detail"]

    # Clearing once set is still refused with 422.
    assert client.patch(f"/api/players/{anna.id}", json={"gender": None}).status_code == 422
    with RallyLog.open(db) as log:
        assert log.get_player(anna.id).gender is Gender.FEMALE


def test_replace_player_and_merge_enforce_match_discipline_invariant(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(db)
    # Create a second Match introducing Male & Female Players we can try replacing/merging with.
    _add_match(
        db,
        tournament={"name": "PPA Austin 2026", "tour": "ppa"},
        team_a=(("Male Sub", "right", "male"), ("Male Partner", "right", "male")),
        team_b=(("Male Opp A", "right", "male"), ("Male Opp B", "right", "male")),
    )
    with RallyLog.open(db) as log:
        anna = log.find_player("Anna Bright")
        male_sub = log.find_player("Male Sub")
        assert anna is not None and male_sub is not None

    # Replace Anna (female) with Male Sub (existing UUID) in Mixed Doubles -> 422 without writing.
    bad_existing = client.post(
        f"/api/matches/{m1}/replace-player",
        json={"from": str(anna.id), "to": str(male_sub.id)},
    )
    assert bad_existing.status_code == 422
    assert "Invalid Match lineup" in bad_existing.json()["detail"]

    # Replace Anna (female) with a brand-new male Player -> 422 without writing.
    bad_new = client.post(
        f"/api/matches/{m1}/replace-player",
        json={
            "from": str(anna.id),
            "to": {"name": "New Man", "handedness": "right", "gender": "male"},
        },
    )
    assert bad_new.status_code == 422
    assert "Invalid Match lineup" in bad_new.json()["detail"]

    # Merging Anna (female in Mixed Doubles m1) into Male Sub (male) breaks m1 on both
    # dry_run=true and dry_run=false, naming m1 and leaving DB untouched.
    for dry_flag in ("true", "false"):
        bad_merge = client.post(
            f"/api/players/{anna.id}/merge",
            params={"dry_run": dry_flag},
            json={"into": str(male_sub.id)},
        )
        assert bad_merge.status_code == 422
        assert "PPA Atlanta Open 2026" in bad_merge.json()["detail"]

    with RallyLog.open(db) as log:
        assert log.find_player("New Man") is None
        assert log.get_player(anna.id).gender is Gender.FEMALE
        assert log.get_match_summary(m1).discipline is Discipline.MIXED_DOUBLES

    # Replacing by exact name of a legacy gender=None Player backfills gender atomically.
    with RallyLog.open(db) as log:
        log.save_player(replace(male_sub, gender=None))
    legacy_sub = PlayerId(new_id())
    with RallyLog.open(db) as log:
        log.save_player(Player(legacy_sub, "Legacy Sub", anna.handedness, None))
    ok = client.post(
        f"/api/matches/{m1}/replace-player",
        json={
            "from": str(anna.id),
            "to": {"name": "Legacy Sub", "handedness": "right", "gender": "female"},
        },
    )
    assert ok.status_code == 200, ok.text
    with RallyLog.open(db) as log:
        assert log.get_player(legacy_sub).gender is Gender.FEMALE
        assert log.get_match_summary(m1).discipline is Discipline.MIXED_DOUBLES


def test_merge_player_carries_gender_into_unclassified_target_and_checks_target_matches(
    client: TestClient, db: Path
) -> None:
    m1 = _add_match(
        db,
        tournament={"name": "PPA Mixed Source 2026", "tour": "ppa"},
        team_a=(("Anna Brigth", "right", "female"), ("Ben Johns", "right", "male")),
        team_b=(("Cara Lee", "left", "female"), ("Dan Kim", "right", "male")),
    )
    m2 = _add_match(
        db,
        tournament={"name": "PPA Mixed Target 2026", "tour": "ppa"},
        team_a=(("Anna Bright", "right", "female"), ("Frank Wu", "right", "male")),
        team_b=(("Grace Lin", "right", "female"), ("Henry Cho", "right", "male")),
    )
    with RallyLog.open(db) as log:
        typo = log.find_player("Anna Brigth")
        real = log.find_player("Anna Bright")
        assert typo is not None and real is not None
        log.save_player(replace(real, gender=None))
        assert log.get_match_summary(m2).discipline is None

    # Dry-run previews carrying source.gender onto target without writing.
    dry = client.post(
        f"/api/players/{typo.id}/merge",
        params={"dry_run": "true"},
        json={"into": str(real.id)},
    )
    assert dry.status_code == 200, dry.text
    assert dry.json()["player"]["gender"] == "female"
    assert dry.json()["affected_matches"] == 1
    assert dry.json()["dry_run"] is True
    with RallyLog.open(db) as log:
        assert log.get_player(real.id).gender is None
        assert log.get_match_summary(m2).discipline is None

    # Real merge carries female onto target, preserving m1's Discipline and classifying m2.
    merged = client.post(f"/api/players/{typo.id}/merge", json={"into": str(real.id)})
    assert merged.status_code == 200, merged.text
    assert merged.json()["player"]["gender"] == "female"
    assert merged.json()["affected_matches"] == 1
    with RallyLog.open(db) as log:
        with pytest.raises(KeyError):
            log.get_player(typo.id)
        assert log.get_player(real.id).gender is Gender.FEMALE
        assert log.get_match_summary(m1).discipline is Discipline.MIXED_DOUBLES
        assert log.get_match_summary(m2).discipline is Discipline.MIXED_DOUBLES

    # Refuses merging a gendered source into a gender=None target when carrying source.gender over
    # would break one of target's own existing Matches (on both dry_run=true and dry_run=false).
    m3 = _add_match(
        db,
        tournament={"name": "PPA Mens Source 2026", "tour": "ppa"},
        team_a=(("Max Typo", "right", "male"), ("Partner M", "right", "male")),
        team_b=(("Opp M1", "right", "male"), ("Opp M2", "right", "male")),
    )
    _add_match(
        db,
        tournament={"name": "PPA Womens Target 2026", "tour": "ppa"},
        team_a=(("Max Real", "right", "female"), ("Woman Partner", "right", "female")),
        team_b=(("Woman Opp1", "right", "female"), ("Woman Opp2", "right", "female")),
    )
    with RallyLog.open(db) as log:
        max_typo = log.find_player("Max Typo")
        max_real = log.find_player("Max Real")
        assert max_typo is not None and max_real is not None
        log.save_player(replace(max_real, gender=None))

    for dry_flag in ("true", "false"):
        bad = client.post(
            f"/api/players/{max_typo.id}/merge",
            params={"dry_run": dry_flag},
            json={"into": str(max_real.id)},
        )
        assert bad.status_code == 422
        assert "PPA Womens Target 2026" in bad.json()["detail"]

    with RallyLog.open(db) as log:
        assert log.get_player(max_typo.id).gender is Gender.MALE
        assert log.get_player(max_real.id).gender is None
        assert log.get_match_summary(m3).discipline is Discipline.MENS_DOUBLES
