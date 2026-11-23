"""Convert broadcast footage to constant 60 fps MP4 for frame-exact seeking.

Reads original video files from disk and writes `<stem>.60fps.mp4` beside them using ffmpeg.
The original file is never modified.
"""

from __future__ import annotations

import contextlib
import os
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from pb_tokei.footage import VIDEO_EXTENSIONS, CommandRunner

TARGET_FPS = 60
KEYFRAME_INTERVAL = 30
VIDEO_CRF = 18
VIDEO_PRESET = "fast"
VIDEO_PIX_FMT = "yuv420p"
AUDIO_BITRATE = "192k"
CONVERTED_SUFFIX = ".60fps.mp4"
_STDERR_TAIL_BYTES = 8192


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
    exists and is at least as recent as `source_path`, unless `force=True`.
    """
    try:
        if not source_path.is_file():
            raise FootageConversionError(f"Source video not found: {source_path}")
        source_stat = source_path.stat()
    except OSError as exc:
        raise FootageConversionError(f"Cannot read source video {source_path}: {exc}") from exc

    if source_stat.st_size == 0:
        raise FootageConversionError(f"Source video is empty: {source_path}")

    output_path = converted_path_for(source_path)
    _ensure_unique_source_stem(source_path, output_path)

    output_stat: os.stat_result | None = None
    try:
        if output_path.exists():
            if not output_path.is_file():
                raise FootageConversionError(f"Converted output path is not a file: {output_path}")
            output_stat = output_path.stat()
    except OSError as exc:
        raise FootageConversionError(f"Cannot inspect output path {output_path}: {exc}") from exc

    if (
        not force
        and output_stat is not None
        and output_stat.st_size > 0
        and output_stat.st_mtime_ns >= source_stat.st_mtime_ns
    ):
        return ConvertResult(
            source_path=source_path,
            output_path=output_path,
            already_converted=True,
        )

    probe_runner = _default_probe_run if run is None else run
    encode_runner = _default_encode_run if run is None else run

    audio_codec = _probe_audio_codec(source_path, probe_runner)

    try:
        fd, raw_temp = tempfile.mkstemp(
            dir=output_path.parent,
            prefix=f".{output_path.stem}.",
            suffix=".tmp.mp4",
        )
        os.close(fd)
    except OSError as exc:
        raise FootageConversionError(
            f"Cannot create temporary file in {output_path.parent}: {exc}"
        ) from exc
    temp_path = Path(raw_temp)

    try:
        args = _build_ffmpeg_args(source_path, temp_path, audio_codec=audio_codec)
        result = encode_runner(args)
        if result.returncode != 0:
            detail = _extract_ffmpeg_error(result.stderr, result.returncode)
            raise FootageConversionError(f"ffmpeg failed: {detail}")
        try:
            if not temp_path.is_file() or temp_path.stat().st_size == 0:
                raise FootageConversionError(
                    f"ffmpeg produced an empty output file for {source_path}"
                )
            temp_path.replace(output_path)
        except OSError as exc:
            raise FootageConversionError(
                f"Cannot write converted output {output_path}: {exc}"
            ) from exc
    except BaseException:
        with contextlib.suppress(OSError):
            temp_path.unlink(missing_ok=True)
        raise

    return ConvertResult(
        source_path=source_path,
        output_path=output_path,
        already_converted=False,
    )


def _ensure_unique_source_stem(source_path: Path, output_path: Path) -> None:
    """Refuses conversion if another non-empty original video shares `<stem>.60fps.mp4`."""
    prefix = f"{source_path.stem}."
    conflicts: list[str] = []
    try:
        entries = sorted(source_path.parent.iterdir())
        for entry in entries:
            if entry.name == source_path.name or not entry.name.startswith(prefix):
                continue
            ext = entry.name[len(prefix) :]
            if "." in ext or ext.lower() not in VIDEO_EXTENSIONS:
                continue
            if entry.is_file() and entry.stat().st_size > 0:
                conflicts.append(entry.name)
    except OSError as exc:
        raise FootageConversionError(
            f"Cannot inspect footage directory {source_path.parent}: {exc}"
        ) from exc

    if conflicts:
        names = ", ".join(sorted([source_path.name, *conflicts]))
        raise FootageConversionError(
            f"Multiple source videos share output name {output_path.name}: {names}; "
            "remove or rename duplicates before converting"
        )


def _build_ffmpeg_args(
    source_path: Path,
    temp_output_path: Path,
    *,
    audio_codec: str | None,
) -> list[str]:
    # Omitting -copyts lets ffmpeg shift all streams together so timestamps start at 0 while
    # preserving A/V sync; +negative_cts_offsets writes ctts v1 so frame 0 has literal pts=0
    # without relying on an MP4 edit list.
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
    args.extend(
        [
            "-movflags",
            "+faststart+negative_cts_offsets",
            "-f",
            "mp4",
            str(temp_output_path),
        ]
    )
    return args


def _extract_ffmpeg_error(stderr: str | None, returncode: int) -> str:
    if not stderr:
        return f"exit status {returncode}"
    error_lines = [
        line.strip()
        for line in stderr.replace("\r", "\n").splitlines()
        if line.strip() and not line.lstrip().startswith(("frame=", "size="))
    ]
    if error_lines:
        return "\n".join(error_lines)
    return f"exit status {returncode}"


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
        proc = subprocess.Popen(
            args,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise FootageConversionError(
            "ffmpeg is not installed or not on PATH; install ffmpeg and try again"
        ) from exc

    tail = bytearray()
    assert proc.stderr is not None
    try:
        fd = proc.stderr.fileno()
        while True:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            sys.stderr.write(chunk.decode("utf-8", errors="replace"))
            sys.stderr.flush()
            tail.extend(chunk)
            if len(tail) > _STDERR_TAIL_BYTES:
                del tail[:-_STDERR_TAIL_BYTES]
    except BaseException:
        if proc.poll() is None:
            proc.terminate()
        raise
    finally:
        proc.stderr.close()
        proc.wait()

    return subprocess.CompletedProcess(
        args,
        proc.returncode,
        stdout="",
        stderr=tail.decode("utf-8", errors="replace"),
    )
