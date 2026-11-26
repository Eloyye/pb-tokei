"""Reading and writing the Rally Log in a DuckDB file."""

from __future__ import annotations

import os
from collections import defaultdict
from collections.abc import Callable, Generator, Sequence
from contextlib import contextmanager
from datetime import UTC
from enum import StrEnum
from pathlib import Path
from types import TracebackType
from typing import Any, Self

import duckdb

from .model import (
    UNKNOWN,
    AnchorKind,
    AnnotationMode,
    Calibration,
    CameraView,
    Certainty,
    Challenge,
    ContactKind,
    CourtPoint,
    Error,
    ErrorKind,
    Fact,
    Franchise,
    FranchiseId,
    FranchiseMatch,
    FranchiseMatchId,
    Game,
    Handedness,
    Landmark,
    Match,
    MatchId,
    MatchRoster,
    MatchSummary,
    ObservationGap,
    OperatorSession,
    OperatorTimeSummary,
    OperatorWorkspace,
    Parity,
    PlacedLandmark,
    Player,
    PlayerAnchor,
    PlayerId,
    PlayerPosition,
    PlaySegment,
    Rally,
    RefereeCall,
    Ruling,
    Score,
    Shot,
    ShotClass,
    SourceVideo,
    Team,
    TeamEnd,
    TeamId,
    Tour,
    Tournament,
    TournamentId,
    WinnerSource,
    Zone,
    check_calibrations,
    check_play_segments,
    check_player_anchors,
    check_team_ends,
    check_video_frames,
)
from .schema import MATCH_CONTENT_TABLES, STATEMENTS, migrate

Row = tuple[Any, ...]

DEFAULT_DB_PATH = Path("rally_log.duckdb")
"""Fallback Rally Log filename in the current directory when `--db` and state aren't set."""

_OPERATOR_TOTALS = """
    COALESCE(SUM(active_seconds) FILTER (WHERE workspace = 'calibrate'), 0) AS calibrate_seconds,
    COALESCE(SUM(active_seconds) FILTER (WHERE workspace = 'annotate'), 0) AS annotate_seconds,
    COALESCE(SUM(active_seconds) FILTER (WHERE workspace = 'review'), 0) AS review_seconds
"""


def stored_video_path(video_path: Path, db_path: Path) -> Path:
    """Path to record in a Rally Log for `video_path` (ADR 0007).

    Relative to the Rally Log's directory when the video lives inside it; absolute otherwise.
    Lexical paths are checked before symlink resolution so a symlinked `footage/` inside the
    Rally Log's directory still records as `footage/...`.
    """
    lexical_video = Path(os.path.abspath(video_path))
    lexical_dir = Path(os.path.abspath(db_path)).parent
    try:
        return lexical_video.relative_to(lexical_dir)
    except ValueError:
        pass

    # Handle symlinked ancestors (e.g. /tmp -> /private/tmp on macOS) without dereferencing a
    # symlinked `footage/` subdirectory inside the Rally Log's directory.
    resolved_dir = db_path.resolve().parent
    for ancestor in lexical_video.parents:
        if ancestor.resolve() == resolved_dir:
            return lexical_video.relative_to(ancestor)

    resolved_video = video_path.resolve()
    try:
        return resolved_video.relative_to(resolved_dir)
    except ValueError:
        return resolved_video


def resolve_video_path(stored_path: Path, db_path: Path) -> Path:
    """Resolves a recorded `SourceVideo.path` against the Rally Log's directory (ADR 0007)."""
    if stored_path.is_absolute():
        return stored_path
    return Path(os.path.abspath(db_path.resolve().parent / stored_path))


class MatchNotFound(KeyError):
    """No Match with this id is in the Rally Log."""

    def __init__(self, match_id: MatchId) -> None:
        super().__init__(match_id)
        self.match_id = match_id

    def __str__(self) -> str:
        return f"Match not found: {self.match_id}"


