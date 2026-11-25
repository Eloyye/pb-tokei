"""Streaming subprocess runner with line callbacks and cancellation."""

from __future__ import annotations

import inspect
import os
import selectors
import subprocess
import threading
from collections.abc import Callable, Sequence
from typing import Protocol, cast

type CommandRunner = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]
type LineCallback = Callable[[str], None]

_STDERR_TAIL_BYTES = 16_384
_POLL_INTERVAL_S = 0.05
_TERMINATE_GRACE_S = 1.0


class CommandCancelledError(RuntimeError):
    """Raised when a streaming subprocess is cancelled before it finishes."""


class StreamRunner(Protocol):
    """Runs an external command while streaming stdout/stderr lines and supporting cancel."""

    def __call__(
        self,
        args: Sequence[str],
        *,
        on_stdout_line: LineCallback | None = None,
        on_stderr_line: LineCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> subprocess.CompletedProcess[str]: ...


def stream_subprocess(
    args: Sequence[str],
    *,
    on_stdout_line: LineCallback | None = None,
    on_stderr_line: LineCallback | None = None,
    cancel: threading.Event | None = None,
    capture_stdout: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Runs `args` via `subprocess.Popen`, delivering lines as they arrive.

    Raises `FileNotFoundError` if the executable is missing and `CommandCancelledError` if
    `cancel` is set before or during execution. Keeps at most `_STDERR_TAIL_BYTES` of stderr.
    """
    if cancel is not None and cancel.is_set():
        raise CommandCancelledError("Command cancelled before start")

    proc = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None
    assert proc.stderr is not None

    stdout_chunks: list[str] = []
    stderr_tail = bytearray()
    stdout_buf = bytearray()
    stderr_buf = bytearray()

    def _emit_lines(buf: bytearray, callback: LineCallback | None, *, flush: bool = False) -> None:
        while True:
            nl = buf.find(b"\n")
            cr = buf.find(b"\r")
            if nl == -1 and cr == -1:
                break
            if nl == -1:
                idx = cr
                skip = 1
            elif cr == -1:
                idx = nl
                skip = 1
            elif cr < nl:
                idx = cr
                skip = 2 if nl == cr + 1 else 1
            else:
                idx = nl
                skip = 1
            raw_line = bytes(buf[:idx])
            del buf[: idx + skip]
            if callback is not None:
                callback(raw_line.decode("utf-8", errors="replace"))
        if flush and buf:
            raw_line = bytes(buf)
            buf.clear()
            if callback is not None:
                callback(raw_line.decode("utf-8", errors="replace"))

    sel = selectors.DefaultSelector()
    try:
        sel.register(proc.stdout, selectors.EVENT_READ, "stdout")
        sel.register(proc.stderr, selectors.EVENT_READ, "stderr")

        while sel.get_map():
            if cancel is not None and cancel.is_set():
                _terminate_process(proc)
                raise CommandCancelledError("Command cancelled")
            events = sel.select(timeout=_POLL_INTERVAL_S)
            for key, _mask in events:
                stream_name = key.data
                fd = key.fd
                chunk = os.read(fd, 4096)
                if not chunk:
                    sel.unregister(key.fileobj)
                    continue
                if stream_name == "stdout":
                    if capture_stdout:
                        stdout_chunks.append(chunk.decode("utf-8", errors="replace"))
                    if on_stdout_line is not None:
                        stdout_buf.extend(chunk)
                        _emit_lines(stdout_buf, on_stdout_line)
                else:
                    stderr_tail.extend(chunk)
                    if len(stderr_tail) > _STDERR_TAIL_BYTES:
                        del stderr_tail[:-_STDERR_TAIL_BYTES]
                    if on_stderr_line is not None:
                        stderr_buf.extend(chunk)
                        _emit_lines(stderr_buf, on_stderr_line)

        _emit_lines(stdout_buf, on_stdout_line, flush=True)
        _emit_lines(stderr_buf, on_stderr_line, flush=True)
    except BaseException:
        if proc.poll() is None:
            _terminate_process(proc)
        raise
    finally:
        sel.close()
        proc.stdout.close()
        proc.stderr.close()
        proc.wait()

    if cancel is not None and cancel.is_set():
        raise CommandCancelledError("Command cancelled")

    return subprocess.CompletedProcess(
        list(args),
        proc.returncode,
        stdout="".join(stdout_chunks),
        stderr=stderr_tail.decode("utf-8", errors="replace"),
    )


def _terminate_process(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=_TERMINATE_GRACE_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def as_stream_runner(
    run: CommandRunner | StreamRunner | None,
    default: StreamRunner,
) -> StreamRunner:
    """Adapts a 1-argument `CommandRunner` into a `StreamRunner`, or passes a `StreamRunner`
    through unchanged."""
    if run is None:
        return default
    try:
        params = inspect.signature(run).parameters
    except TypeError, ValueError:
        params = {}
    if "on_stdout_line" in params:
        return cast(StreamRunner, run)

    legacy_run: CommandRunner = run

    def adapted(
        args: Sequence[str],
        *,
        on_stdout_line: LineCallback | None = None,
        on_stderr_line: LineCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> subprocess.CompletedProcess[str]:
        if cancel is not None and cancel.is_set():
            raise CommandCancelledError("Command cancelled before start")
        result = legacy_run(args)
        if on_stdout_line is not None and result.stdout:
            for line in result.stdout.replace("\r\n", "\n").replace("\r", "\n").splitlines():
                on_stdout_line(line)
        if on_stderr_line is not None and result.stderr:
            for line in result.stderr.replace("\r\n", "\n").replace("\r", "\n").splitlines():
                on_stderr_line(line)
        if cancel is not None and cancel.is_set():
            raise CommandCancelledError("Command cancelled")
        return result

    return adapted
