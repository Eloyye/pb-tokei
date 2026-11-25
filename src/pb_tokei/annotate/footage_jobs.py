"""Background footage download and conversion service for `pb-tokei annotate`.

Runs one footage job at a time across all Matches in a FIFO queue, calling `pb_tokei.footage`
and `pb_tokei.convert` directly so the app and CLI stay on the same code path (ADR 0009).
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path

import duckdb
from pydantic import BaseModel

from pb_tokei.convert import ConvertProgress, FootageConversionError, convert_footage
from pb_tokei.footage import (
    DEFAULT_FOOTAGE_DIR,
    CommandCancelledError,
    CommandRunner,
    DownloadProgress,
    FootageDownloadError,
    StreamRunner,
    download_footage,
)
from pb_tokei.rally_log import MatchId, RallyLog, SourceVideo, stored_video_path
from pb_tokei.state import read_cookies_from_browser

_DB_RETRY_DELAYS_S = (0.05, 0.1, 0.25, 0.5, 1.0)


class FootageJobState(StrEnum):
    IDLE = "idle"
    QUEUED = "queued"
    DOWNLOADING = "downloading"
    CONVERTING = "converting"
    ERROR = "error"


class FootageJobSummaryOut(BaseModel):
    """Short footage job summary attached to each row in the Match list."""

    state: FootageJobState
    queue_position: int | None
    percent: float | None


class FootageJobOut(BaseModel):
    """Full footage job state for one Match, plus the remembered browser cookie setting."""

    state: FootageJobState
    queue_position: int | None
    percent: float | None
    speed: str | None
    eta: str | None
    error: str | None
    hint: str | None
    stderr_tail: str | None
    cookies_from_browser: str | None
    requested_url: str | None = None


class FetchFootageIn(BaseModel):
    """Parameters to start fetching or converting footage for a Match."""

    url: str | None = None
    cookies_from_browser: str | None = None


class FootageJobConflictError(RuntimeError):
    """Raised when a different footage job is already active or queued for a Match."""


def footage_error_hint(error: str) -> str | None:
    """Returns a user-facing remediation hint for known download/conversion failures."""
    lower = error.lower()
    if "sign in to confirm" in lower or "--cookies-from-browser" in lower:
        return (
            'Choose a browser under "Cookies from" '
            "(and make sure you are signed in in that browser)."
        )
    if "yt-dlp is not installed" in lower:
        return (
            "Install yt-dlp (https://github.com/yt-dlp/yt-dlp#installation) "
            "and ensure it is on PATH."
        )
    if "ffmpeg is not installed" in lower or "ffprobe is not installed" in lower:
        return "Install ffmpeg (https://ffmpeg.org/download.html) and ensure it is on PATH."
    if "multiple videos" in lower:
        return "Paste a single video URL."
    if "multiple source videos share output name" in lower:
        return None
    if any(
        token in lower
        for token in (
            "unsupported url",
            "http error 403",
            "403: forbidden",
            "video unavailable",
            "unable to extract",
            "extractor error",
        )
    ):
        return "Update yt-dlp (brew upgrade yt-dlp or yt-dlp -U) and try again."
    return None


@dataclass
class _FootageJob:
    match_id: MatchId
    url: str | None
    convert_source: Path | None
    cookies_from_browser: str | None
    state: FootageJobState = FootageJobState.QUEUED
    percent: float | None = None
    speed: str | None = None
    eta: str | None = None
    error: str | None = None
    hint: str | None = None
    stderr_tail: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)


class FootageJobService:
    """In-memory FIFO queue of footage download/conversion jobs for one open Rally Log."""

    def __init__(
        self,
        db_file: Path,
        *,
        runner: CommandRunner | StreamRunner | None = None,
    ) -> None:
        self._db_file = db_file
        self._footage_dir = db_file.parent / DEFAULT_FOOTAGE_DIR
        self._runner = runner
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._queue: deque[_FootageJob] = deque()
        self._active: _FootageJob | None = None
        self._jobs: dict[MatchId, _FootageJob] = {}
        self._closed = False
        self._worker: threading.Thread | None = None

    def close(self, *, timeout: float = 5.0) -> None:
        """Cancels every queued and running job and waits for the worker to clean up."""
        with self._cond:
            self._closed = True
            for job in self._queue:
                job.cancel.set()
                job.done.set()
                if self._jobs.get(job.match_id) is job:
                    self._jobs.pop(job.match_id, None)
            self._queue.clear()
            if self._active is not None:
                self._active.cancel.set()
            worker = self._worker
            self._cond.notify_all()
        if worker is not None and worker is not threading.current_thread():
            worker.join(timeout=timeout)

    def summary(
        self, match_id: MatchId, *, ready_url: str | None = None
    ) -> FootageJobSummaryOut | None:
        with self._lock:
            job = self._jobs.get(match_id)
            if job is None or job.state is FootageJobState.IDLE:
                return None
            if _error_superseded_by_ready(job, ready_url):
                return None
            return FootageJobSummaryOut(
                state=job.state,
                queue_position=self._queue_position_locked(job),
                percent=job.percent,
            )

    def status(self, match_id: MatchId, *, ready_url: str | None = None) -> FootageJobOut:
        cookies = read_cookies_from_browser()
        with self._lock:
            job = self._jobs.get(match_id)
            if job is None or _error_superseded_by_ready(job, ready_url):
                return _idle_out(cookies)
            return self._to_out_locked(job, cookies)

    def enqueue(
        self,
        match_id: MatchId,
        *,
        url: str | None = None,
        convert_source: Path | None = None,
        cookies_from_browser: str | None = None,
    ) -> FootageJobOut:
        """Queues a download+convert or convert-only job for `match_id`."""
        if url is None and convert_source is None:
            raise ValueError("Either url or convert_source must be provided")
        cookies_remembered = read_cookies_from_browser()
        with self._cond:
            if self._closed:
                raise FootageJobConflictError("Rally Log changed; reload and try again")
            existing = self._jobs.get(match_id)
            if existing is not None and existing.state in {
                FootageJobState.QUEUED,
                FootageJobState.DOWNLOADING,
                FootageJobState.CONVERTING,
            }:
                if (
                    existing.url == url
                    and existing.convert_source == convert_source
                    and existing.cookies_from_browser == cookies_from_browser
                ):
                    return self._to_out_locked(existing, cookies_remembered)
                raise FootageJobConflictError(
                    "A footage job is already queued or running for this Match"
                )

            job = _FootageJob(
                match_id=match_id,
                url=url,
                convert_source=convert_source,
                cookies_from_browser=cookies_from_browser,
            )
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._worker_loop, daemon=True)
                self._worker.start()
            self._jobs[match_id] = job
            self._queue.append(job)
            self._cond.notify()
            return self._to_out_locked(job, cookies_remembered)

    def record_enqueue_error(self, match_id: MatchId, url: str, message: str) -> None:
        """Shows a fetch setup failure for a newly created Match in its footage panel."""
        with self._lock:
            self._jobs.setdefault(
                match_id,
                _FootageJob(
                    match_id=match_id,
                    url=url,
                    convert_source=None,
                    cookies_from_browser=None,
                    state=FootageJobState.ERROR,
                    error=message,
                    hint=footage_error_hint(message),
                ),
            )

    def cancel(self, match_id: MatchId) -> FootageJobOut:
        """Cancels a running job, removes a queued one, or clears a previous error."""
        with self._cond:
            job = self._jobs.get(match_id)
            if job is not None:
                job.cancel.set()
                try:
                    self._queue.remove(job)
                    job.done.set()
                except ValueError:
                    pass
                self._jobs.pop(match_id, None)
        return _idle_out(read_cookies_from_browser())

    def wait_for(self, match_id: MatchId, *, timeout: float = 5.0) -> bool:
        """Waits until the current job for `match_id` finishes (used by tests)."""
        with self._lock:
            job = self._jobs.get(match_id)
            if job is None and self._active is not None and self._active.match_id == match_id:
                job = self._active
        if job is None:
            return True
        return job.done.wait(timeout=timeout)

    def _queue_position_locked(self, job: _FootageJob) -> int | None:
        if job.state is not FootageJobState.QUEUED:
            return None
        try:
            return list(self._queue).index(job) + 1
        except ValueError:
            return None

    def _to_out_locked(self, job: _FootageJob, cookies: str | None) -> FootageJobOut:
        return FootageJobOut(
            state=job.state,
            queue_position=self._queue_position_locked(job),
            percent=job.percent,
            speed=job.speed,
            eta=job.eta,
            error=job.error,
            hint=job.hint,
            stderr_tail=job.stderr_tail,
            cookies_from_browser=cookies,
            requested_url=job.url,
        )

    def _worker_loop(self) -> None:
        while True:
            with self._cond:
                while not self._closed and not self._queue:
                    self._cond.wait()
                if self._closed:
                    return
                job = self._queue.popleft()
                if job.cancel.is_set():
                    job.done.set()
                    continue
                self._active = job
                job.state = (
                    FootageJobState.CONVERTING
                    if job.convert_source is not None
                    else FootageJobState.DOWNLOADING
                )
                job.percent = None
                job.speed = None
                job.eta = None
                job.error = None
                job.hint = None
                job.stderr_tail = None
            try:
                self._run_job(job)
            finally:
                with self._cond:
                    if self._active is job:
                        self._active = None
                    job.done.set()

    def _run_job(self, job: _FootageJob) -> None:
        try:
            source_path = job.convert_source
            if source_path is None:
                assert job.url is not None

                def on_download_progress(progress: DownloadProgress) -> None:
                    with self._lock:
                        if job.cancel.is_set() or self._jobs.get(job.match_id) is not job:
                            return
                        if progress.percent is not None:
                            job.percent = progress.percent
                        if progress.speed is not None:
                            job.speed = progress.speed
                        if progress.eta is not None:
                            job.eta = progress.eta

                dl_result = download_footage(
                    job.url,
                    self._footage_dir,
                    cookies_from_browser=job.cookies_from_browser,
                    run=self._runner,
                    on_progress=on_download_progress,
                    cancel=job.cancel,
                )
                if job.cancel.is_set() or self._closed:
                    raise CommandCancelledError("Footage job cancelled")

                # Record SourceVideo as soon as download finishes, before conversion, so a failed
                # conversion leaves a Match that only needs converting.
                recorded = replace(
                    dl_result.source_video,
                    path=stored_video_path(dl_result.source_video.path, self._db_file),
                )
                self._record_source_video(job, recorded)
                source_path = dl_result.source_video.path

            if job.cancel.is_set() or self._closed:
                raise CommandCancelledError("Footage job cancelled")

            with self._lock:
                if job.cancel.is_set() or self._jobs.get(job.match_id) is not job:
                    raise CommandCancelledError("Footage job cancelled")
                job.state = FootageJobState.CONVERTING
                job.percent = None
                job.speed = None
                job.eta = None

            def on_convert_progress(progress: ConvertProgress) -> None:
                with self._lock:
                    if job.cancel.is_set() or self._jobs.get(job.match_id) is not job:
                        return
                    if progress.percent is not None:
                        job.percent = progress.percent

            convert_footage(
                source_path,
                run=self._runner,
                on_progress=on_convert_progress,
                cancel=job.cancel,
            )
            if job.cancel.is_set() or self._closed:
                raise CommandCancelledError("Footage job cancelled")

            with self._lock:
                if self._jobs.get(job.match_id) is job:
                    self._jobs.pop(job.match_id, None)
        except CommandCancelledError:
            with self._lock:
                if self._jobs.get(job.match_id) is job:
                    self._jobs.pop(job.match_id, None)
        except (FootageDownloadError, FootageConversionError) as exc:
            self._record_error(job, str(exc), stderr_tail=exc.stderr_tail)
        except Exception as exc:
            self._record_error(job, str(exc), stderr_tail=None)

    def _record_source_video(self, job: _FootageJob, source_video: SourceVideo) -> None:
        last_exc: duckdb.Error | None = None
        for attempt in range(len(_DB_RETRY_DELAYS_S) + 1):
            if job.cancel.is_set() or self._closed:
                raise CommandCancelledError("Footage job cancelled")
            try:
                with RallyLog.open(self._db_file) as log:
                    log.set_match_source_video(job.match_id, source_video)
                return
            except duckdb.Error as exc:
                last_exc = exc
                if attempt < len(_DB_RETRY_DELAYS_S):
                    time.sleep(_DB_RETRY_DELAYS_S[attempt])
        assert last_exc is not None
        raise last_exc

    def _record_error(self, job: _FootageJob, message: str, *, stderr_tail: str | None) -> None:
        with self._lock:
            if job.cancel.is_set() or self._jobs.get(job.match_id) is not job:
                return
            job.state = FootageJobState.ERROR
            job.error = message
            job.hint = footage_error_hint(message)
            job.stderr_tail = stderr_tail
            job.percent = None
            job.speed = None
            job.eta = None


def _error_superseded_by_ready(job: _FootageJob, ready_url: str | None) -> bool:
    """True when a failed job's target video is now ready on disk (e.g. converted via CLI or
    another Match sharing the broadcast), but False if the job failed fetching a different URL."""
    if job.state is not FootageJobState.ERROR or ready_url is None:
        return False
    return job.url is None or job.url == ready_url


def _idle_out(cookies: str | None) -> FootageJobOut:
    return FootageJobOut(
        state=FootageJobState.IDLE,
        queue_position=None,
        percent=None,
        speed=None,
        eta=None,
        error=None,
        hint=None,
        stderr_tail=None,
        cookies_from_browser=cookies,
    )