class RallyLog:
    """The Rally Log store. Open it with `RallyLog.open(path)`; the schema is created if missing."""

    def __init__(self, connection: duckdb.DuckDBPyConnection) -> None:
        self._db = connection
        self._transaction_depth = 0
        for statement in STATEMENTS:
            self._db.execute(statement)
        migrate(self._db)

    @classmethod
    def open(cls, path: Path | str) -> Self:
        return cls(duckdb.connect(str(path)))

    @staticmethod
    def is_rally_log(path: Path | str) -> bool:
        """Whether the DuckDB file at `path` holds a Rally Log, checked without changing it
        (opening it would add the schema to any DuckDB file). Raises `duckdb.Error` if it can't
        be read as a DuckDB file."""
        with duckdb.connect(str(path), read_only=True) as db:
            found = db.execute(
                "SELECT 1 FROM duckdb_tables() WHERE table_name = 'matches'"
            ).fetchone()
        return found is not None

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    @contextmanager
    def transaction(self) -> Generator[None]:
        """Runs the writes inside it as one transaction: all of them commit, or none do.

        Nested uses join the outermost transaction, so a method that needs a transaction (such
        as `save_match`) can also run inside a larger one.
        """
        if self._transaction_depth:
            self._transaction_depth += 1
            try:
                yield
            finally:
                self._transaction_depth -= 1
            return
        self._db.execute("BEGIN TRANSACTION")
        self._transaction_depth = 1
        try:
            yield
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")
        finally:
            self._transaction_depth = 0

    # --- Roster ---------------------------------------------------------------------------

    def save_tournament(self, tournament: Tournament) -> None:
        self._upsert(
            "tournaments",
            ["id", "name", "tour"],
            [tournament.id, tournament.name, tournament.tour.value],
        )

    def get_tournament(self, tournament_id: TournamentId) -> Tournament:
        id_, name, tour = self._one("SELECT * FROM tournaments WHERE id = ?", tournament_id)
        return Tournament(TournamentId(id_), name, Tour(tour))

    def list_tournaments(self) -> list[Tournament]:
        return [
            Tournament(TournamentId(id_), name, Tour(tour))
            for id_, name, tour in self._all("SELECT * FROM tournaments ORDER BY name, tour, id")
        ]

    def save_player(self, player: Player) -> None:
        self._upsert(
            "players",
            ["id", "name", "handedness"],
            [player.id, player.name, player.handedness.value],
        )

    def get_player(self, player_id: PlayerId) -> Player:
        id_, name, handedness = self._one("SELECT * FROM players WHERE id = ?", player_id)
        return Player(PlayerId(id_), name, Handedness(handedness))

    def list_players(self) -> list[Player]:
        return [
            Player(PlayerId(id_), name, Handedness(handedness))
            for id_, name, handedness in self._all("SELECT * FROM players ORDER BY name, id")
        ]

    def save_team(self, team: Team) -> None:
        """Saves a Team. Saving a second Team with the same two Players fails."""
        low, high = team.player_ids
        self._db.execute(
            "INSERT INTO teams VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING", [team.id, low, high]
        )

    def get_team(self, team_id: TeamId) -> Team:
        return _team(self._one("SELECT * FROM teams WHERE id = ?", team_id))

    def find_team(self, player_a: PlayerId, player_b: PlayerId) -> Team | None:
        low, high = sorted((player_a, player_b))
        row = self._db.execute(
            "SELECT * FROM teams WHERE player_low_id = ? AND player_high_id = ?", [low, high]
        ).fetchone()
        return None if row is None else _team(row)

    def save_franchise(self, franchise: Franchise) -> None:
        self._upsert("franchises", ["id", "name"], [franchise.id, franchise.name])

    def get_franchise(self, franchise_id: FranchiseId) -> Franchise:
        id_, name = self._one("SELECT * FROM franchises WHERE id = ?", franchise_id)
        return Franchise(FranchiseId(id_), name)

    def list_franchises(self) -> list[Franchise]:
        return [
            Franchise(FranchiseId(id_), name)
            for id_, name in self._all("SELECT * FROM franchises ORDER BY name, id")
        ]

    def save_franchise_match(self, franchise_match: FranchiseMatch) -> None:
        fm = franchise_match
        self._upsert(
            "franchise_matches",
            ["id", "tournament_id", "franchise_a_id", "franchise_b_id"],
            [fm.id, fm.tournament_id, fm.franchise_a_id, fm.franchise_b_id],
        )

    def find_tournament(self, name: str, tour: Tour) -> Tournament | None:
        row = self._db.execute(
            "SELECT * FROM tournaments WHERE name = ? AND tour = ? ORDER BY id LIMIT 1",
            [name, tour.value],
        ).fetchone()
        return None if row is None else Tournament(TournamentId(row[0]), row[1], Tour(row[2]))

    def find_player(self, name: str) -> Player | None:
        row = self._db.execute(
            "SELECT * FROM players WHERE name = ? ORDER BY id LIMIT 1", [name]
        ).fetchone()
        return None if row is None else Player(PlayerId(row[0]), row[1], Handedness(row[2]))

    def find_franchise(self, name: str) -> Franchise | None:
        row = self._db.execute(
            "SELECT * FROM franchises WHERE name = ? ORDER BY id LIMIT 1", [name]
        ).fetchone()
        return None if row is None else Franchise(FranchiseId(row[0]), row[1])

    def find_franchise_matches(
        self, tournament_id: TournamentId, franchise_a: FranchiseId, franchise_b: FranchiseId
    ) -> list[FranchiseMatch]:
        """Every Franchise Match between the two Franchises at a Tournament, in either order."""
        rows = self._all(
            "SELECT * FROM franchise_matches WHERE tournament_id = ? AND ("
            "(franchise_a_id = ? AND franchise_b_id = ?)"
            " OR (franchise_a_id = ? AND franchise_b_id = ?)) ORDER BY id",
            tournament_id,
            franchise_a,
            franchise_b,
            franchise_b,
            franchise_a,
        )
        return [
            FranchiseMatch(
                FranchiseMatchId(id_), TournamentId(tournament), FranchiseId(a), FranchiseId(b)
            )
            for id_, tournament, a, b in rows
        ]

    def get_franchise_match(self, franchise_match_id: FranchiseMatchId) -> FranchiseMatch:
        id_, tournament, a, b = self._one(
            "SELECT * FROM franchise_matches WHERE id = ?", franchise_match_id
        )
        return FranchiseMatch(
            FranchiseMatchId(id_), TournamentId(tournament), FranchiseId(a), FranchiseId(b)
        )

    def list_franchise_matches(self) -> list[FranchiseMatch]:
        return [
            FranchiseMatch(
                FranchiseMatchId(id_), TournamentId(tournament), FranchiseId(a), FranchiseId(b)
            )
            for id_, tournament, a, b in self._all("SELECT * FROM franchise_matches ORDER BY id")
        ]

    # --- Matches --------------------------------------------------------------------------

    def save_match(self, match: Match) -> None:
        """Saves a Match and replaces everything recorded under it (Games, Rallies, Shots...).

        Keeps operator sessions and any recorded video omitted by the caller. A frame count
        belongs to the recorded video and is kept when that video is unchanged.
        """
        video = match.source_video
        with self.transaction():
            self._db.execute(
                """
                INSERT INTO matches (
                    id,
                    tournament_id,
                    team_a_id,
                    team_b_id,
                    franchise_match_id,
                    source_video_url,
                    source_video_id,
                    source_video_path,
                    source_video_frames,
                    annotation_mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                    tournament_id = excluded.tournament_id,
                    team_a_id = excluded.team_a_id,
                    team_b_id = excluded.team_b_id,
                    franchise_match_id = excluded.franchise_match_id,
                    source_video_url = COALESCE(
                        excluded.source_video_url, matches.source_video_url
                    ),
                    source_video_id = COALESCE(
                        excluded.source_video_id, matches.source_video_id
                    ),
                    source_video_path = COALESCE(
                        excluded.source_video_path, matches.source_video_path
                    ),
                    source_video_frames = CASE
                        WHEN excluded.source_video_frames IS NOT NULL
                            THEN excluded.source_video_frames
                        WHEN excluded.source_video_path IS NULL OR (
                            excluded.source_video_url = matches.source_video_url
                            AND excluded.source_video_id = matches.source_video_id
                            AND excluded.source_video_path = matches.source_video_path
                        ) THEN matches.source_video_frames
                        ELSE NULL
                    END,
                    annotation_mode = excluded.annotation_mode
                """,
                [
                    match.id,
                    match.tournament_id,
                    match.team_a_id,
                    match.team_b_id,
                    match.franchise_match_id,
                    None if video is None else video.url,
                    None if video is None else video.video_id,
                    None if video is None else str(video.path),
                    match.source_video_frames,
                    match.annotation_mode,
                ],
            )
            for table in MATCH_CONTENT_TABLES:
                self._db.execute(f"DELETE FROM {table} WHERE match_id = ?", [match.id])
            self._insert_content(match)

    def has_match(self, match_id: MatchId) -> bool:
        row = self._db.execute("SELECT 1 FROM matches WHERE id = ?", [match_id]).fetchone()
        return row is not None

    def set_match_source_video(
        self, match_id: MatchId, source_video: SourceVideo, *, frames: int | None = None
    ) -> None:
        """Records the downloaded broadcast video against an existing Match."""
        check_video_frames(frames)
        self._require_match(match_id)
        self._db.execute(
            """
            UPDATE matches SET source_video_url = ?, source_video_id = ?,
                source_video_path = ?, source_video_frames = ?
            WHERE id = ?
            """,
            [source_video.url, source_video.video_id, str(source_video.path), frames, match_id],
        )

    def set_match_video_frames(
        self,
        match_id: MatchId,
        frames: int | None,
        *,
        expected_source: SourceVideo | None = None,
    ) -> None:
        """Sets the converted frame count, or clears it with None.

        A count requires a recorded source video. When `expected_source` is supplied, a
        changed or missing source leaves the row untouched so an old probe cannot overwrite it.
        """
        check_video_frames(frames)
        self._require_match(match_id)
        if expected_source is not None:
            self._db.execute(
                """
                UPDATE matches SET source_video_frames = ?
                WHERE id = ? AND source_video_url = ? AND source_video_id = ?
                      AND source_video_path = ?
                """,
                [
                    frames,
                    match_id,
                    expected_source.url,
                    expected_source.video_id,
                    str(expected_source.path),
                ],
            )
            return
        updated = self._db.execute(
            """
            UPDATE matches SET source_video_frames = ?
            WHERE id = ? AND (? IS NULL OR source_video_path IS NOT NULL)
            RETURNING id
            """,
            [frames, match_id, frames],
        ).fetchone()
        if updated is None:
            raise ValueError("Source video frames require a recorded source video")

    def upsert_operator_session(
        self, match_id: MatchId, session: OperatorSession
    ) -> OperatorTimeSummary:
        """Records a cumulative snapshot, safe to replay or receive out of order."""
        self._require_match(match_id)
        updated = self._db.execute(
            """
            INSERT INTO operator_sessions (
                match_id, session_id, workspace, started_at, ended_at, active_seconds
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (match_id, session_id) DO UPDATE SET
                started_at = LEAST(operator_sessions.started_at, excluded.started_at),
                ended_at = GREATEST(operator_sessions.ended_at, excluded.ended_at),
                active_seconds = GREATEST(operator_sessions.active_seconds, excluded.active_seconds)
            WHERE operator_sessions.workspace = excluded.workspace
            RETURNING session_id
            """,
            [
                match_id,
                session.session_id,
                session.workspace,
                session.started_at,
                session.ended_at,
                session.active_seconds,
            ],
        ).fetchone()
        if updated is None:
            raise ValueError("An operator session cannot change workspace")
        return self.get_operator_time(match_id)

    def get_operator_time(self, match_id: MatchId) -> OperatorTimeSummary:
        return OperatorTimeSummary(
            *self._one(
                f"SELECT {_OPERATOR_TOTALS} FROM operator_sessions WHERE match_id = ?",
                match_id,
            )
        )

    def get_operator_sessions(self, match_id: MatchId) -> tuple[OperatorSession, ...]:
        # Read UTC wall times explicitly so DuckDB's Python client doesn't require pytz.
        rows = self._all(
            """
            SELECT session_id, workspace, started_at AT TIME ZONE 'UTC',
                ended_at AT TIME ZONE 'UTC', active_seconds
            FROM operator_sessions WHERE match_id = ?
            ORDER BY started_at, session_id
            """,
            match_id,
        )
        return tuple(
            OperatorSession(
                session_id,
                OperatorWorkspace(workspace),
                start.replace(tzinfo=UTC),
                end.replace(tzinfo=UTC),
                seconds,
            )
            for session_id, workspace, start, end, seconds in rows
        )

    def list_matches(self, tournament: str | None = None) -> list[MatchSummary]:
        """Every Match's roster by name, without loading its Games; optionally for one Tournament
        name. Each Team's Players are in name order."""
        return self._match_summaries("? IS NULL OR t.name = ?", tournament, tournament)

    def get_match_summary(self, match_id: MatchId) -> MatchSummary:
        """One Match's roster by name, without loading its Games. Raises KeyError if missing."""
        summaries = self._match_summaries("m.id = ?", match_id)
        if not summaries:
            raise KeyError(f"no Match for {match_id}")
        return summaries[0]

    def _match_summaries(self, where: str, *params: Any) -> list[MatchSummary]:
        rows = self._all(
            f"""
            SELECT m.id, t.name,
                pa1.name, pa2.name, pb1.name, pb2.name,
                fa.name, fb.name,
                m.source_video_url, m.source_video_id, m.source_video_path, m.franchise_match_id,
                m.source_video_frames, m.annotation_mode,
                COALESCE(ot.calibrate_seconds, 0), COALESCE(ot.annotate_seconds, 0),
                COALESCE(ot.review_seconds, 0)
            FROM matches m
            JOIN tournaments t ON t.id = m.tournament_id
            JOIN teams ta ON ta.id = m.team_a_id
            JOIN players pa1 ON pa1.id = ta.player_low_id
            JOIN players pa2 ON pa2.id = ta.player_high_id
            JOIN teams tb ON tb.id = m.team_b_id
            JOIN players pb1 ON pb1.id = tb.player_low_id
            JOIN players pb2 ON pb2.id = tb.player_high_id
            LEFT JOIN franchise_matches fm ON fm.id = m.franchise_match_id
            LEFT JOIN franchises fa ON fa.id = fm.franchise_a_id
            LEFT JOIN franchises fb ON fb.id = fm.franchise_b_id
            LEFT JOIN (
                SELECT match_id, {_OPERATOR_TOTALS} FROM operator_sessions GROUP BY match_id
            ) ot ON ot.match_id = m.id
            WHERE {where}
            ORDER BY t.name, m.id
            """,
            *params,
        )
        return [
            MatchSummary(
                id=MatchId(id_),
                tournament=tournament_name,
                team_a=_pair(a1, a2),
                team_b=_pair(b1, b2),
                franchise_a=fa,
                franchise_b=fb,
                source_video=_source_video(video_url, video_id, video_path),
                franchise_match_id=None if fm_id is None else FranchiseMatchId(fm_id),
                annotation_mode=AnnotationMode(mode),
                source_video_frames=frames,
                operator_time=OperatorTimeSummary(calibrate, annotate, review),
            )
            for (
                id_,
                tournament_name,
                a1,
                a2,
                b1,
                b2,
                fa,
                fb,
                video_url,
                video_id,
                video_path,
                fm_id,
                frames,
                mode,
                calibrate,
                annotate,
                review,
            ) in rows
        ]

    def load_match(self, match_id: MatchId) -> Match:
        (
            tournament,
            team_a,
            team_b,
            franchise_match,
            video_url,
            video_id,
            video_path,
            video_frames,
            mode,
        ) = self._one(
            "SELECT tournament_id, team_a_id, team_b_id, franchise_match_id, "
            "source_video_url, source_video_id, source_video_path, "
            "source_video_frames, annotation_mode "
            "FROM matches WHERE id = ?",
            match_id,
        )
        source_video = _source_video(video_url, video_id, video_path)
        return Match(
            id=match_id,
            tournament_id=TournamentId(tournament),
            team_a_id=TeamId(team_a),
            team_b_id=TeamId(team_b),
            franchise_match_id=None
            if franchise_match is None
            else FranchiseMatchId(franchise_match),
            source_video=source_video,
            source_video_frames=video_frames,
            annotation_mode=AnnotationMode(mode),
            games=self._load_games(match_id),
            play_segments=self._load_play_segments(match_id),
            calibrations=self._load_calibrations(match_id),
            player_anchors=self._load_player_anchors(match_id),
            team_ends=self._load_team_ends(match_id),
        )

    def get_match_roster(self, match_id: MatchId) -> MatchRoster:
        """The two Teams and four Players of a Match, each Team's Players in name order."""
        row = self._db.execute(
            """
            SELECT m.team_a_id, m.team_b_id,
                pa1.id, pa1.name, pa1.handedness,
                pa2.id, pa2.name, pa2.handedness,
                pb1.id, pb1.name, pb1.handedness,
                pb2.id, pb2.name, pb2.handedness
            FROM matches m
            JOIN teams ta ON ta.id = m.team_a_id
            JOIN players pa1 ON pa1.id = ta.player_low_id
            JOIN players pa2 ON pa2.id = ta.player_high_id
            JOIN teams tb ON tb.id = m.team_b_id
            JOIN players pb1 ON pb1.id = tb.player_low_id
            JOIN players pb2 ON pb2.id = tb.player_high_id
            WHERE m.id = ?
            """,
            [match_id],
        ).fetchone()
        if row is None:
            raise MatchNotFound(match_id)
        (
            team_a_id,
            team_b_id,
            pa1_id,
            pa1_name,
            pa1_hand,
            pa2_id,
            pa2_name,
            pa2_hand,
            pb1_id,
            pb1_name,
            pb1_hand,
            pb2_id,
            pb2_name,
            pb2_hand,
        ) = row
        team_a_players = _sorted_players(
            Player(PlayerId(pa1_id), pa1_name, Handedness(pa1_hand)),
            Player(PlayerId(pa2_id), pa2_name, Handedness(pa2_hand)),
        )
        team_b_players = _sorted_players(
            Player(PlayerId(pb1_id), pb1_name, Handedness(pb1_hand)),
            Player(PlayerId(pb2_id), pb2_name, Handedness(pb2_hand)),
        )
        return MatchRoster(
            match_id=match_id,
            team_a_id=TeamId(team_a_id),
            team_b_id=TeamId(team_b_id),
            team_a_players=team_a_players,
            team_b_players=team_b_players,
        )

    # --- Play Segments, Calibrations, Player Anchors, and Team Ends -----------------------

    def get_play_segments(self, match_id: MatchId) -> tuple[PlaySegment, ...]:
        """A Match's Play Segments in frame order, without loading its Games."""
        self._require_match(match_id)
        return self._load_play_segments(match_id)

    def replace_play_segments(self, match_id: MatchId, segments: Sequence[PlaySegment]) -> None:
        """Replaces all of a Match's Play Segments. Raises ValueError if any two overlap."""
        check_play_segments(segments)
        with self.transaction():
            self._require_match(match_id)
            self._db.execute("DELETE FROM play_segments WHERE match_id = ?", [match_id])
            self._insert_play_segments(match_id, segments)

    def get_calibrations(self, match_id: MatchId) -> tuple[Calibration, ...]:
        """A Match's Calibrations, by Camera View then effective-from frame."""
        self._require_match(match_id)
        return self._load_calibrations(match_id)

    def replace_calibrations(
        self, match_id: MatchId, camera_view: CameraView, calibrations: Sequence[Calibration]
    ) -> None:
        """Replaces all of a Match's Calibrations of one Camera View, leaving the other view's."""
        for calibration in calibrations:
            if calibration.camera_view is not camera_view:
                raise ValueError(
                    f"a {calibration.camera_view} Calibration can't be saved as {camera_view}"
                )
        check_calibrations(calibrations)
        with self.transaction():
            self._require_match(match_id)
            for table in ("calibration_landmarks", "calibrations"):
                self._db.execute(
                    f"DELETE FROM {table} WHERE match_id = ? AND camera_view = ?",
                    [match_id, camera_view.value],
                )
            self._insert_calibrations(match_id, calibrations)

    def get_player_anchors(self, match_id: MatchId) -> tuple[PlayerAnchor, ...]:
        """A Match's operator-placed Player anchors, ordered by frame then player_id."""
        self._require_match(match_id)
        return self._load_player_anchors(match_id)

    def replace_player_anchors(self, match_id: MatchId, anchors: Sequence[PlayerAnchor]) -> None:
        """Replaces all of a Match's Player anchors. Validates Players belong to the Match."""
        check_player_anchors(anchors)
        with self.transaction():
            roster = self.get_match_roster(match_id)
            valid_players = roster.player_ids
            for anchor in anchors:
                if anchor.player_id not in valid_players:
                    raise ValueError(f"Player {anchor.player_id} is not in Match {match_id}")
            self._db.execute("DELETE FROM player_anchors WHERE match_id = ?", [match_id])
            self._insert_player_anchors(match_id, anchors)

    def get_team_ends(self, match_id: MatchId) -> tuple[TeamEnd, ...]:
        """A Match's TeamEnd records, ordered by effective_from_frame."""
        self._require_match(match_id)
        return self._load_team_ends(match_id)

    def replace_team_ends(self, match_id: MatchId, team_ends: Sequence[TeamEnd]) -> None:
        """Replaces all of a Match's TeamEnd records. Validates Teams belong to the Match."""
        check_team_ends(team_ends)
        with self.transaction():
            roster = self.get_match_roster(match_id)
            valid_teams = (roster.team_a_id, roster.team_b_id)
            for team_end in team_ends:
                if team_end.near_team_id not in valid_teams:
                    raise ValueError(f"Team {team_end.near_team_id} is not in Match {match_id}")
            self._db.execute("DELETE FROM team_ends WHERE match_id = ?", [match_id])
            self._insert_team_ends(match_id, team_ends)

    def _require_match(self, match_id: MatchId) -> None:
        if not self.has_match(match_id):
            raise MatchNotFound(match_id)

    def _load_play_segments(self, match_id: MatchId) -> tuple[PlaySegment, ...]:
        return tuple(
            PlaySegment(start, end, CameraView(view))
            for _, start, end, view in self._all(
                "SELECT * FROM play_segments WHERE match_id = ? ORDER BY start_frame", match_id
            )
        )

    def _insert_play_segments(self, match_id: MatchId, segments: Sequence[PlaySegment]) -> None:
        self._many(
            "play_segments",
            [[match_id, s.start_frame, s.end_frame, s.camera_view.value] for s in segments],
        )

    def _load_calibrations(self, match_id: MatchId) -> tuple[Calibration, ...]:
        points: dict[tuple[str, int], dict[Landmark, PlacedLandmark]] = defaultdict(dict)
        not_visible: dict[tuple[str, int], set[Landmark]] = defaultdict(set)
        for _, view, effective, landmark, status, x, y, frame in self._all(
            "SELECT match_id, camera_view, effective_from_frame, landmark, "
            "status, image_x, image_y, frame "
            "FROM calibration_landmarks WHERE match_id = ?",
            match_id,
        ):
            lm = Landmark(landmark)
            if status == "not_visible":
                not_visible[view, effective].add(lm)
            else:
                points[view, effective][lm] = PlacedLandmark(x, y, frame)
        return tuple(
            Calibration(
                CameraView(view),
                effective,
                reference,
                points[view, effective],
                frozenset(not_visible[view, effective]),
            )
            for _, view, effective, reference in self._all(
                "SELECT * FROM calibrations WHERE match_id = ? "
                "ORDER BY camera_view, effective_from_frame",
                match_id,
            )
        )

    def _insert_calibrations(self, match_id: MatchId, calibrations: Sequence[Calibration]) -> None:
        rows, landmark_rows = [], []
        for c in calibrations:
            key = [match_id, c.camera_view.value, c.effective_from_frame]
            rows.append([*key, c.reference_frame])
            landmark_rows.extend(
                [*key, lm.value, "placed", p.x, p.y, p.frame] for lm, p in c.landmarks.items()
            )
            landmark_rows.extend(
                [*key, lm.value, "not_visible", None, None, None]
                for lm in sorted(c.not_visible, key=lambda item: item.value)
            )
        self._many("calibrations", rows)
        self._many("calibration_landmarks", landmark_rows)

    def _load_player_anchors(self, match_id: MatchId) -> tuple[PlayerAnchor, ...]:
        return tuple(
            PlayerAnchor(
                frame=frame,
                player_id=PlayerId(player_id),
                kind=AnchorKind(kind),
                image_x=image_x,
                image_y=image_y,
            )
            for frame, player_id, kind, image_x, image_y in self._all(
                "SELECT frame, player_id, kind, image_x, image_y "
                "FROM player_anchors WHERE match_id = ? ORDER BY frame, player_id",
                match_id,
            )
        )

    def _insert_player_anchors(self, match_id: MatchId, anchors: Sequence[PlayerAnchor]) -> None:
        self._many(
            "player_anchors",
            [[match_id, a.frame, a.player_id, a.kind.value, a.image_x, a.image_y] for a in anchors],
        )

    def _load_team_ends(self, match_id: MatchId) -> tuple[TeamEnd, ...]:
        return tuple(
            TeamEnd(effective_from_frame=effective, near_team_id=TeamId(team_id))
            for effective, team_id in self._all(
                "SELECT effective_from_frame, near_team_id "
                "FROM team_ends WHERE match_id = ? ORDER BY effective_from_frame",
                match_id,
            )
        )

    def _insert_team_ends(self, match_id: MatchId, team_ends: Sequence[TeamEnd]) -> None:
        self._many(
            "team_ends",
            [[match_id, te.effective_from_frame, te.near_team_id] for te in team_ends],
        )

    # --- Writing match content ------------------------------------------------------------

    def _insert_content(self, match: Match) -> None:
        m = match.id
        if match.player_anchors:
            roster = self.get_match_roster(m)
            valid_players = roster.player_ids
            for anchor in match.player_anchors:
                if anchor.player_id not in valid_players:
                    raise ValueError(f"Player {anchor.player_id} is not in Match {m}")
        self._insert_play_segments(m, match.play_segments)
        self._insert_calibrations(m, match.calibrations)
        self._insert_player_anchors(m, match.player_anchors)
        self._insert_team_ends(m, match.team_ends)
        self._many("games", [[m, g.number] for g in match.games])
        rallies, shots, positions, gaps = [], [], [], []
        for game in match.games:
            for rally in game.rallies:
                rallies.append([m, game.number, *_rally_row(rally)])
                for log_position, entry in enumerate(rally.entries):
                    key = [m, game.number, rally.number, log_position]
                    if isinstance(entry, ObservationGap):
                        gaps.append([*key, entry.missing.value])
                        continue
                    shots.append([*key, *_shot_row(entry)])
                    for player_id, player_pos in entry.positions.items():
                        positions.append(
                            [
                                *key,
                                player_id,
                                *_point(player_pos.position),
                                *_fact(player_pos.settled),
                            ]
                        )
        self._many("rallies", rallies)
        self._many("shots", shots)
        self._many("shot_positions", positions)
        self._many("observation_gaps", gaps)

    # --- Reading match content ------------------------------------------------------------

    def _load_games(self, match_id: MatchId) -> tuple[Game, ...]:
        shots: dict[tuple[int, int], dict[int, Shot | ObservationGap]] = defaultdict(dict)
        positions: dict[tuple[int, int, int], dict[PlayerId, PlayerPosition]] = defaultdict(dict)
        for game, rally, pos, player, px, py, pc, settled, sc in self._all(
            "SELECT game_number, rally_number, log_position, player_id, "
            "position_x, position_y, position_certainty, settled, settled_certainty "
            "FROM shot_positions WHERE match_id = ?",
            match_id,
        ):
            positions[game, rally, pos][PlayerId(player)] = PlayerPosition(
                position=_read_point(px, py, pc),
                settled=_read(settled, sc, bool),
            )
        for _, game, rally, pos, *row in self._all(
            "SELECT * FROM shots WHERE match_id = ?", match_id
        ):
            shots[game, rally][pos] = _read_shot(row, positions[game, rally, pos])
        for _, game, rally, pos, missing in self._all(
            "SELECT * FROM observation_gaps WHERE match_id = ?", match_id
        ):
            shots[game, rally][pos] = ObservationGap(Parity(missing))

        rallies: dict[int, list[Rally]] = defaultdict(list)
        for _, game, number, *row in self._all(
            "SELECT * FROM rallies WHERE match_id = ? ORDER BY game_number, number", match_id
        ):
            entries = shots[game, number]
            rallies[game].append(
                _read_rally(number, row, tuple(entries[p] for p in sorted(entries)))
            )

        return tuple(
            Game(number, tuple(rallies[number]))
            for _, number in self._all(
                "SELECT * FROM games WHERE match_id = ? ORDER BY number", match_id
            )
        )

    # --- Plumbing -------------------------------------------------------------------------

    def _upsert(self, table: str, columns: list[str], values: list[Any]) -> None:
        placeholders = ", ".join("?" for _ in columns)
        updates = ", ".join(f"{c} = excluded.{c}" for c in columns[1:])
        self._db.execute(
            f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders}) "
            f"ON CONFLICT (id) DO UPDATE SET {updates}",
            values,
        )

    def _many(self, table: str, rows: Sequence[Sequence[Any]]) -> None:
        if not rows:
            return
        placeholders = ", ".join("?" for _ in rows[0])
        self._db.executemany(f"INSERT INTO {table} VALUES ({placeholders})", rows)

    def _one(self, sql: str, *params: Any) -> Row:
        row = self._db.execute(sql, list(params)).fetchone()
        if row is None:
            raise KeyError(f"no row for {params}")
        return row

    def _all(self, sql: str, *params: Any) -> list[Row]:
        return self._db.execute(sql, list(params)).fetchall()


