"""Command-line interface for pb-tokei."""

from __future__ import annotations

import argparse
import shlex
import sys
from collections.abc import Sequence
from pathlib import Path
from uuid import UUID

from pb_tokei.convert import FootageConversionError, convert_footage
from pb_tokei.footage import (
    DEFAULT_FOOTAGE_DIR,
    CommandRunner,
    FootageDownloadError,
    download_footage,
)
from pb_tokei.rally_log import MatchId, RallyLog

DEFAULT_DB_PATH = Path("rally_log.duckdb")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pb-tokei",
        description="Statistics on pro doubles pickleball derived from broadcast footage.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    download = subparsers.add_parser(
        "download",
        help="Download a broadcast video into footage/ and convert it to constant 60 fps.",
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

    convert = subparsers.add_parser(
        "convert",
        help="Convert a downloaded video on disk to constant 60 fps MP4.",
    )
    convert.add_argument(
        "path",
        type=Path,
        help="Path to the original footage file to convert.",
    )
    convert.add_argument(
        "--force",
        action="store_true",
        help="Re-convert even if the 60 fps file already exists.",
    )
    return parser


def main(
    argv: Sequence[str] | None = None,
    *,
    run: CommandRunner | None = None,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "download":
        return _run_download(args, parser=parser, run=run)
    if args.command == "convert":
        return _run_convert(args, run=run)

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

    try:
        converted = convert_footage(result.source_video.path, run=run)
    except FootageConversionError as exc:
        retry_path = shlex.quote(str(result.source_video.path))
        print(f"error: {exc}", file=sys.stderr)
        print(
            f"Original footage kept at {result.source_video.path}. "
            f"Run: pb-tokei convert {retry_path}",
            file=sys.stderr,
        )
        return 1

    print(converted.output_path)
    return 0


def _run_convert(
    args: argparse.Namespace,
    *,
    run: CommandRunner | None,
) -> int:
    try:
        converted = convert_footage(args.path, force=args.force, run=run)
    except FootageConversionError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(converted.output_path)
    return 0
