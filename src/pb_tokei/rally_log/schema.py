"""DuckDB schema for the Rally Log, built in code.

Every fact is two columns: `<name>` holding the value and `<name>_certainty` holding
'observed', 'inferred' or 'unknown'. A CHECK keeps them consistent: Unknown facts have no value.
Court points are `<name>_x`, `<name>_y` and `<name>_certainty`.

Tables carry primary keys, uniqueness and CHECK constraints, but no foreign keys: DuckDB can't
update or delete a child row and delete a now-orphaned parent row in the same transaction
(ADR 0016). `RallyLog` enforces referential integrity inside its transactional operations.
"""

from collections.abc import Callable
from enum import StrEnum

import duckdb

from .model import (
    FRONTCOURT_MAX_Y_FT,
    AnchorKind,
    AnnotationMode,
    CameraView,
    Certainty,
    ContactKind,
    ErrorKind,
    Gender,
    Handedness,
    Landmark,
    OperatorWorkspace,
    Parity,
    RallyStatus,
    RefereeCall,
    Ruling,
    ShotClass,
    Tour,
    WinnerSource,
    Zone,
)


def _one_of(column: str, enum: type[StrEnum]) -> str:
    values = ", ".join(f"'{member.value}'" for member in enum)
    return f"CHECK ({column} IN ({values}))"


def _fact(name: str, sql_type: str, *, optional: bool = False, values: str = "") -> str:
    """Columns and checks for one fact. An optional fact belongs to a part that may be absent."""
    certainty = f"{name}_certainty"
    if sql_type == "POINT":
        value_columns = [f"{name}_x", f"{name}_y"]
        columns = [f"{name}_x DOUBLE", f"{name}_y DOUBLE"]
    else:
        value_columns = [name]
        columns = [f"{name} {sql_type} {values}".rstrip()]
    not_null = "" if optional else " NOT NULL"
    columns.append(f"{certainty} VARCHAR{not_null} {_one_of(certainty, Certainty)}")
    all_null = " AND ".join(f"{c} IS NULL" for c in value_columns)
    none_null = " AND ".join(f"{c} IS NOT NULL" for c in value_columns)
    columns.append(
        f"CHECK (({certainty} IS NULL AND {all_null})"
        f" OR ({certainty} = 'unknown' AND {all_null})"
        f" OR ({certainty} <> 'unknown' AND {none_null}))"
    )
    return ",\n    ".join(columns)


def matches_table(name: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    id UUID PRIMARY KEY,
    tournament_id UUID NOT NULL,
    team_a_id UUID NOT NULL,
    team_b_id UUID NOT NULL,
    franchise_match_id UUID,
    date DATE,
    source_video_url VARCHAR,
    source_video_id VARCHAR,
    source_video_path VARCHAR,
    source_video_frames INTEGER CHECK (source_video_frames > 0),
    annotation_mode VARCHAR NOT NULL DEFAULT '{AnnotationMode.GOLD}'
        {_one_of("annotation_mode", AnnotationMode)},
    CHECK (team_a_id <> team_b_id),
    CHECK (
        (source_video_url IS NULL AND source_video_id IS NULL AND source_video_path IS NULL)
        OR (
            source_video_url IS NOT NULL
            AND source_video_id IS NOT NULL
            AND source_video_path IS NOT NULL
        )
    ),
    CHECK (source_video_frames IS NULL OR source_video_path IS NOT NULL)
)"""


def _migrate_matches(db: duckdb.DuckDBPyConnection) -> None:
    columns = {
        name
        for (name,) in db.execute(
            "SELECT column_name FROM duckdb_columns() WHERE table_name = 'matches'"
        ).fetchall()
    }
    if {"source_video_frames", "annotation_mode", "date"} <= columns:
        return

    # Older logs can also predate SourceVideo or `date`. Absent columns take the new table defaults.
    copied = ", ".join(
        name
        for name in (
            "id",
            "tournament_id",
            "team_a_id",
            "team_b_id",
            "franchise_match_id",
            "date",
            "source_video_url",
            "source_video_id",
            "source_video_path",
            "source_video_frames",
            "annotation_mode",
        )
        if name in columns
    )
    db.execute("BEGIN TRANSACTION")
    try:
        db.execute(matches_table("matches_migrated"))
        db.execute(f"INSERT INTO matches_migrated ({copied}) SELECT {copied} FROM matches")
        db.execute("DROP TABLE matches")
        db.execute("ALTER TABLE matches_migrated RENAME TO matches")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")


def play_segments_table(name: str) -> str:
    """The Play Segments table. Frame ranges are inclusive, so a one-frame segment is allowed."""
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    match_id UUID NOT NULL,
    start_frame INTEGER NOT NULL CHECK (start_frame >= 0),
    end_frame INTEGER NOT NULL,
    camera_view VARCHAR NOT NULL {_one_of("camera_view", CameraView)},
    CHECK (start_frame <= end_frame),
    PRIMARY KEY (match_id, start_frame)
)"""


