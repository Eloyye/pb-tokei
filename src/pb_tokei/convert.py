"""Convert broadcast footage to constant 60 fps MP4 for frame-exact seeking.

Reads original video files from disk and writes `<stem>.60fps.mp4` beside them using ffmpeg.
The original file is never modified.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import subprocess
import tempfile
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from pb_tokei.footage import VIDEO_EXTENSIONS
from pb_tokei.process import (
    CommandRunner,
    LineCallback,
    StreamRunner,
    as_stream_runner,
    stream_subprocess,
)

TARGET_FPS = 60
KEYFRAME_INTERVAL = 30
VIDEO_CRF = 18
VIDEO_PRESET = "fast"
VIDEO_PIX_FMT = "yuv420p"
AUDIO_BITRATE = "192k"
CONVERTED_SUFFIX = ".60fps.mp4"
_STDERR_TAIL_CHARS = 4000


class FootageConversionError(RuntimeError):
    """Raised when probing or converting footage to constant 60 fps fails."""

    def __init__(self, message: str, *, stderr_tail: str | None = None) -> None:
        super().__init__(message)
        self.stderr_tail = stderr_tail


@dataclass(frozen=True)
class ConvertProgress:
    """Parsed ffmpeg conversion progress derived from `-progress pipe:1` and probed duration."""

    percent: float | None = None


@dataclass(frozen=True)
class ConvertResult:
    source_path: Path
    output_path: Path
    already_converted: bool


@dataclass(frozen=True)
class _MediaProbe:
    audio_codec: str | None
    duration_s: float | None


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
    run: CommandRunner | StreamRunner | None = None,
    on_progress: Callable[[ConvertProgress], None] | None = None,
    cancel: threading.Event | None = None,
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

    probe_runner = as_stream_runner(run, _default_probe_run)
    encode_runner = as_stream_runner(run, _default_encode_run)

    probe = _probe_media(source_path, probe_runner, cancel=cancel)

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
        args = _build_ffmpeg_args(source_path, temp_path, audio_codec=probe.audio_codec)
        parser = _FfmpegProgressParser(probe.duration_s, on_progress)
        result = encode_runner(
            args,
            on_stdout_line=parser.feed if on_progress is not None else None,
            cancel=cancel,
        )
        if result.returncode != 0:
            detail = _extract_ffmpeg_error(result.stderr, result.returncode)
            stderr_raw = (result.stderr or "").strip()
            stderr_tail = stderr_raw[-_STDERR_TAIL_CHARS:] if stderr_raw else None
            raise FootageConversionError(f"ffmpeg failed: {detail}", stderr_tail=stderr_tail)
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


class _FfmpegProgressParser:
    """Parses ffmpeg `-progress pipe:1` key=value blocks into percentage updates."""

    def __init__(
        self,
        duration_s: float | None,
        on_progress: Callable[[ConvertProgress], None] | None,
    ) -> None:
        self._duration_s = duration_s
        self._on_progress = on_progress
        self._out_time_us: int | None = None

    def feed(self, line: str) -> None:
        if self._on_progress is None:
            return
        key, sep, value = line.strip().partition("=")
        if not sep:
            return
        value = value.strip()
        if key == "out_time_us":
            parsed = _parse_non_negative_int(value)
            if parsed is not None:
                self._out_time_us = parsed
        elif key == "out_time_ms" and self._out_time_us is None:
            # ffmpeg historically reports microseconds in out_time_ms too.
            parsed = _parse_non_negative_int(value)
            if parsed is not None:
                self._out_time_us = parsed
        elif key == "out_time" and self._out_time_us is None:
            parsed = _parse_hms_us(value)
            if parsed is not None:
                self._out_time_us = parsed
        elif key == "progress":
            if value == "end":
                self._on_progress(ConvertProgress(percent=100.0))
            elif value == "continue":
                percent: float | None = None
                if (
                    self._duration_s is not None
                    and self._duration_s > 0
                    and self._out_time_us is not None
                ):
                    raw_pct = (self._out_time_us / 1_000_000.0 / self._duration_s) * 100.0
                    percent = round(min(100.0, max(0.0, raw_pct)), 1)
                self._on_progress(ConvertProgress(percent=percent))
            self._out_time_us = None


def _parse_non_negative_int(raw: str) -> int | None:
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value >= 0 else None


def _parse_hms_us(raw: str) -> int | None:
    parts = raw.split(":")
    if len(parts) != 3:
        return None
    try:
        hours = int(parts[0])
        minutes = int(parts[1])
        seconds = float(parts[2])
    except ValueError:
        return None
    if hours < 0 or minutes < 0 or seconds < 0 or not math.isfinite(seconds):
        return None
    return int(round((hours * 3600 + minutes * 60 + seconds) * 1_000_000))


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
        "-nostats",
        "-progress",
        "pipe:1",
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


def _probe_media(
    source_path: Path,
    runner: StreamRunner,
    *,
    cancel: threading.Event | None = None,
) -> _MediaProbe:
    args = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,duration",
        "-of",
        "json",
        str(source_path),
    ]
    result = runner(args, cancel=cancel)
    if result.returncode != 0:
        stderr_raw = (result.stderr or "").strip()
        detail = stderr_raw or f"exit status {result.returncode}"
        stderr_tail = stderr_raw[-_STDERR_TAIL_CHARS:] if stderr_raw else None
        raise FootageConversionError(f"ffprobe failed: {detail}", stderr_tail=stderr_tail)
    return _parse_probe_output(result.stdout)


def _parse_probe_output(stdout: str) -> _MediaProbe:
    text = stdout.strip()
    if not text:
        return _MediaProbe(audio_codec=None, duration_s=None)
    if text.startswith("{"):
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = None
        if isinstance(payload, dict):
            audio_codec: str | None = None
            stream_duration: float | None = None
            streams = payload.get("streams")
            if isinstance(streams, list):
                for stream in streams:
                    if not isinstance(stream, dict):
                        continue
                    codec_type = stream.get("codec_type")
                    codec_name = stream.get("codec_name")
                    if (
                        codec_type == "audio"
                        and audio_codec is None
                        and isinstance(codec_name, str)
                        and codec_name.strip()
                    ):
                        audio_codec = codec_name.strip().lower()
                    if codec_type == "video" and stream_duration is None:
                        stream_duration = _parse_positive_float(stream.get("duration"))
            fmt = payload.get("format")
            format_duration = (
                _parse_positive_float(fmt.get("duration")) if isinstance(fmt, dict) else None
            )
            return _MediaProbe(
                audio_codec=audio_codec,
                duration_s=format_duration if format_duration is not None else stream_duration,
            )
    # Fallback for plain single-line codec output (e.g. lightweight test doubles).
    lines = [line.strip().lower() for line in text.splitlines() if line.strip()]
    return _MediaProbe(audio_codec=lines[0] if lines else None, duration_s=None)


def _parse_positive_float(value: object) -> float | None:
    if isinstance(value, (int, float)):
        parsed = float(value)
    elif isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    return parsed if math.isfinite(parsed) and parsed > 0 else None


def _default_probe_run(
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
        )
    except FileNotFoundError as exc:
        raise FootageConversionError(
            "ffprobe is not installed or not on PATH; install ffmpeg and try again"
        ) from exc


def _default_encode_run(
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
            capture_stdout=False,
        )
    except FileNotFoundError as exc:
        raise FootageConversionError(
            "ffmpeg is not installed or not on PATH; install ffmpeg and try again"
        ) from exc
