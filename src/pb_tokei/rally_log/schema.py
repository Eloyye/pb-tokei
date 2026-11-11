"""DuckDB schema for the Rally Log, built in code.

Every fact is two columns: `<name>` holding the value and `<name>_certainty` holding
'observed', 'inferred' or 'unknown'. A CHECK keeps them consistent: Unknown facts have no value.
Court points are `<name>_x`, `<name>_y` and `<name>_certainty`.

Roster tables (players, teams, tournaments...) are upserted and never deleted. The annotation
tables under a Match (games, rallies, shots...) are rewritten together whenever the Match is
saved, so they are keyed by the Match and carry no foreign keys to it or to each other: DuckDB
can't delete a parent and its children, or update a referenced row, in one transaction.
"""

from enum import StrEnum

from .model import (
    CameraView,
    Certainty,
    ContactKind,
    ErrorKind,
    Handedness,
    Parity,
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


_RALLY_KEY = "match_id UUID NOT NULL, game_number INTEGER NOT NULL"
_SHOT_KEY = f"{_RALLY_KEY}, rally_number INTEGER NOT NULL, log_position INTEGER NOT NULL"
_PLAYER = "UUID REFERENCES players (id)"
_TEAM = "UUID REFERENCES teams (id)"
_RULING = _one_of("challenge_ruling", Ruling)

STATEMENTS = [
    f"""
CREATE TABLE IF NOT EXISTS tournaments (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    tour VARCHAR NOT NULL {_one_of("tour", Tour)}
)""",
    f"""
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    handedness VARCHAR NOT NULL {_one_of("handedness", Handedness)}
)""",
    """
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY,
    player_low_id UUID NOT NULL REFERENCES players (id),
    player_high_id UUID NOT NULL REFERENCES players (id),
    CHECK (player_low_id < player_high_id),
    UNIQUE (player_low_id, player_high_id)
)""",
    """
CREATE TABLE IF NOT EXISTS franchises (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL
)""",
    """
CREATE TABLE IF NOT EXISTS franchise_matches (
    id UUID PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES tournaments (id),
    franchise_a_id UUID NOT NULL REFERENCES franchises (id),
    franchise_b_id UUID NOT NULL REFERENCES franchises (id)
)""",
    """
CREATE TABLE IF NOT EXISTS matches (
    id UUID PRIMARY KEY,
    tournament_id UUID NOT NULL REFERENCES tournaments (id),
    team_a_id UUID NOT NULL REFERENCES teams (id),
    team_b_id UUID NOT NULL REFERENCES teams (id),
    franchise_match_id UUID REFERENCES franchise_matches (id),
    CHECK (team_a_id <> team_b_id)
)""",
    f"""
CREATE TABLE IF NOT EXISTS play_segments (
    match_id UUID NOT NULL,
    start_frame INTEGER NOT NULL,
    end_frame INTEGER NOT NULL,
    camera_view VARCHAR NOT NULL {_one_of("camera_view", CameraView)},
    CHECK (start_frame < end_frame),
    PRIMARY KEY (match_id, start_frame)
)""",
    """
CREATE TABLE IF NOT EXISTS games (
    match_id UUID NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (match_id, number)
)""",
    f"""
CREATE TABLE IF NOT EXISTS rallies (
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
    PRIMARY KEY (match_id, game_number, number)
)""",
    f"""
CREATE TABLE IF NOT EXISTS shots (
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
)""",
    f"""
CREATE TABLE IF NOT EXISTS shot_positions (
    {_SHOT_KEY},
    player_id UUID NOT NULL REFERENCES players (id),
    {_fact("position", "POINT")},
    PRIMARY KEY (match_id, game_number, rally_number, log_position, player_id)
)""",
    f"""
CREATE TABLE IF NOT EXISTS observation_gaps (
    {_SHOT_KEY},
    missing VARCHAR NOT NULL {_one_of("missing", Parity)},
    PRIMARY KEY (match_id, game_number, rally_number, log_position)
)""",
]

# Rewritten as a unit when a Match is saved, children first.
MATCH_CONTENT_TABLES = [
    "shot_positions",
    "observation_gaps",
    "shots",
    "rallies",
    "games",
    "play_segments",
]