# --- Row conversion -----------------------------------------------------------------------


def _pair(a: str, b: str) -> tuple[str, str]:
    first, second = sorted((a, b))
    return first, second


def _sorted_players(a: Player, b: Player) -> tuple[Player, Player]:
    first, second = sorted((a, b), key=lambda p: (p.name, p.id))
    return first, second


def _source_video(url: str | None, video_id: str | None, path: str | None) -> SourceVideo | None:
    if url is None or video_id is None or path is None:
        return None
    return SourceVideo(url, video_id, Path(path))


def _team(row: Row) -> Team:
    id_, low, high = row
    return Team(TeamId(id_), (PlayerId(low), PlayerId(high)))


def _fact(fact: Fact[Any]) -> list[Any]:
    value = fact.value.value if isinstance(fact.value, StrEnum) else fact.value
    return [value, fact.certainty.value]


def _optional_fact(fact: Fact[Any] | None) -> list[Any]:
    return [None, None] if fact is None else _fact(fact)


def _point(fact: Fact[CourtPoint]) -> list[Any]:
    point = fact.value
    return [
        None if point is None else point.x,
        None if point is None else point.y,
        fact.certainty.value,
    ]


def _read[T](value: Any, certainty: str | None, convert: Callable[[Any], T]) -> Fact[T]:
    if certainty is None or certainty == Certainty.UNKNOWN:
        return UNKNOWN
    return Fact(convert(value), Certainty(certainty))


