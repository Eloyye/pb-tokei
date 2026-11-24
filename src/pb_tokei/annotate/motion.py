"""Background Camera Motion tracking service and HTTP response models for `pb-tokei annotate`."""

from __future__ import annotations

import hashlib
import json
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel

from pb_tokei.calibration import CourtMapping, Matrix, assess
from pb_tokei.camera_motion import (
    CameraMotionCache,
    FrameRange,
    TrackingCancelledError,
    calibration_spans,
)
from pb_tokei.rally_log import Calibration, CameraView, MatchId, PlaySegment

MAX_FRAME_WINDOW = 10_000
MAX_CONCURRENT_JOBS = 2


class CameraMotionStatus(StrEnum):
    NO_VIDEO = "no_video"
    IDLE = "idle"
    TRACKING = "tracking"
    READY = "ready"
    ERROR = "error"


class UnmappedRangeOut(BaseModel):
    """An inclusive stretch of frames in a Play Segment that could not be registered."""

    start_frame: int
    end_frame: int
    camera_view: CameraView

    @classmethod
    def from_domain(cls, frame_range: FrameRange) -> UnmappedRangeOut:
        return UnmappedRangeOut(
            start_frame=frame_range.start_frame,
            end_frame=frame_range.end_frame,
            camera_view=frame_range.camera_view,
        )


class CameraMotionSpanOut(BaseModel):
    """Tracking summary for one Calibration span inside a Play Segment."""

    start_frame: int
    end_frame: int
    camera_view: CameraView
    calibration_effective_from: int
    calibration_reference_frame: int
    tracked: bool
    mapped_frames: int
    unmapped_frames: int
    unmapped_ranges: list[UnmappedRangeOut]


class CameraMotionOut(BaseModel):
    """Camera Motion tracking status and unmapped ranges across a Match."""

    status: CameraMotionStatus
    error: str | None
    tracked_spans: int
    total_spans: int
    unmapped_ranges: list[UnmappedRangeOut]
    spans: list[CameraMotionSpanOut]


class CameraMotionFramesOut(BaseModel):
    """Per-frame court-to-image matrices across an inclusive frame window.

    Entry `i` corresponds to `start_frame + i`: `court_to_image[i]` is the 3×3 matrix when mapped,
    or null otherwise; `unmapped[i]` is True specifically when the frame is inside a tracked Play
    Segment span whose registration failed (so its positions are Unknown).
    """

    start_frame: int
    end_frame: int
    court_to_image: list[list[list[float]] | None]
    unmapped: list[bool]


@dataclass
class _JobState:
    signature: str
    running: bool = False
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)


