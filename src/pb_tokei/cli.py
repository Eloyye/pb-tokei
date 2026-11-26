"""Command-line interface for pb-tokei."""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from collections.abc import Sequence
from dataclasses import replace
from functools import partial
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import UUID

import duckdb

if TYPE_CHECKING:
    from pb_tokei.player_vision import VisionBackend

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
from pb_tokei.roster import (
    AmbiguousFranchiseMatchError,
    RosterError,
    read_roster,
    roster_template,
    set_up_match,
)
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

    track = subparsers.add_parser(
        "track",
        help="Track all four Players across calibrated Play Segments and cache results.",
    )
    track.add_argument("match_id", help="Match UUID in the Rally Log.")
    _db_argument(track)
    track.add_argument(
        "--device",
        choices=("auto", "mps", "cuda", "cpu"),
        default="auto",
        help="Compute device for person detection and pose estimation (default: auto).",
    )

    dev = subparsers.add_parser("dev", help="Maintain this development checkout.")
    dev_commands = dev.add_subparsers(dest="dev_command", required=True)
    update = dev_commands.add_parser(
        "update", help="Install web dependencies and rebuild a stale front end."
    )
    update.set_defaults(handler=_run_dev_update)
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
    player_backend: VisionBackend | None = None,
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
    if args.command == "track":
        return _run_track(args, parser=parser, backend=player_backend)
    if args.command == "dev":
        return args.handler(run=run)

    parser.error(f"Unknown command: {args.command}")