def _read_point(x: float | None, y: float | None, certainty: str) -> Fact[CourtPoint]:
    return _read((x, y), certainty, lambda xy: CourtPoint(*xy))


def _rally_row(rally: Rally) -> list[Any]:
    score = rally.score.value
    challenge = rally.challenge
    return [
        rally.number,
        rally.start_frame,
        rally.end_frame,
        None if score is None else score.serving,
        None if score is None else score.receiving,
        None if score is None else score.server_number,
        rally.score.certainty.value,
        *_fact(rally.serving_team_id),
        *_fact(rally.server_id),
        *_fact(rally.returner_id),
        *_fact(rally.referee_call),
        challenge is not None,
        *_optional_fact(None if challenge is None else challenge.challenger_id),
        *_optional_fact(None if challenge is None else challenge.original_call),
        *_optional_fact(None if challenge is None else challenge.ruling),
        *_fact(rally.winner_id),
        None if rally.winner_source is None else rally.winner_source.value,
    ]


def _read_rally(
    number: int, row: Sequence[Any], entries: tuple[Shot | ObservationGap, ...]
) -> Rally:
    (
        start_frame,
        end_frame,
        serving,
        receiving,
        server_number,
        score_certainty,
        serving_team,
        serving_team_c,
        server,
        server_c,
        returner,
        returner_c,
        call,
        call_c,
        has_challenge,
        challenger,
        challenger_c,
        original_call,
        original_call_c,
        ruling,
        ruling_c,
        winner,
        winner_c,
        winner_source,
    ) = row
    challenge = None
    if has_challenge:
        challenge = Challenge(
            challenger_id=_read(challenger, challenger_c, PlayerId),
            original_call=_read(original_call, original_call_c, str),
            ruling=_read(ruling, ruling_c, Ruling),
        )
    return Rally(
        number=number,
        start_frame=start_frame,
        end_frame=end_frame,
        score=_read((serving, receiving, server_number), score_certainty, lambda s: Score(*s)),
        serving_team_id=_read(serving_team, serving_team_c, TeamId),
        server_id=_read(server, server_c, PlayerId),
        returner_id=_read(returner, returner_c, PlayerId),
        referee_call=_read(call, call_c, RefereeCall),
        challenge=challenge,
        winner_id=_read(winner, winner_c, TeamId),
        winner_source=None if winner_source is None else WinnerSource(winner_source),
        entries=entries,
    )


