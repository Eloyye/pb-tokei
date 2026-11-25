"""Command-line interface for pb-tokei."""

from __future__ import annotations

import argparse
import shlex
import sys
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from uuid import UUID

import duckdb

from pb_tokei.convert import ConvertProgress, FootageConversionError, convert_footage
from pb_tokei.footage import (
    DEFAULT_FOOTAGE_DIR,
    CommandRunner,
    DownloadProgress,
    FootageDownloadError,
    StreamRunner,
    download_footage,
)
from pb_tokei.rally_log import (
    DEFAULT_DB_PATH,
    MatchId,
    MatchSummary,
    RallyLog,
    stored_video_path,
)
from pb_tokei.roster import RosterError, read_roster, roster_template, set_up_match
from pb_tokei.state import RallyLogNotFoundError, resolve_rally_log, write_last_rally_log

DEFAULT_ANNOTATE_PORT = 8000


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
        default=None,
        help=(
            "Directory to store downloaded footage "
            f"(default: <Rally Log dir>/{DEFAULT_FOOTAGE_DIR} with --match, "
            f"otherwise {DEFAULT_FOOTAGE_DIR})."
        ),
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
        help=(
            "Path to the Rally Log DuckDB file "
            f"(default when --match is set: last opened in annotate, else {DEFAULT_DB_PATH})."
        ),
    )
    cookies_group = download.add_mutually_exclusive_group()
    cookies_group.add_argument(
        "--cookies",
        type=Path,
        default=None,
        help="Path to a Netscape-format cookies file to pass to yt-dlp.",
    )
    cookies_group.add_argument(
        "--cookies-from-browser",
        metavar="BROWSER",
        default=None,
        help=(
            "Browser to load cookies from via yt-dlp "
            "(e.g. chrome, firefox, safari, or 'chrome:Profile 1')."
        ),
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

    annotate = subparsers.add_parser(
        "annotate", help="Open the annotation web app on this machine (127.0.0.1 only)."
    )
    _db_argument(annotate)
    annotate.add_argument(
        "--port",
        type=int,
        default=DEFAULT_ANNOTATE_PORT,
        help=f"Port to serve on (default: {DEFAULT_ANNOTATE_PORT}).",
    )
    annotate.add_argument(
        "--no-browser", action="store_true", help="Don't open the app in a browser."
    )
    return parser


def _db_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--db",
        type=Path,
        default=None,
        help=(
            "Path to the Rally Log DuckDB file "
            f"(default: last opened in annotate, else {DEFAULT_DB_PATH})."
        ),
    )


def _resolve_cli_db(explicit: Path | None, *, allow_create: bool = False) -> Path | None:
    try:
        db_path = resolve_rally_log(explicit, allow_create=allow_create)
    except RallyLogNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return None
    print(f"Rally Log: {db_path}", file=sys.stderr)
    return db_path


