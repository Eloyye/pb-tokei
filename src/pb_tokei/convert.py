"""Convert broadcast footage to constant 60 fps MP4 for frame-exact seeking.

Reads original video files from disk and writes `<stem>.60fps.mp4` beside them using ffmpeg.
The original file is never modified.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from pb_tokei.footage import CommandRunner

TARGET_FPS = 60
KEYFRAME_INTERVAL = 30
VIDEO_CRF = 18
VIDEO_PRESET = "fast"
VIDEO_PIX_FMT = "yuv420p"
AUDIO_BITRATE = "192k"
CONVERTED_SUFFIX = ".60fps.mp4"


class FootageConversionError(RuntimeError):
    """Raised when probing or converting footage to constant 60 fps fails."""


@dataclass(frozen=True)
class ConvertResult:
    source_path: Path
    output_path: Path
    already_converted: bool


def converted_path_for(source_path: Path) -> Path:
    """Returns the derived `<stem>.60fps.mp4` path beside an original `source_path`."""
    if source_path.name.lower().endswith(CONVERTED_SUFFIX):
        raise FootageConversionError(
            f"Source video is already a converted 60 fps file: {source_path}"
        )
    return source_path.with_name(f"{source_path.stem}{CONVERTED_SUFFIX}")


def convert_footage(
    source_path: Path,
    *,
    force: bool = False,
    run: CommandRunner | None = None,
) -> ConvertResult:
    """Converts `source_path` to a constant 60 fps MP4 beside the original.

    Writes to a temporary file in the same directory and atomically renames it into place
    only after ffmpeg succeeds. Skips conversion if a non-empty converted file already
    exists unless `force=True`.
    """
    if not source_path.is_file():
        raise FootageConversionError(f"Source video not found: {source_path}")
    if source_path.stat().st_size == 0:
        raise FootageConversionError(f"Source video is empty: {source_path}")

    output_path = converted_path_for(source_path)
    if output_path.exists() and not output_path.is_file():
        raise FootageConversionError(f"Converted output path is not a file: {output_path}")

    if not force and output_path.is_file() and output_path.stat().st_size > 0:
        return ConvertResult(
            source_path=source_path,
            output_path=output_path,
            already_converted=True,
        )

    probe_runner = _default_probe_run if run is None else run
    encode_runner = _default_encode_run if run is None else run

    audio_codec = _probe_audio_codec(source_path, probe_runner)

    fd, raw_temp = tempfile.mkstemp(
        dir=output_path.parent,
        prefix=f".{output_path.stem}.",
        suffix=".tmp.mp4",
    )
    os.close(fd)
    temp_path = Path(raw_temp)

    try:
        args = _build_ffmpeg_args(source_path, temp_path, audio_codec=audio_codec)
        result = encode_runner(args)
        if result.returncode != 0:
            detail = (result.stderr or "").strip() or f"exit status {result.returncode}"
            raise FootageConversionError(f"ffmpeg failed: {detail}")
        if not temp_path.is_file() or temp_path.stat().st_size == 0:
            raise FootageConversionError(f"ffmpeg produced an empty output file for {source_path}")
        temp_path.replace(output_path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    return ConvertResult(
        source_path=source_path,
        output_path=output_path,
        already_converted=False,
    )


def _build_ffmpeg_args(
    source_path: Path,
    temp_output_path: Path,
    *,
    audio_codec: str | None,
) -> list[str]:
    args = [
        "ffmpeg",
        "-nostdin",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-stats",
        "-i",
        str(source_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-r",
        str(TARGET_FPS),
        "-fps_mode",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        VIDEO_PRESET,
        "-crf",
        str(VIDEO_CRF),
        "-pix_fmt",
        VIDEO_PIX_FMT,
        "-g",
        str(KEYFRAME_INTERVAL),
        "-keyint_min",
        str(KEYFRAME_INTERVAL),
        "-sc_threshold",
        "0",
    ]
    if audio_codec == "aac":
        args.extend(["-c:a", "copy"])
    elif audio_codec is not None:
        args.extend(["-c:a", "aac", "-b:a", AUDIO_BITRATE])
    else:
        args.append("-an")
    args.extend(["-movflags", "+faststart", "-f", "mp4", str(temp_output_path)])
    return args


def _probe_audio_codec(source_path: Path, runner: CommandRunner) -> str | None:
    args = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(source_path),
    ]
    result = runner(args)
    if result.returncode != 0:
        detail = (result.stderr or "").strip() or f"exit status {result.returncode}"
        raise FootageConversionError(f"ffprobe failed: {detail}")
    lines = [line.strip().lower() for line in result.stdout.splitlines() if line.strip()]
    return lines[0] if lines else None


def _default_probe_run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, capture_output=True, text=True, check=False)
    except FileNotFoundError as exc:
        raise FootageConversionError(
            "ffprobe is not installed or not on PATH; install ffmpeg and try again"
        ) from exc


def _default_encode_run(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    try:
        # Leave stderr uncaptured so ffmpeg's live -stats progress streams to the terminal.
        return subprocess.run(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise FootageConversionError(
            "ffmpeg is not installed or not on PATH; install ffmpeg and try again"
        ) from exc