def _shot_row(shot: Shot) -> list[Any]:
    error = shot.error
    return [
        *_fact(shot.shot_number),
        *_fact(shot.hitter_id),
        *_fact(shot.contact_frame),
        *_fact(shot.contact_zone),
        *_fact(shot.shot_class),
        *_fact(shot.contact_kind),
        *_fact(shot.erne),
        *_fact(shot.atp),
        *_point(shot.landing),
        error is not None,
        *_optional_fact(None if error is None else error.kind),
        *_optional_fact(None if error is None else error.player_id),
    ]


def _read_shot(row: Sequence[Any], positions: dict[PlayerId, PlayerPosition]) -> Shot:
    (
        number,
        number_c,
        hitter,
        hitter_c,
        frame,
        frame_c,
        zone,
        zone_c,
        shot_class,
        shot_class_c,
        kind,
        kind_c,
        erne,
        erne_c,
        atp,
        atp_c,
        landing_x,
        landing_y,
        landing_c,
        has_error,
        error_kind,
        error_kind_c,
        error_player,
        error_player_c,
    ) = row
    error = None
    if has_error:
        error = Error(
            kind=_read(error_kind, error_kind_c, ErrorKind),
            player_id=_read(error_player, error_player_c, PlayerId),
        )
    return Shot(
        shot_number=_read(number, number_c, int),
        hitter_id=_read(hitter, hitter_c, PlayerId),
        contact_frame=_read(frame, frame_c, int),
        contact_zone=_read(zone, zone_c, Zone),
        shot_class=_read(shot_class, shot_class_c, ShotClass),
        contact_kind=_read(kind, kind_c, ContactKind),
        erne=_read(erne, erne_c, bool),
        atp=_read(atp, atp_c, bool),
        landing=_read_point(landing_x, landing_y, landing_c),
        error=error,
        positions=positions,
    )