class _CliProgressLine:
    """Prints progress to stderr: one updating `\\r` line on a TTY, or coarse milestone lines
    without `\\r` when stderr is redirected (emitting nothing if no updates arrive)."""

    _NON_TTY_STEP_PCT = 25

    def __init__(self) -> None:
        self._width = 0
        self._active = False
        self._last_bucket: tuple[str, int] | None = None

    def update(self, phase: str, percent: float | None, text: str) -> None:
        if sys.stderr.isatty():
            pad = max(0, self._width - len(text))
            sys.stderr.write(f"\r{text}{' ' * pad}")
            sys.stderr.flush()
            self._width = max(self._width, len(text))
            self._active = True
            return

        bucket = (
            -1
            if percent is None
            else (
                100
                if percent >= 100.0
                else (int(percent) // self._NON_TTY_STEP_PCT) * self._NON_TTY_STEP_PCT
            )
        )
        key = (phase, bucket)
        if key == self._last_bucket:
            return
        self._last_bucket = key
        sys.stderr.write(f"{text}\n")
        sys.stderr.flush()

    def finish(self) -> None:
        if self._active:
            sys.stderr.write("\n")
            sys.stderr.flush()
            self._width = 0
            self._active = False
        self._last_bucket = None


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
            on_progress=lambda p: progress_line.update(
                "download", p.percent, _format_download_progress(p)
            ),
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
            on_progress=lambda p: progress_line.update(
                "convert", p.percent, _format_convert_progress(p)
            ),
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
            on_progress=lambda p: progress_line.update(
                "convert", p.percent, _format_convert_progress(p)
            ),
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
    except AmbiguousFranchiseMatchError as exc:
        ids = ", ".join(str(id_) for id_ in exc.choices)
        print(f"error: {exc} ({ids}). Give [franchise_match] id to pick one.", file=sys.stderr)
        return 1
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


def _run_track(
    args: argparse.Namespace,
    *,
    parser: argparse.ArgumentParser,
    backend: VisionBackend | None = None,
) -> int:
    from pb_tokei.calibration import CourtMapping
    from pb_tokei.camera_motion import CameraMotionCache, default_cache_dir
    from pb_tokei.convert import converted_path_for
    from pb_tokei.player_tracking import PlayerTrackingCache, default_player_cache_dir
    from pb_tokei.player_vision import PlayerTrackingError, TorchVisionBackend
    from pb_tokei.rally_log import MatchNotFound, resolve_video_path

    try:
        match_id = MatchId(UUID(args.match_id))
    except ValueError:
        parser.error(f"Invalid match UUID: {args.match_id}")

    db_path = _resolve_cli_db(args.db)
    if db_path is None:
        return 1

    try:
        with RallyLog.open(db_path) as log:
            summary = log.get_match_summary(match_id)
            roster = log.get_match_roster(match_id)
            segments = log.get_play_segments(match_id)
            calibrations = log.get_calibrations(match_id)
            anchors = log.get_player_anchors(match_id)
            team_ends = log.get_team_ends(match_id)
    except KeyError, MatchNotFound:
        print(f"error: Match not found in {db_path}: {match_id}", file=sys.stderr)
        return 1
    except (duckdb.Error, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if summary.source_video is None:
        print(f"error: Match {match_id} has no recorded Source Video", file=sys.stderr)
        return 1

    source_path = resolve_video_path(summary.source_video.path, db_path)
    try:
        video_path = converted_path_for(source_path)
    except FootageConversionError:
        video_path = source_path
    if not video_path.is_file():
        print(
            f"error: Converted 60 fps video not found at {video_path}. "
            f"Run: pb-tokei convert {shlex.quote(str(source_path))}",
            file=sys.stderr,
        )
        return 1

    if not segments:
        print(
            f"error: Match {match_id} has no Play Segments yet. Mark them in pb-tokei annotate.",
            file=sys.stderr,
        )
        return 1

    progress_line = _CliProgressLine()
    try:
        motion_cache = CameraMotionCache(default_cache_dir(db_path))
        reg_map = motion_cache.landmark_frame_to_ref(video_path, segments, calibrations)
        motion = motion_cache.track_match(video_path, segments, calibrations)
        mapping = CourtMapping(
            segments, calibrations, camera_motion=motion, landmark_frame_to_ref=reg_map
        )

        active_backend: VisionBackend = (
            backend if backend is not None else TorchVisionBackend(device=args.device)
        )

        print(f"Device: {active_backend.device.value.upper()}", file=sys.stderr)
        player_cache = PlayerTrackingCache(
            default_player_cache_dir(db_path),
            detector_model=active_backend.detector_model,
            pose_model=active_backend.pose_model,
        )
        player_cache.track_match(
            video_path,
            roster,
            segments,
            calibrations,
            mapping,
            motion,
            anchors,
            team_ends,
            backend=active_backend,
            on_progress=lambda done, total, seg: progress_line.update(
                "track",
                100.0 * done / max(1, total),
                f"Tracking Players {100.0 * done / max(1, total):.1f}% "
                f"({seg.camera_view.value} {seg.start_frame}-{seg.end_frame})",
            ),
        )
    except (PlayerTrackingError, OSError, ValueError) as exc:
        progress_line.finish()
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        progress_line.finish()

    total_frames = sum(s.end_frame - s.start_frame + 1 for s in segments)
    print(
        f"Tracked {len(segments)} Play Segment{'s' if len(segments) != 1 else ''} "
        f"({total_frames} frames) on {active_backend.device.value.upper()}"
    )
    return 0


def _run_dev_update(*, run: CommandRunner | None) -> int:
    from pb_tokei.annotate.frontend import STATIC_DIR, WEB_DIR, bundle_is_current

    if not WEB_DIR.is_dir():
        print(f"error: dev update requires a source checkout with {WEB_DIR}", file=sys.stderr)
        return 1
    runner = run
    if runner is None:
        runner = partial(subprocess.run, cwd=WEB_DIR, text=True, check=False)

    print("python deps: managed by uv run", flush=True)
    try:
        runner(["bun", "install", "--frozen-lockfile"]).check_returncode()
        print("web deps:    bun install --frozen-lockfile succeeded", flush=True)
        if bundle_is_current(WEB_DIR, STATIC_DIR):
            print("front end:   up to date, skipped build")
        else:
            runner(["bun", "run", "build"]).check_returncode()
            print("front end:   rebuilt")
    except subprocess.CalledProcessError as exc:
        print(f"error: {shlex.join(exc.cmd)} exited with status {exc.returncode}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0