class CameraMotionService:
    """Tracks and caches Camera Motion per Match without touching the Rally Log database."""

    def __init__(self, cache_dir: Path, *, max_concurrent: int = MAX_CONCURRENT_JOBS) -> None:
        self._cache = CameraMotionCache(cache_dir)
        self._lock = threading.Lock()
        self._slots = threading.Semaphore(max(1, max_concurrent))
        self._jobs: dict[MatchId, _JobState] = {}

    @property
    def cache(self) -> CameraMotionCache:
        return self._cache

    def status(
        self,
        match_id: MatchId,
        video_path: Path | None,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
    ) -> CameraMotionOut:
        if video_path is None or not video_path.is_file():
            return CameraMotionOut(
                status=CameraMotionStatus.NO_VIDEO,
                error=None,
                tracked_spans=0,
                total_spans=0,
                unmapped_ranges=[],
                spans=[],
            )
        sig = _match_signature(video_path, segments, calibrations)
        reg_map = self._cache.landmark_frame_to_ref(video_path, segments, calibrations)
        cached, missing = self._cache.load_cached(video_path, segments, calibrations)
        cached_by_bounds = {(s.start_frame, s.end_frame): s for s in cached.spans}

        span_outs: list[CameraMotionSpanOut] = []
        all_unmapped: list[UnmappedRangeOut] = []
        for span in calibration_spans(segments, calibrations):
            cal = span.calibration
            cal_f2r = reg_map.get((cal.camera_view, cal.effective_from_frame))
            if assess(cal, frame_to_ref=cal_f2r).homography is None:
                continue
            hit = cached_by_bounds.get((span.start_frame, span.end_frame))
            if hit is not None:
                ranges = [UnmappedRangeOut.from_domain(r) for r in hit.unmapped_ranges()]
                all_unmapped.extend(ranges)
                span_outs.append(
                    CameraMotionSpanOut(
                        start_frame=span.start_frame,
                        end_frame=span.end_frame,
                        camera_view=span.camera_view,
                        calibration_effective_from=span.calibration.effective_from_frame,
                        calibration_reference_frame=span.calibration.reference_frame,
                        tracked=True,
                        mapped_frames=hit.mapped_count,
                        unmapped_frames=hit.unmapped_count,
                        unmapped_ranges=ranges,
                    )
                )
            else:
                span_outs.append(
                    CameraMotionSpanOut(
                        start_frame=span.start_frame,
                        end_frame=span.end_frame,
                        camera_view=span.camera_view,
                        calibration_effective_from=span.calibration.effective_from_frame,
                        calibration_reference_frame=span.calibration.reference_frame,
                        tracked=False,
                        mapped_frames=0,
                        unmapped_frames=0,
                        unmapped_ranges=[],
                    )
                )

        with self._lock:
            job = self._jobs.get(match_id)
            same_sig = job is not None and job.signature == sig
            running = same_sig and job.running
            job_error = job.error if same_sig else None

        if running:
            state = CameraMotionStatus.TRACKING
            error = None
        elif job_error is not None and missing:
            state = CameraMotionStatus.ERROR
            error = job_error
        elif missing:
            state = CameraMotionStatus.IDLE
            error = None
        else:
            state = CameraMotionStatus.READY
            error = None

        return CameraMotionOut(
            status=state,
            error=error,
            tracked_spans=len(cached.spans),
            total_spans=len(span_outs),
            unmapped_ranges=all_unmapped,
            spans=span_outs,
        )

    def trigger(
        self,
        match_id: MatchId,
        video_path: Path | None,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        *,
        wait: bool = False,
    ) -> CameraMotionOut:
        if video_path is None or not video_path.is_file():
            return self.status(match_id, video_path, segments, calibrations)

        sig = _match_signature(video_path, segments, calibrations)
        _cached, missing = self._cache.load_cached(video_path, segments, calibrations)
        if not missing:
            return self.status(match_id, video_path, segments, calibrations)

        seg_snapshot = tuple(segments)
        cal_snapshot = tuple(calibrations)

        reused: _JobState | None = None
        started: _JobState | None = None
        with self._lock:
            existing = self._jobs.get(match_id)
            if existing is not None and existing.running and existing.signature == sig:
                reused = existing
            else:
                if existing is not None and existing.running:
                    existing.cancel.set()
                started = _JobState(signature=sig, running=True)
                self._jobs[match_id] = started

        if reused is not None:
            if wait:
                reused.done.wait()
            return self.status(match_id, video_path, seg_snapshot, cal_snapshot)

        assert started is not None
        if wait:
            self._run_job(match_id, started, video_path, seg_snapshot, cal_snapshot)
            return self.status(match_id, video_path, seg_snapshot, cal_snapshot)

        thread = threading.Thread(
            target=self._run_job,
            args=(match_id, started, video_path, seg_snapshot, cal_snapshot),
            daemon=True,
        )
        thread.start()
        return self.status(match_id, video_path, seg_snapshot, cal_snapshot)

    def _run_job(
        self,
        match_id: MatchId,
        state: _JobState,
        video_path: Path,
        segments: tuple[PlaySegment, ...],
        calibrations: tuple[Calibration, ...],
    ) -> None:
        error: str | None = None
        try:
            with self._slots:
                if not state.cancel.is_set():
                    self._cache.track_match(video_path, segments, calibrations, cancel=state.cancel)
        except TrackingCancelledError:
            pass
        except Exception as exc:
            error = str(exc)
        finally:
            with self._lock:
                state.running = False
                if self._jobs.get(match_id) is state:
                    state.error = error
                state.done.set()

    def frames(
        self,
        video_path: Path | None,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        start_frame: int,
        end_frame: int,
    ) -> CameraMotionFramesOut:
        if start_frame < 0 or end_frame < start_frame:
            raise ValueError(f"Invalid frame range: {start_frame}-{end_frame}")
        if end_frame - start_frame + 1 > MAX_FRAME_WINDOW:
            raise ValueError(f"Frame window exceeds limit of {MAX_FRAME_WINDOW} frames")

        count = end_frame - start_frame + 1
        if video_path is None or not video_path.is_file():
            return CameraMotionFramesOut(
                start_frame=start_frame,
                end_frame=end_frame,
                court_to_image=[None] * count,
                unmapped=[False] * count,
            )

        reg_map = self._cache.landmark_frame_to_ref(video_path, segments, calibrations)
        cached, _ = self._cache.load_cached(video_path, segments, calibrations)
        mapping = CourtMapping(
            segments, calibrations, camera_motion=cached, landmark_frame_to_ref=reg_map
        )
        matrices: list[list[list[float]] | None] = []
        unmapped: list[bool] = []
        for frame in range(start_frame, end_frame + 1):
            if not cached.covers(frame):
                matrices.append(None)
                unmapped.append(False)
                continue
            homography = mapping.at(frame)
            if homography is None:
                matrices.append(None)
                unmapped.append(True)
            else:
                matrices.append(_rows(homography.court_to_image))
                unmapped.append(False)

        return CameraMotionFramesOut(
            start_frame=start_frame,
            end_frame=end_frame,
            court_to_image=matrices,
            unmapped=unmapped,
        )


def _match_signature(
    video_path: Path,
    segments: Sequence[PlaySegment],
    calibrations: Sequence[Calibration],
) -> str:
    payload = {
        "video": str(video_path),
        "segments": [(s.start_frame, s.end_frame, s.camera_view.value) for s in segments],
        "calibrations": [
            (
                c.camera_view.value,
                c.effective_from_frame,
                c.reference_frame,
                [
                    (lm.value, c.landmarks[lm].x, c.landmarks[lm].y, c.landmarks[lm].frame)
                    for lm in sorted(c.landmarks)
                ],
            )
            for c in calibrations
        ],
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _rows(matrix: Matrix) -> list[list[float]]:
    return [[float(v) for v in row] for row in matrix]