def main(
    argv: Sequence[str] | None = None,
    *,
    run: CommandRunner | StreamRunner | None = None,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "download":
        return _run_download(args, parser=parser, run=run)
    if args.command == "convert":
        return _run_convert(args, run=run)
    if args.command == "match":
        return args.handler(args)
    if args.command == "annotate":
        return _run_annotate(args)

    parser.error(f"Unknown command: {args.command}")


class _CliProgressLine:
    """Prints a single updating progress line to stderr, emitting nothing if no updates arrive."""

    def __init__(self) -> None:
        self._width = 0
        self._active = False

    def update(self, text: str) -> None:
        pad = max(0, self._width - len(text))
        sys.stderr.write(f"\r{text}{' ' * pad}")
        sys.stderr.flush()
        self._width = max(self._width, len(text))
        self._active = True

    def finish(self) -> None:
        if self._active:
            sys.stderr.write("\n")
            sys.stderr.flush()
            self._width = 0
            self._active = False


def _format_download_progress(progress: DownloadProgress) -> str:
    pct = f"{progress.percent:.1f}%" if progress.percent is not None else "..."
    details = [
        part
        for part in (
            progress.speed,
            f"ETA {progress.eta}" if progress.eta is not None else None,
        )
        if part is not None
    ]
    if details:
        return f"Downloading {pct} ({', '.join(details)})"
    return f"Downloading {pct}"


def _format_convert_progress(progress: ConvertProgress) -> str:
    pct = f"{progress.percent:.1f}%" if progress.percent is not None else "..."
    return f"Converting {pct}"


def _run_download(
    args: argparse.Namespace,
    *,
    parser: argparse.ArgumentParser,
    run: CommandRunner | StreamRunner | None,
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
        db_path = _resolve_cli_db(args.db)
        if db_path is None:
            return 1
        with RallyLog.open(db_path) as log:
            if not log.has_match(match_id):
                print(f"error: Match not found in {db_path}: {match_id}", file=sys.stderr)
                return 1
        footage_dir = (
            db_path.parent / DEFAULT_FOOTAGE_DIR if args.footage_dir is None else args.footage_dir
        )
    else:
        footage_dir = DEFAULT_FOOTAGE_DIR if args.footage_dir is None else args.footage_dir

    progress_line = _CliProgressLine()
    try:
        result = download_footage(
            args.url,
            footage_dir,
            cookies=args.cookies,
            cookies_from_browser=args.cookies_from_browser,
            run=run,
            on_progress=lambda p: progress_line.update(_format_download_progress(p)),
        )
    except FootageDownloadError as exc:
        progress_line.finish()
        print(f"error: {exc}", file=sys.stderr)
        if (
            args.cookies is None
            and args.cookies_from_browser is None
            and _needs_cookies_hint(str(exc))
        ):
            print(
                "Hint: retry with --cookies-from-browser <browser> "
                "(e.g. chrome, firefox, safari) or --cookies <path>, "
                "or set them in ~/.config/yt-dlp/config.",
                file=sys.stderr,
            )
        return 1
    finally:
        progress_line.finish()

    if match_id is not None and db_path is not None:
        recorded_video = replace(
            result.source_video,
            path=stored_video_path(result.source_video.path, db_path),
        )
        try:
            with RallyLog.open(db_path) as log:
                log.set_match_source_video(match_id, recorded_video)
        except KeyError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

    try:
        converted = convert_footage(
            result.source_video.path,
            run=run,
            on_progress=lambda p: progress_line.update(_format_convert_progress(p)),
        )
    except FootageConversionError as exc:
        progress_line.finish()
        retry_path = shlex.quote(str(result.source_video.path))
        print(f"error: {exc}", file=sys.stderr)
        print(
            f"Original footage kept at {result.source_video.path}. "
            f"Run: pb-tokei convert {retry_path}",
            file=sys.stderr,
        )
        return 1
    finally:
        progress_line.finish()

    print(converted.output_path)
    return 0


def _needs_cookies_hint(message: str) -> bool:
    lower = message.lower()
    return "--cookies-from-browser" in lower or "sign in to confirm" in lower


def _run_convert(
    args: argparse.Namespace,
    *,
    run: CommandRunner | StreamRunner | None,
) -> int:
    progress_line = _CliProgressLine()
    try:
        converted = convert_footage(
            args.path,
            force=args.force,
            run=run,
            on_progress=lambda p: progress_line.update(_format_convert_progress(p)),
        )
    except FootageConversionError as exc:
        progress_line.finish()
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        progress_line.finish()

    print(converted.output_path)
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
    db_path = _resolve_cli_db(args.db, allow_create=True)
    if db_path is None:
        return 1
    if roster.video is not None:
        if not roster.video.path.is_file():
            print(
                f"warning: source video not found at {roster.video.path} "
                f"(relative [video] paths are resolved against the Roster File)",
                file=sys.stderr,
            )
        roster = replace(
            roster,
            video=replace(roster.video, path=stored_video_path(roster.video.path, db_path)),
        )
    try:
        with RallyLog.open(db_path) as log:
            match = set_up_match(log, roster)
    except (RosterError, duckdb.Error, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(match.id)
    return 0


def _match_list(args: argparse.Namespace) -> int:
    db_path = _resolve_cli_db(args.db)
    if db_path is None:
        return 1
    try:
        with RallyLog.open(db_path) as log:
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


def _run_annotate(args: argparse.Namespace) -> int:
    # Imported here so the other commands don't pay for loading FastAPI and uvicorn.
    from pb_tokei.annotate.server import FrontEndNotBuiltError, serve

    if args.db is None:
        # With nothing to fall back on, start anyway: the app opens its Rally Log picker.
        try:
            db_path = resolve_rally_log(None)
        except RallyLogNotFoundError as exc:
            print(f"{exc}\nRally Log: none open; choose or create one in the app", file=sys.stderr)
            db_path = None
        else:
            print(f"Rally Log: {db_path}", file=sys.stderr)
    else:
        db_path = _resolve_cli_db(args.db)
        if db_path is None:
            return 1
    try:
        serve(
            db_path,
            port=args.port,
            open_browser=not args.no_browser,
            on_started=None if db_path is None else lambda: write_last_rally_log(db_path),
        )
    except FrontEndNotBuiltError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0