def calibration_landmarks_table(name: str) -> str:
    """The Calibration Landmarks table: placed (image coords + click frame) or not visible."""
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    match_id UUID NOT NULL,
    camera_view VARCHAR NOT NULL {_one_of("camera_view", CameraView)},
    effective_from_frame INTEGER NOT NULL,
    landmark VARCHAR NOT NULL {_one_of("landmark", Landmark)},
    status VARCHAR NOT NULL CHECK (status IN ('placed', 'not_visible')),
    image_x DOUBLE CHECK (image_x BETWEEN 0 AND 1),
    image_y DOUBLE CHECK (image_y BETWEEN 0 AND 1),
    frame INTEGER CHECK (frame >= 0),
    CHECK (
        (status = 'placed' AND image_x IS NOT NULL AND image_y IS NOT NULL AND frame IS NOT NULL)
        OR (status = 'not_visible' AND image_x IS NULL AND image_y IS NULL AND frame IS NULL)
    ),
    PRIMARY KEY (match_id, camera_view, effective_from_frame, landmark)
)"""


def shot_positions_table(name: str) -> str:
    """Each Player's court position and Settled fact at a Shot's contact."""
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    {_SHOT_KEY},
    player_id UUID NOT NULL,
    {_fact("position", "POINT")},
    {_fact("settled", "BOOLEAN")},
    PRIMARY KEY (match_id, game_number, rally_number, log_position, player_id)
)"""


