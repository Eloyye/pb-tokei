"""Download broadcast footage via yt-dlp into a local directory.

This module is the only part of pb-tokei that talks to yt-dlp or the network. Everything
else reads video files from disk.
"""

from __future__ import annotations

import math
import re
import subprocess
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from pb_tokei.process import (
    CommandCancelledError,
    CommandRunner,
    LineCallback,
    StreamRunner,
    as_stream_runner,
    stream_subprocess,
)
from pb_tokei.rally_log import SourceVideo

__all__ = [
    "DEFAULT_FOOTAGE_DIR",
    "FORMAT_SELECTOR",
    "FORMAT_SORT",
    "PROGRESS_PREFIX",
    "PROGRESS_TEMPLATE",
    "VIDEO_EXTENSIONS",
    "CommandCancelledError",
    "CommandRunner",
    "DownloadProgress",
    "DownloadResult",
    "FootageDownloadError",
    "StreamRunner",
    "download_footage",
    "find_existing_footage",
    "parse_yt_dlp_progress",
    "probe_video_id",
    "validate_cookies_from_browser",
    "validate_url",
]

DEFAULT_FOOTAGE_DIR = Path("footage")

# Best video + best audio (audio is kept for contact detection and Referee Calls),
# falling back to the best combined stream when separate streams aren't offered.
FORMAT_SELECTOR = "bv*+ba/b"

# Prefer the highest frame rate available (60 fps) over higher resolution: ball and
# contact detection need frames more than pixels.
FORMAT_SORT = "fps,res"

VIDEO_EXTENSIONS = frozenset(
    {"mp4", "mkv", "webm", "mov", "flv", "avi", "ts", "m4v", "mpg", "mpeg", "ogv", "3gp"}
)

PROGRESS_PREFIX = "pb-tokei-progress:"
PROGRESS_TEMPLATE = (
    f"download:{PROGRESS_PREFIX}"
    "%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
)

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_STDERR_TAIL_CHARS = 4000


class FootageDownloadError(RuntimeError):
    """Raised when probing or downloading broadcast footage fails."""

    def __init__(self, message: str, *, stderr_tail: str | None = None) -> None:
        super().__init__(message)
        self.stderr_tail = stderr_tail


@dataclass(frozen=True)
class DownloadProgress:
    """Parsed yt-dlp download progress from a single `--progress-template` line."""

    percent: float | None = None
    speed: str | None = None
    eta: str | None = None


@dataclass(frozen=True)
class DownloadResult:
    source_video: SourceVideo
    already_downloaded: bool


def parse_yt_dlp_progress(line: str) -> DownloadProgress | None:
    """Parses one line emitted by `PROGRESS_TEMPLATE`, or returns None if not a progress line."""
    clean = _ANSI_RE.sub("", line).strip()
    if not clean.startswith(PROGRESS_PREFIX):
        return None
    parts = clean[len(PROGRESS_PREFIX) :].split("|")
    if len(parts) != 3:
        return None
    percent_raw, speed_raw, eta_raw = (p.strip() for p in parts)
    return DownloadProgress(
        percent=_parse_percent(percent_raw),
        speed=_parse_optional_field(speed_raw),
        eta=_parse_optional_field(eta_raw),
    )


def _parse_percent(raw: str) -> float | None:
    text = raw.rstrip("%").strip()
    try:
        value = float(text)
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    return round(min(100.0, max(0.0, value)), 1)


def _parse_optional_field(raw: str) -> str | None:
    if not raw:
        return None
    lower = raw.lower()
    if lower in {"n/a", "na", "none"} or lower.startswith("unknown"):
        return None
    return raw


def find_existing_footage(footage_dir: Path, video_id: str) -> Path | None:
    """Returns an existing downloaded video for `video_id` in `footage_dir`, or None."""
    _validate_video_id(video_id)
    return _find_existing_footage(footage_dir, video_id)


def probe_video_id(
    url: str,
    *,
    cookies: Path | None = None,
    cookies_from_browser: str | None = None,
    run: CommandRunner | StreamRunner | None = None,
    cancel: threading.Event | None = None,
) -> str:
    """Queries yt-dlp for the single video ID of `url` without downloading media."""
    validate_url(url)
    cookie_args = _cookie_args(cookies, cookies_from_browser)
    runner = as_stream_runner(run, _default_stream_run)
    return _probe_video_id(url, runner, cookie_args=cookie_args, cancel=cancel)


