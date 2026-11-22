"""Command-line interface for pb-tokei."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path
from uuid import UUID

import duckdb

from pb_tokei.footage import (
    DEFAULT_FOOTAGE_DIR,
    CommandRunner,
    FootageDownloadError,
    download_footage,
)
from pb_tokei.rally_log import MatchId, MatchSummary, RallyLog
from pb_tokei.roster import RosterError, read_roster, roster_template, set_up_match

DEFAULT_DB_PATH = Path("rally_log.duckdb")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pb-tokei",
        description="Statistics on pro doubles pickleball derived from broadcast footage.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    download = subparsers.add_parser(
        "download",
        help="Download a broadcast video into footage/ (preferring 60 fps).",
    )
    download.add_argument("url", help="Broadcast URL to download via yt-dlp.")
    download.add_argument(
        "--footage-dir",
        type=Path,
        default=DEFAULT_FOOTAGE_DIR,
        help=f"Directory to store downloaded footage (default: {DEFAULT_FOOTAGE_DIR}).",
    )
    download.add_argument(
        "--match",
        dest="match_id",
        help="Match UUID in the Rally Log to record the downloaded source video against.",
    )
    download.add_argument(
        "--db",
        type=Path,
        default=None,
        help=f"Path to the Rally Log DuckDB file (default when --match is set: {DEFAULT_DB_PATH}).",
    )

    match = subparsers.add_parser("match", help="Set up and list Matches from Roster Files.")
    match_commands = match.add_subparsers(dest="match_command", required=True)

    new = match_commands.add_parser(
        "new", help="Write a Roster File template with a fresh Match id."
    )
    new.add_argument("file", type=Path, help="Where to write the Roster File.")
    new.set_defaults(handler=_match_new)

    add = match_commands.add_parser(
        "add", help="Create the Match a Roster File describes, and print its id."
    )
    add.add_argument("file", type=Path, help="The Roster File (TOML).")
    _db_argument(add)
    add.set_defaults(handler=_match_add)

    list_ = match_commands.add_parser("list", help="List Matches with their rosters.")
    list_.add_argument("--tournament", help="Only Matches at this Tournament (exact name).")
    _db_argument(list_)
    list_.set_defaults(handler=_match_list)
    return parser


def _db_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"Path to the Rally Log DuckDB file (default: {DEFAULT_DB_PATH}).",
    )


def main(
    argv: Sequence[str] | None = None,
    *,
    run: CommandRunner | None = None,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "download":
        return _run_download(args, parser=parser, run=run)
    if args.command == "match":
        return args.handler(args)

    parser.error(f"Unknown command: {args.command}")


def _run_download(
    args: argparse.Namespace,
    *,
    parser: argparse.ArgumentParser,
    run: CommandRunner | None,
) -> int:
    if args.db is not None and args.match_id is None:
        parser.error("--db requires --match")

    match_id: MatchId | None = None
    db_path: Path | None = None
    if args.match_id is not None:
        try:
            match_id = MatchId(UUID(args.match_id))
        except ValueError:
            parser.error(f"Invalid --match UUID: {args.match_id}")
        db_path = DEFAULT_DB_PATH if args.db is None else args.db
        if not db_path.is_file():
            print(f"error: Rally Log database not found: {db_path}", file=sys.stderr)
            return 1
        with RallyLog.open(db_path) as log:
            if not log.has_match(match_id):
                print(f"error: Match not found in {db_path}: {match_id}", file=sys.stderr)
                return 1

    try:
        result = download_footage(args.url, args.footage_dir, run=run)
    except FootageDownloadError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if match_id is not None and db_path is not None:
        try:
            with RallyLog.open(db_path) as log:
                log.set_match_source_video(match_id, result.source_video)
        except KeyError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    print(result.source_video.path)
    return 0


def _match_new(args: argparse.Namespace) -> int:
    if args.file.exists():
        print(f"error: {args.file} already exists", file=sys.stderr)
        return 1
    try:
        args.file.parent.mkdir(parents=True, exist_ok=True)
        args.file.write_text(roster_template(), encoding="utf-8")
    except OSError as exc:
        print(f"error: cannot write {args.file}: {exc.strerror}", file=sys.stderr)
        return 1
    print(args.file)
    return 0


def _match_add(args: argparse.Namespace) -> int:
    try:
        roster = read_roster(args.file)
    except RosterError as exc:
        print(f"error: {args.file}: {exc}", file=sys.stderr)
        return 1
    try:
        with RallyLog.open(args.db) as log:
            match = set_up_match(log, roster)
    except (RosterError, duckdb.Error, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(match.id)
    return 0


def _match_list(args: argparse.Namespace) -> int:
    if not args.db.is_file():
        print(f"error: Rally Log database not found: {args.db}", file=sys.stderr)
        return 1
    try:
        with RallyLog.open(args.db) as log:
            summaries = log.list_matches(args.tournament)
    except (duckdb.Error, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for summary in summaries:
        print(_match_line(summary))
    return 0


def _match_line(summary: MatchSummary) -> str:
    teams = f"{' / '.join(summary.team_a)}  vs  {' / '.join(summary.team_b)}"
    parts = [str(summary.id), summary.tournament, teams]
    if summary.franchise_a is not None:
        parts.append(f"({summary.franchise_a} vs {summary.franchise_b})")
    parts.append("video" if summary.has_video else "no video")
    return "  ".join(parts)