def rallies_table(name: str) -> str:
    """The Rallies table. `status` is annotation-workflow state that Event Processing ignores, and
    `scoreboard_winner_id` is kept apart from `winner_id` (ADR 0013)."""
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    {_RALLY_KEY},
    number INTEGER NOT NULL,
    start_frame INTEGER,
    end_frame INTEGER,
    score_serving INTEGER,
    score_receiving INTEGER,
    score_server_number INTEGER CHECK (score_server_number IN (1, 2)),
    score_certainty VARCHAR NOT NULL {_one_of("score_certainty", Certainty)},
    CHECK ((score_certainty = 'unknown') = (score_serving IS NULL)),
    CHECK ((score_serving IS NULL) = (score_receiving IS NULL)),
    CHECK ((score_serving IS NULL) = (score_server_number IS NULL)),
    {_fact("serving_team_id", _TEAM)},
    {_fact("server_id", _PLAYER)},
    {_fact("returner_id", _PLAYER)},
    {_fact("referee_call", "VARCHAR", values=_one_of("referee_call", RefereeCall))},
    has_challenge BOOLEAN NOT NULL,
    {_fact("challenger_id", _PLAYER, optional=True)},
    {_fact("challenge_original_call", "VARCHAR", optional=True)},
    {_fact("challenge_ruling", "VARCHAR", optional=True, values=_RULING)},
    CHECK (has_challenge = (challenger_id_certainty IS NOT NULL)),
    CHECK (has_challenge = (challenge_original_call_certainty IS NOT NULL)),
    CHECK (has_challenge = (challenge_ruling_certainty IS NOT NULL)),
    {_fact("winner_id", _TEAM)},
    winner_source VARCHAR {_one_of("winner_source", WinnerSource)},
    {_fact("scoreboard_winner_id", _TEAM)},
    status VARCHAR NOT NULL {_one_of("status", RallyStatus)},
    PRIMARY KEY (match_id, game_number, number)
)"""


# The `rallies` columns added for Rally and Shot entry (ADR 0013), in table order.
_RALLY_STATUS_COLUMNS = ["scoreboard_winner_id", "scoreboard_winner_id_certainty", "status"]


def _migrate_rally_status(db: duckdb.DuckDBPyConnection) -> None:
    """Adds `scoreboard_winner_id` (Unknown) and `status` to an older `rallies` table.

    A Rally that already holds Shots, Observation Gaps or any known fact is In progress; any
    other is Empty.
    """
    columns = [
        name
        for (name,) in db.execute(
            "SELECT column_name FROM duckdb_columns() WHERE table_name = 'rallies' "
            "ORDER BY column_index"
        ).fetchall()
    ]
    if "status" in columns and "scoreboard_winner_id" in columns:
        return
    # Copy every column the old table has, by name, so the copy can't drift out of line.
    kept = [c for c in columns if c not in _RALLY_STATUS_COLUMNS]
    old = ", ".join(f"r.{c}" for c in kept)
    has_scoreboard = "scoreboard_winner_id" in columns
    scoreboard = (
        "r.scoreboard_winner_id, r.scoreboard_winner_id_certainty"
        if has_scoreboard
        else "NULL, 'unknown'"
    )
    recorded = " OR ".join(
        [
            *(
                f"r.{fact}_certainty <> 'unknown'"
                for fact in (
                    "score",
                    "serving_team_id",
                    "server_id",
                    "returner_id",
                    "referee_call",
                    "winner_id",
                )
            ),
            "r.has_challenge",
            *(
                f"EXISTS (SELECT 1 FROM {table} e WHERE e.match_id = r.match_id "
                "AND e.game_number = r.game_number AND e.rally_number = r.number)"
                for table in ("shots", "observation_gaps")
            ),
        ]
    )
    status = (
        "r.status"
        if "status" in columns
        else f"CASE WHEN {recorded} THEN 'in_progress' ELSE 'empty' END"
    )
    db.execute("BEGIN TRANSACTION")
    try:
        db.execute(rallies_table("rallies_migrated"))
        target = ", ".join([*kept, *_RALLY_STATUS_COLUMNS])
        db.execute(
            f"INSERT INTO rallies_migrated ({target}) "
            f"SELECT {old}, {scoreboard}, {status} FROM rallies r"
        )
        db.execute("DROP TABLE rallies")
        db.execute("ALTER TABLE rallies_migrated RENAME TO rallies")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")


def migrate(db: duckdb.DuckDBPyConnection) -> None:
    """Brings a Rally Log made by an older version up to the current schema.

    Run after `STATEMENTS`. DuckDB can't alter a CHECK, so a table whose check changed is copied
    into a fresh one.
    """
    _migrate_matches(db)

    old_check = db.execute(
        "SELECT 1 FROM duckdb_constraints() WHERE table_name = 'play_segments' "
        "AND constraint_type = 'CHECK' AND expression = '(start_frame < end_frame)'"
    ).fetchone()
    if old_check is not None:
        db.execute("BEGIN TRANSACTION")
        try:
            db.execute(play_segments_table("play_segments_migrated"))
            db.execute("INSERT INTO play_segments_migrated SELECT * FROM play_segments")
            db.execute("DROP TABLE play_segments")
            db.execute("ALTER TABLE play_segments_migrated RENAME TO play_segments")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")

    has_landmark_frame = db.execute(
        "SELECT 1 FROM duckdb_columns() WHERE table_name = 'calibration_landmarks' "
        "AND column_name = 'frame'"
    ).fetchone()
    if has_landmark_frame is None:
        db.execute("BEGIN TRANSACTION")
        try:
            db.execute(calibration_landmarks_table("calibration_landmarks_migrated"))
            db.execute(
                """
                INSERT INTO calibration_landmarks_migrated (
                    match_id,
                    camera_view,
                    effective_from_frame,
                    landmark,
                    status,
                    image_x,
                    image_y,
                    frame
                )
                SELECT
                    cl.match_id,
                    cl.camera_view,
                    cl.effective_from_frame,
                    cl.landmark,
                    'placed',
                    cl.image_x,
                    cl.image_y,
                    c.reference_frame
                FROM calibration_landmarks cl
                JOIN calibrations c
                  ON c.match_id = cl.match_id
                 AND c.camera_view = cl.camera_view
                 AND c.effective_from_frame = cl.effective_from_frame
                """
            )
            db.execute("DROP TABLE calibration_landmarks")
            db.execute("ALTER TABLE calibration_landmarks_migrated RENAME TO calibration_landmarks")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")

    has_settled = db.execute(
        "SELECT 1 FROM duckdb_columns() WHERE table_name = 'shot_positions' "
        "AND column_name = 'settled'"
    ).fetchone()
    if has_settled is None:
        db.execute("BEGIN TRANSACTION")
        try:
            db.execute(shot_positions_table("shot_positions_migrated"))
            db.execute(
                f"""
                INSERT INTO shot_positions_migrated (
                    match_id,
                    game_number,
                    rally_number,
                    log_position,
                    player_id,
                    position_x,
                    position_y,
                    position_certainty,
                    settled,
                    settled_certainty
                )
                SELECT
                    match_id,
                    game_number,
                    rally_number,
                    log_position,
                    player_id,
                    position_x,
                    position_y,
                    position_certainty,
                    CASE
                        WHEN position_certainty <> 'unknown'
                         AND abs(position_y) > {FRONTCOURT_MAX_Y_FT}
                        THEN FALSE
                        ELSE NULL
                    END,
                    CASE
                        WHEN position_certainty <> 'unknown'
                         AND abs(position_y) > {FRONTCOURT_MAX_Y_FT}
                        THEN position_certainty
                        ELSE 'unknown'
                    END
                FROM shot_positions
                """
            )
            db.execute("DROP TABLE shot_positions")
            db.execute("ALTER TABLE shot_positions_migrated RENAME TO shot_positions")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")

    _migrate_rally_status(db)
    _migrate_drop_foreign_keys(db)
    _migrate_players(db)


def players_table(name: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    handedness VARCHAR NOT NULL {_one_of("handedness", Handedness)},
    gender VARCHAR {_one_of("gender", Gender)}
)"""