def download_footage(
    url: str,
    footage_dir: Path = DEFAULT_FOOTAGE_DIR,
    *,
    cookies: Path | None = None,
    cookies_from_browser: str | None = None,
    run: CommandRunner | StreamRunner | None = None,
    on_progress: Callable[[DownloadProgress], None] | None = None,
    cancel: threading.Event | None = None,
) -> DownloadResult:
    """Downloads a broadcast at the highest frame rate available into `footage_dir`.

    If the video is already present in `footage_dir`, returns its path without downloading again.
    """
    validate_url(url)
    cookie_args = _cookie_args(cookies, cookies_from_browser)
    if footage_dir.exists() and not footage_dir.is_dir():
        raise FootageDownloadError(f"Footage path is not a directory: {footage_dir}")

    runner = as_stream_runner(run, _default_stream_run)
    video_id = _probe_video_id(url, runner, cookie_args=cookie_args, cancel=cancel)

    existing = _find_existing_footage(footage_dir, video_id)
    if existing is not None:
        return DownloadResult(
            source_video=SourceVideo(url=url, video_id=video_id, path=existing),
            already_downloaded=True,
        )

    footage_dir.mkdir(parents=True, exist_ok=True)
    # Pass footage_dir via -P rather than inside -o so a '%' in the directory path is never
    # interpreted as a yt-dlp output template. --progress overrides the --quiet implied by --print.
    args = [
        "yt-dlp",
        *cookie_args,
        "--no-playlist",
        "-f",
        FORMAT_SELECTOR,
        "-S",
        FORMAT_SORT,
        "--no-overwrites",
        "--no-simulate",
        "--progress",
        "--newline",
        "--progress-template",
        PROGRESS_TEMPLATE,
        "--print",
        "after_move:filepath",
        "-P",
        str(footage_dir),
        "-o",
        "%(id)s.%(ext)s",
        "--",
        url,
    ]
    lines = _run_yt_dlp(runner, args, on_progress=on_progress, cancel=cancel)
    if len(lines) != 1:
        raise FootageDownloadError(
            f"yt-dlp returned unexpected filepath output for {url}: {lines!r}"
        )

    raw_path = Path(lines[0])
    resolved_dir = footage_dir.resolve()
    resolved_file = raw_path.resolve()
    if resolved_file.parent != resolved_dir or not resolved_file.is_file():
        raise FootageDownloadError(f"Downloaded file {raw_path} is not a file inside {footage_dir}")
    if resolved_file.stat().st_size == 0:
        raise FootageDownloadError(f"Downloaded file is empty: {raw_path}")

    canonical_path = footage_dir / raw_path.name
    return DownloadResult(
        source_video=SourceVideo(url=url, video_id=video_id, path=canonical_path),
        already_downloaded=False,
    )


def _find_existing_footage(footage_dir: Path, video_id: str) -> Path | None:
    if not footage_dir.is_dir():
        return None
    prefix = f"{video_id}."
    for entry in sorted(footage_dir.iterdir()):
        if not entry.name.startswith(prefix) or not entry.is_file():
            continue
        ext = entry.name[len(prefix) :]
        # Ignore multi-part extensions (.f137.mp4, .mp4.part, .60fps.mp4) and non-video files.
        if "." in ext or ext.lower() not in VIDEO_EXTENSIONS:
            continue
        if entry.stat().st_size > 0:
            return entry
    return None


def _probe_video_id(
    url: str,
    runner: StreamRunner,
    *,
    cookie_args: Sequence[str] = (),
    cancel: threading.Event | None = None,
) -> str:
    # --playlist-end 2 avoids fetching an entire playlist while still detecting multi-video URLs.
    args = [
        "yt-dlp",
        *cookie_args,
        "--no-playlist",
        "--playlist-end",
        "2",
        "--skip-download",
        "--print",
        "%(id)s",
        "--",
        url,
    ]
    lines = _run_yt_dlp(runner, args, cancel=cancel)
    if len(lines) != 1:
        if len(lines) > 1:
            raise FootageDownloadError(
                f"URL resolved to multiple videos; pass a single video URL: {url}"
            )
        raise FootageDownloadError(f"yt-dlp did not return a video ID for {url}")
    video_id = lines[0]
    _validate_video_id(video_id)
    return video_id


