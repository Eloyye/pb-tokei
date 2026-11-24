"""Reading and writing the Rally Log in a DuckDB file."""

from __future__ import annotations

import os
from collections import defaultdict
from collections.abc import Callable, Generator, Sequence
from contextlib import contextmanager
from enum import StrEnum
from pathlib import Path
from types import TracebackType
from typing import Any, Self

import duckdb

from .model import (
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
    Franchise,
    FranchiseId,
    FranchiseMatch,
    FranchiseMatchId,
    Game,
    Handedness,
    Landmark,
    Match,
    MatchId,
    MatchSummary,
    ObservationGap,
    Parity,
    PlacedLandmark,
    Player,
    PlayerId,
    PlaySegment,
    Rally,
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
    check_calibrations,
    check_play_segments,
)
from .schema import MATCH_CONTENT_TABLES, STATEMENTS, migrate

Row = tuple[Any, ...]

DEFAULT_DB_PATH = Path("rally_log.duckdb")
"""Fallback Rally Log filename in the current directory when `--db` and state aren't set."""


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

    def save_player(self, player: Player) -> None:
        self._upsert(
            "players",
            ["id", "name", "handedness"],
            [player.id, player.name, player.handedness.value],
        )

    def get_player(self, player_id: PlayerId) -> Player:
        id_, name, handedness = self._one("SELECT * FROM players WHERE id = ?", player_id)
        return Player(PlayerId(id_), name, Handedness(handedness))

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

    def save_franchise_match(self, franchise_match: FranchiseMatch) -> None:
        fm = franchise_match
        self._upsert(
            "franchise_matches",
            ["id", "tournament_id", "franchise_a_id", "franchise_b_id"],
            [fm.id, fm.tournament_id, fm.franchise_a_id, fm.franchise_b_id],
        )

    def find_tournament(self, name: str, tour: Tour) -> Tournament | None:
        row = self._db.execute(
            "SELECT * FROM tournaments WHERE name = ? AND tour = ?", [name, tour.value]
        ).fetchone()
        return None if row is None else Tournament(TournamentId(row[0]), row[1], Tour(row[2]))

    def find_player(self, name: str) -> Player | None:
        row = self._db.execute("SELECT * FROM players WHERE name = ?", [name]).fetchone()
        return None if row is None else Player(PlayerId(row[0]), row[1], Handedness(row[2]))

    def find_franchise(self, name: str) -> Franchise | None:
        row = self._db.execute("SELECT * FROM franchises WHERE name = ?", [name]).fetchone()
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

    # --- Matches --------------------------------------------------------------------------

    def save_match(self, match: Match) -> None:
        """Saves a Match and replaces everything recorded under it (Games, Rallies, Shots...).

        If `match.source_video` is None, any source video already recorded on the Match is kept.
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
                    source_video_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
                    )
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
                ],
            )
            for table in MATCH_CONTENT_TABLES:
                self._db.execute(f"DELETE FROM {table} WHERE match_id = ?", [match.id])
            self._insert_content(match)

    def has_match(self, match_id: MatchId) -> bool:
        row = self._db.execute("SELECT 1 FROM matches WHERE id = ?", [match_id]).fetchone()
        return row is not None

    def set_match_source_video(self, match_id: MatchId, source_video: SourceVideo) -> None:
        """Records the downloaded broadcast video against an existing Match."""
        self._require_match(match_id)
        self._db.execute(
            "UPDATE matches SET source_video_url = ?, source_video_id = ?, source_video_path = ? "
            "WHERE id = ?",
            [source_video.url, source_video.video_id, str(source_video.path), match_id],
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
                m.source_video_url, m.source_video_id, m.source_video_path
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
        ) = self._one(
            "SELECT tournament_id, team_a_id, team_b_id, franchise_match_id, "
            "source_video_url, source_video_id, source_video_path "
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
            games=self._load_games(match_id),
            play_segments=self._load_play_segments(match_id),
            calibrations=self._load_calibrations(match_id),
        )

    # --- Play Segments and Calibrations ---------------------------------------------------

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

    # --- Writing match content ------------------------------------------------------------

    def _insert_content(self, match: Match) -> None:
        m = match.id
        self._insert_play_segments(m, match.play_segments)
        self._insert_calibrations(m, match.calibrations)
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
                    for player_id, position in entry.positions.items():
                        positions.append([*key, player_id, *_point(position)])
        self._many("rallies", rallies)
        self._many("shots", shots)
        self._many("shot_positions", positions)
        self._many("observation_gaps", gaps)

    # --- Reading match content ------------------------------------------------------------

    def _load_games(self, match_id: MatchId) -> tuple[Game, ...]:
        shots: dict[tuple[int, int], dict[int, Shot | ObservationGap]] = defaultdict(dict)
        positions: dict[tuple[int, int, int], dict[PlayerId, Fact[CourtPoint]]] = defaultdict(dict)
        for _, game, rally, pos, player, *point in self._all(
            "SELECT * FROM shot_positions WHERE match_id = ?", match_id
        ):
            positions[game, rally, pos][PlayerId(player)] = _read_point(*point)
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


def _read_shot(row: Sequence[Any], positions: dict[PlayerId, Fact[CourtPoint]]) -> Shot:
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