def _migrate_players(db: duckdb.DuckDBPyConnection) -> None:
    """Adds nullable `gender` with its CHECK constraint to an older `players` table."""
    columns = {
        name
        for (name,) in db.execute(
            "SELECT column_name FROM duckdb_columns() WHERE table_name = 'players'"
        ).fetchall()
    }
    if "gender" in columns:
        return
    db.execute("BEGIN TRANSACTION")
    try:
        db.execute(players_table("players_migrated"))
        db.execute(
            "INSERT INTO players_migrated (id, name, handedness) "
            "SELECT id, name, handedness FROM players"
        )
        db.execute("DROP TABLE players")
        db.execute("ALTER TABLE players_migrated RENAME TO players")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    db.execute("COMMIT")


def teams_table(name: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    id UUID PRIMARY KEY,
    player_low_id UUID NOT NULL,
    player_high_id UUID NOT NULL,
    CHECK (player_low_id < player_high_id),
    UNIQUE (player_low_id, player_high_id)
)"""


def franchise_matches_table(name: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    id UUID PRIMARY KEY,
    tournament_id UUID NOT NULL,
    franchise_a_id UUID NOT NULL,
    franchise_b_id UUID NOT NULL
)"""


def shots_table(name: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    {_SHOT_KEY},
    {_fact("shot_number", "INTEGER")},
    {_fact("hitter_id", _PLAYER)},
    {_fact("contact_frame", "INTEGER")},
    {_fact("contact_zone", "VARCHAR", values=_one_of("contact_zone", Zone))},
    {_fact("shot_class", "VARCHAR", values=_one_of("shot_class", ShotClass))},
    {_fact("contact_kind", "VARCHAR", values=_one_of("contact_kind", ContactKind))},
    {_fact("erne", "BOOLEAN")},
    {_fact("atp", "BOOLEAN")},
    {_fact("landing", "POINT")},
    has_error BOOLEAN NOT NULL,
    {_fact("error_kind", "VARCHAR", optional=True, values=_one_of("error_kind", ErrorKind))},
    {_fact("error_player_id", _PLAYER, optional=True)},
    CHECK (has_error = (error_kind_certainty IS NOT NULL)),
    CHECK (has_error = (error_player_id_certainty IS NOT NULL)),
    PRIMARY KEY (match_id, game_number, rally_number, log_position)
)"""


def player_anchors_table(name: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    match_id UUID NOT NULL,
    frame INTEGER NOT NULL CHECK (frame >= 0),
    player_id UUID NOT NULL,
    kind VARCHAR NOT NULL {_one_of("kind", AnchorKind)},
    image_x DOUBLE NOT NULL CHECK (image_x BETWEEN 0 AND 1),
    image_y DOUBLE NOT NULL CHECK (image_y BETWEEN 0 AND 1),
    PRIMARY KEY (match_id, frame, player_id)
)"""


