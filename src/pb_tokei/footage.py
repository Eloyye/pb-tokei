"""Download broadcast footage via yt-dlp into a local directory.

This module is the only part of pb-tokei that talks to yt-dlp or the network. Everything
else reads video files from disk.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from pb_tokei.rally_log import SourceVideo

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

type CommandRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]


class FootageDownloadError(RuntimeError):
    """Raised when probing or downloading broadcast footage fails."""


@dataclass(frozen=True)
class DownloadResult:
    source_video: SourceVideo
    already_downloaded: bool


def find_existing_footage(footage_dir: Path, video_id: str) -> Path | None:
    """Returns an existing downloaded video for `video_id` in `footage_dir`, or None."""
    _validate_video_id(video_id)
    return _find_existing_footage(footage_dir, video_id)


def probe_video_id(url: str, *, run: CommandRunner | None = None) -> str:
    """Queries yt-dlp for the single video ID of `url` without downloading media."""
    _validate_url(url)
    runner = _default_run if run is None else run
    return _probe_video_id(url, runner)


def download_footage(
    url: str,
    footage_dir: Path = DEFAULT_FOOTAGE_DIR,
    *,
    run: CommandRunner | None = None,
) -> DownloadResult:
    """Downloads a broadcast at the highest frame rate available into `footage_dir`.

    If the video is already present in `footage_dir`, returns its path without downloading again.
    """
    _validate_url(url)
    if footage_dir.exists() and not footage_dir.is_dir():
        raise FootageDownloadError(f"Footage path is not a directory: {footage_dir}")

    runner = _default_run if run is None else run
    video_id = _probe_video_id(url, runner)

    existing = _find_existing_footage(footage_dir, video_id)
    if existing is not None:
        return DownloadResult(
            source_video=SourceVideo(url=url, video_id=video_id, path=existing),
            already_downloaded=True,
        )

    footage_dir.mkdir(parents=True, exist_ok=True)
    # Pass footage_dir via -P rather than inside -o so a '%' in the directory path is never
    # interpreted as a yt-dlp output template.
    args = [
        "yt-dlp",
        "--no-playlist",
        "-f",
        FORMAT_SELECTOR,
        "-S",
        FORMAT_SORT,
        "--no-overwrites",
        "--no-simulate",
        "--print",
        "after_move:filepath",
        "-P",
        str(footage_dir),
        "-o",
        "%(id)s.%(ext)s",
        "--",
        url,
    ]
    lines = _run_yt_dlp(runner, args)
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


def _probe_video_id(url: str, runner: CommandRunner) -> str:
    # --playlist-end 2 avoids fetching an entire playlist while still detecting multi-video URLs.
    args = [
        "yt-dlp",
        "--no-playlist",
        "--playlist-end",
        "2",
        "--skip-download",
        "--print",
        "%(id)s",
        "--",
        url,
    ]
    lines = _run_yt_dlp(runner, args)
    if len(lines) != 1:
        if len(lines) > 1:
            raise FootageDownloadError(
                f"URL resolved to multiple videos; pass a single video URL: {url}"
            )
        raise FootageDownloadError(f"yt-dlp did not return a video ID for {url}")
    video_id = lines[0]
    _validate_video_id(video_id)
    return video_id


def _default_run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise FootageDownloadError(
            "yt-dlp is not installed or not on PATH; install yt-dlp and try again"
        ) from exc


def _run_yt_dlp(runner: CommandRunner, args: Sequence[str]) -> list[str]:
    result = runner(args)
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit status {result.returncode}"
        raise FootageDownloadError(f"yt-dlp failed: {detail}")
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _validate_url(url: str) -> None:
    if not url or any(ch.isspace() for ch in url):
        raise FootageDownloadError(f"Expected an http(s) URL, got: {url!r}")
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise FootageDownloadError(f"Expected an http(s) URL, got: {url!r}")


def _validate_video_id(video_id: str) -> None:
    if (
        not video_id
        or video_id.startswith(".")
        or "/" in video_id
        or "\\" in video_id
        or "\x00" in video_id
    ):
        raise FootageDownloadError(f"Invalid video ID from yt-dlp: {video_id!r}")