def validate_cookies_from_browser(cookies_from_browser: str) -> str:
    """Validates and normalizes a `--cookies-from-browser` value, raising FootageDownloadError."""
    spec = cookies_from_browser.strip(" ")
    if not spec or spec.startswith("-") or any(ord(ch) < 32 or ord(ch) == 127 for ch in spec):
        raise FootageDownloadError(
            f"Invalid --cookies-from-browser value: {cookies_from_browser!r}"
        )
    return spec


def _cookie_args(
    cookies: Path | None,
    cookies_from_browser: str | None,
) -> list[str]:
    if cookies is not None and cookies_from_browser is not None:
        raise FootageDownloadError("Pass either cookies or cookies_from_browser, not both")
    if cookies is not None:
        raw_path = str(cookies)
        if "\x00" in raw_path:
            raise FootageDownloadError(f"Invalid cookies path (contains NUL byte): {cookies!r}")
        if not cookies.exists():
            raise FootageDownloadError(f"Cookies file not found: {cookies}")
        if not cookies.is_file():
            raise FootageDownloadError(f"Cookies path is not a file: {cookies}")
        safe_path = f"./{raw_path}" if raw_path.startswith("-") else raw_path
        # Clear any --cookies-from-browser set in yt-dlp's own config so the explicit file wins.
        return ["--no-cookies-from-browser", "--cookies", safe_path]
    if cookies_from_browser is not None:
        spec = validate_cookies_from_browser(cookies_from_browser)
        # Clear any --cookies set in yt-dlp's own config so the explicit browser wins.
        return ["--no-cookies", "--cookies-from-browser", spec]
    return []


def _default_stream_run(
    args: Sequence[str],
    *,
    on_stdout_line: LineCallback | None = None,
    on_stderr_line: LineCallback | None = None,
    cancel: threading.Event | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return stream_subprocess(
            args,
            on_stdout_line=on_stdout_line,
            on_stderr_line=on_stderr_line,
            cancel=cancel,
            capture_stdout=on_stdout_line is None,
        )
    except FileNotFoundError as exc:
        raise FootageDownloadError(
            "yt-dlp is not installed or not on PATH; install yt-dlp and try again"
        ) from exc


def _run_yt_dlp(
    runner: StreamRunner,
    args: Sequence[str],
    *,
    on_progress: Callable[[DownloadProgress], None] | None = None,
    cancel: threading.Event | None = None,
) -> list[str]:
    output_lines: list[str] = []

    def handle_stdout_line(line: str) -> None:
        parsed = parse_yt_dlp_progress(line)
        if parsed is not None:
            if on_progress is not None:
                on_progress(parsed)
            return
        stripped = line.strip()
        if stripped:
            output_lines.append(stripped)

    def handle_stderr_line(line: str) -> None:
        if on_progress is None:
            return
        parsed = parse_yt_dlp_progress(line)
        if parsed is not None:
            on_progress(parsed)

    result = runner(
        args,
        on_stdout_line=handle_stdout_line,
        on_stderr_line=handle_stderr_line if on_progress is not None else None,
        cancel=cancel,
    )
    if result.returncode != 0:
        stderr_raw = (result.stderr or "").strip()
        # Exclude our own progress lines from error summary if yt-dlp printed progress to stderr.
        err_lines = [
            line.strip()
            for line in stderr_raw.splitlines()
            if line.strip() and not _ANSI_RE.sub("", line).strip().startswith(PROGRESS_PREFIX)
        ]
        detail = "\n".join(err_lines) or f"exit status {result.returncode}"
        stderr_tail = stderr_raw[-_STDERR_TAIL_CHARS:] if stderr_raw else None
        raise FootageDownloadError(f"yt-dlp failed: {detail}", stderr_tail=stderr_tail)
    if result.stdout:
        return [
            line.strip()
            for line in result.stdout.splitlines()
            if line.strip() and not _ANSI_RE.sub("", line).strip().startswith(PROGRESS_PREFIX)
        ]
    return output_lines


def validate_url(url: str) -> None:
    error = f"Expected an http(s) URL, got: {url!r}"
    if not url or any(ch.isspace() for ch in url):
        raise FootageDownloadError(error)
    try:
        parsed = urlparse(url)
    except ValueError:
        raise FootageDownloadError(error) from None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise FootageDownloadError(error)


def _validate_video_id(video_id: str) -> None:
    if (
        not video_id
        or video_id.startswith(".")
        or "/" in video_id
        or "\\" in video_id
        or "\x00" in video_id
    ):
        raise FootageDownloadError(f"Invalid video ID from yt-dlp: {video_id!r}")