def team_ends_table(name: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS {name} (
    match_id UUID NOT NULL,
    effective_from_frame INTEGER NOT NULL CHECK (effective_from_frame >= 0),
    near_team_id UUID NOT NULL,
    PRIMARY KEY (match_id, effective_from_frame)
)"""


def _migrate_drop_foreign_keys(db: duckdb.DuckDBPyConnection) -> None:
    """Rebuilds legacy tables carrying foreign keys so edits and orphan deletes can share one
    transaction (ADR 0016). Children are rebuilt before their parents."""
    fk_tables = {
        name
        for (name,) in db.execute(
            "SELECT DISTINCT table_name FROM duckdb_constraints() "
            "WHERE constraint_type = 'FOREIGN KEY'"
        ).fetchall()
    }
    if not fk_tables:
        return
    ordered: tuple[tuple[str, Callable[[str], str]], ...] = (
        ("shot_positions", shot_positions_table),
        ("shots", shots_table),
        ("rallies", rallies_table),
        ("player_anchors", player_anchors_table),
        ("team_ends", team_ends_table),
        ("matches", matches_table),
        ("franchise_matches", franchise_matches_table),
        ("teams", teams_table),
    )
    for table, ddl in ordered:
        if table not in fk_tables:
            continue
        columns = [
            col
            for (col,) in db.execute(
                "SELECT column_name FROM duckdb_columns() "
                "WHERE table_name = ? ORDER BY column_index",
                [table],
            ).fetchall()
        ]
        cols = ", ".join(columns)
        migrated = f"{table}_migrated"
        db.execute("BEGIN TRANSACTION")
        try:
            db.execute(ddl(migrated))
            db.execute(f"INSERT INTO {migrated} ({cols}) SELECT {cols} FROM {table}")
            db.execute(f"DROP TABLE {table}")
            db.execute(f"ALTER TABLE {migrated} RENAME TO {table}")
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")


_RALLY_KEY = "match_id UUID NOT NULL, game_number INTEGER NOT NULL"
_SHOT_KEY = f"{_RALLY_KEY}, rally_number INTEGER NOT NULL, log_position INTEGER NOT NULL"
_PLAYER = "UUID"
_TEAM = "UUID"
_RULING = _one_of("challenge_ruling", Ruling)

STATEMENTS = [
    f"""
CREATE TABLE IF NOT EXISTS tournaments (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    tour VARCHAR NOT NULL {_one_of("tour", Tour)}
)""",
    players_table("players"),
    teams_table("teams"),
    """
CREATE TABLE IF NOT EXISTS franchises (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL
)""",
    franchise_matches_table("franchise_matches"),
    matches_table("matches"),
    f"""
CREATE TABLE IF NOT EXISTS operator_sessions (
    match_id UUID NOT NULL,
    session_id UUID NOT NULL,
    workspace VARCHAR NOT NULL {_one_of("workspace", OperatorWorkspace)},
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ NOT NULL,
    active_seconds DOUBLE NOT NULL CHECK (isfinite(active_seconds) AND active_seconds >= 0),
    CHECK (ended_at >= started_at),
    PRIMARY KEY (match_id, session_id)
)""",
    play_segments_table("play_segments"),
    f"""
CREATE TABLE IF NOT EXISTS calibrations (
    match_id UUID NOT NULL,
    camera_view VARCHAR NOT NULL {_one_of("camera_view", CameraView)},
    effective_from_frame INTEGER NOT NULL CHECK (effective_from_frame >= 0),
    reference_frame INTEGER NOT NULL CHECK (reference_frame >= 0),
    PRIMARY KEY (match_id, camera_view, effective_from_frame)
)""",
    calibration_landmarks_table("calibration_landmarks"),
    """
CREATE TABLE IF NOT EXISTS games (
    match_id UUID NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (match_id, number)
)""",
    rallies_table("rallies"),
    shots_table("shots"),
    shot_positions_table("shot_positions"),
    f"""
CREATE TABLE IF NOT EXISTS observation_gaps (
    {_SHOT_KEY},
    missing VARCHAR NOT NULL {_one_of("missing", Parity)},
    PRIMARY KEY (match_id, game_number, rally_number, log_position)
)""",
    player_anchors_table("player_anchors"),
    team_ends_table("team_ends"),
]

# A Match's Games and everything under them, children first: rewritten by `replace_games`.
GAME_TABLES = [
    "shot_positions",
    "observation_gaps",
    "shots",
    "rallies",
    "games",
]

# Rewritten as a unit when a Match is saved, children first.
MATCH_CONTENT_TABLES = [
    "shot_positions",
    "observation_gaps",
    "shots",
    "rallies",
    "games",
    "play_segments",
    "calibration_landmarks",
    "calibrations",
    "player_anchors",
    "team_ends",
]
