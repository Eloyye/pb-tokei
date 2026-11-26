"""Background Player Tracking service and HTTP response models for `pb-tokei annotate`."""

from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from pb_tokei.calibration import CourtMapping
from pb_tokei.camera_motion import CameraMotionCache
from pb_tokei.player_tracking import (
    DEFAULT_DETECTION_STRIDE,
    PlayerTrackingCache,
    PlayerTrackingCancelledError,
    _prioritise_segments,
    sample_frames_for_segment,
)
from pb_tokei.player_vision import (
    DEFAULT_DETECTOR_MODEL_ID,
    DEFAULT_POSE_MODEL_ID,
    DeviceKind,
    DevicePreference,
    TorchVisionBackend,
    VisionBackend,
    select_device,
)
from pb_tokei.rally_log import (
    AnchorKind,
    Calibration,
    CameraView,
    Certainty,
    MatchId,
    MatchRoster,
    PlayerAnchor,
    PlayerId,
    PlaySegment,
    TeamEnd,
    TeamId,
    Zone,
)

MAX_PLAYER_FRAME_WINDOW = 2_000


class PlayerTrackingStatus(StrEnum):
    NO_VIDEO = "no_video"
    IDLE = "idle"
    TRACKING = "tracking"
    READY = "ready"
    ERROR = "error"


class PlayerAnchorIO(BaseModel):
    """One operator-placed Player anchor on a frame, in normalised image coordinates (0 to 1)."""

    frame: int = Field(ge=0)
    player_id: UUID
    kind: AnchorKind
    image_x: float = Field(ge=0, le=1)
    image_y: float = Field(ge=0, le=1)

    def to_domain(self) -> PlayerAnchor:
        return PlayerAnchor(
            frame=self.frame,
            player_id=PlayerId(self.player_id),
            kind=self.kind,
            image_x=self.image_x,
            image_y=self.image_y,
        )

    @classmethod
    def from_domain(cls, anchor: PlayerAnchor) -> PlayerAnchorIO:
        return PlayerAnchorIO(
            frame=anchor.frame,
            player_id=anchor.player_id,
            kind=anchor.kind,
            image_x=anchor.image_x,
            image_y=anchor.image_y,
        )


class TeamEndIO(BaseModel):
    """Which Team plays at the near end (y < 0, Main View camera end) from a frame onward."""

    effective_from_frame: int = Field(ge=0)
    near_team_id: UUID

    def to_domain(self) -> TeamEnd:
        return TeamEnd(
            effective_from_frame=self.effective_from_frame,
            near_team_id=TeamId(self.near_team_id),
        )

    @classmethod
    def from_domain(cls, team_end: TeamEnd) -> TeamEndIO:
        return TeamEndIO(
            effective_from_frame=team_end.effective_from_frame,
            near_team_id=team_end.near_team_id,
        )


class TrackPlayersIn(BaseModel):
    """Optional parameters for triggering background Player Tracking."""

    priority_frame: int | None = Field(default=None, ge=0)
    device: DevicePreference = "auto"
    wait: bool = False


class PlayerTrackingSpanOut(BaseModel):
    """Layer 1 tracking status for one Play Segment."""

    start_frame: int
    end_frame: int
    camera_view: CameraView
    tracked: bool
    status: Literal["pending", "tracking", "done"]


class PlayerTrackingOut(BaseModel):
    """Player Tracking status, progress %, active device badge, and per-segment spans."""

    status: PlayerTrackingStatus
    error: str | None
    device: DeviceKind | None
    progress: float
    tracked_segments: int
    total_segments: int
    spans: list[PlayerTrackingSpanOut]


class TrackedPlayerOut(BaseModel):
    """One Player's resolved court position, Zone, and Settled fact on one frame."""

    player_id: UUID
    position_x: float | None
    position_y: float | None
    position_certainty: Certainty
    zone: Zone | None
    settled: bool | None
    settled_certainty: Certainty
    image_x: float | None
    image_y: float | None
    bbox: list[float] | None
    anchor_kind: AnchorKind | None


class FrameDetectionOut(BaseModel):
    """One kept court-area person detection on a frame (for Monitor boxes and anchor clicks)."""

    x1: float
    y1: float
    x2: float
    y2: float
    foot_x: float
    foot_y: float
    score: float
    ankles_visible: bool
    feet_cropped: bool
    court_x: float | None
    court_y: float | None
    player_id: UUID | None


class PlayerTrackingFrameOut(BaseModel):
    """Resolved Player positions and visible detections for one frame."""

    frame: int
    near_team_id: UUID | None
    players: list[TrackedPlayerOut]
    detections: list[FrameDetectionOut]


class PlayerTrackingFramesOut(BaseModel):
    """Windowed per-frame detections and resolved Player positions, Zones, and Settled facts."""

    start_frame: int
    end_frame: int
    frames: list[PlayerTrackingFrameOut]


@dataclass
class _PlayerJobState:
    running: bool = False
    error: str | None = None
    device: DeviceKind | None = None
    progress: float = 0.0
    active_segment: tuple[int, int] | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)


class PlayerTrackingService:
    """Runs explicit background Player Tracking per Match without touching the Rally Log DB.

    Layer 1 GPU/MPS/CPU inference runs only when explicitly triggered (prioritising the Play
    Segment under the playhead first). Layer 2 court projection and piecewise identity solving run
    on demand from cached Layer 1 detections + current Calibrations, Camera Motion, anchors, and
    `team_ends`.
    """

    def __init__(
        self,
        cache_dir: Path,
        motion_cache: CameraMotionCache,
        *,
        backend_factory: Callable[[DevicePreference], VisionBackend] | None = None,
        stride: int = DEFAULT_DETECTION_STRIDE,
        detector_model: str | None = None,
        pose_model: str | None = None,
    ) -> None:
        self._cache = PlayerTrackingCache(
            cache_dir,
            stride=stride,
            detector_model=DEFAULT_DETECTOR_MODEL_ID if detector_model is None else detector_model,
            pose_model=DEFAULT_POSE_MODEL_ID if pose_model is None else pose_model,
        )
        self._motion_cache = motion_cache
        self._backend_factory = backend_factory
        self._lock = threading.Lock()
        # One inference job at a time to avoid GPU/MPS memory contention.
        self._slot = threading.Semaphore(1)
        self._jobs: dict[MatchId, _PlayerJobState] = {}
        self._backends: dict[DeviceKind, VisionBackend] = {}
        self._default_device: DeviceKind | None = None
        self._closed = False

    @property
    def cache(self) -> PlayerTrackingCache:
        return self._cache

    def close(self) -> None:
        """Cancels running jobs and prevents new ones when switching Rally Log or shutting down."""
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                job.cancel.set()

    def _detected_device(self) -> DeviceKind | None:
        if self._default_device is not None:
            return self._default_device
        if self._backend_factory is not None:
            try:
                backend = self._backend_factory("auto")
                self._default_device = backend.device
                return self._default_device
            except Exception:
                return None
        try:
            self._default_device = select_device("auto")
        except Exception:
            return None
        return self._default_device

    def _get_backend(self, preference: DevicePreference) -> VisionBackend:
        if self._backend_factory is not None:
            return self._backend_factory(preference)
        device = select_device(preference)
        with self._lock:
            existing = self._backends.get(device)
            if existing is not None:
                return existing
        backend = TorchVisionBackend(
            device=device.value,
            detector_model=self._cache.detector_model,
            pose_model=self._cache.pose_model,
        )
        with self._lock:
            self._backends[device] = backend
        return backend

    def status(
        self,
        match_id: MatchId,
        video_path: Path | None,
        segments: Sequence[PlaySegment],
    ) -> PlayerTrackingOut:
        ordered = sorted(segments, key=lambda s: s.start_frame)
        if video_path is None or not video_path.is_file():
            return PlayerTrackingOut(
                status=PlayerTrackingStatus.NO_VIDEO,
                error=None,
                device=self._detected_device(),
                progress=0.0,
                tracked_segments=0,
                total_segments=len(ordered),
                spans=[
                    PlayerTrackingSpanOut(
                        start_frame=s.start_frame,
                        end_frame=s.end_frame,
                        camera_view=s.camera_view,
                        tracked=False,
                        status="pending",
                    )
                    for s in ordered
                ],
            )

        with self._lock:
            job = self._jobs.get(match_id)
            running = bool(job is not None and job.running)
            job_error = None if job is None else job.error
            job_device = None if job is None else job.device
            job_progress = 0.0 if job is None else job.progress
            active_seg = None if job is None else job.active_segment

        spans: list[PlayerTrackingSpanOut] = []
        tracked_count = 0
        for seg in ordered:
            done = self._cache.has_layer1(video_path, seg)
            if done:
                tracked_count += 1
                seg_status: Literal["pending", "tracking", "done"] = "done"
            elif running and active_seg == (seg.start_frame, seg.end_frame):
                seg_status = "tracking"
            else:
                seg_status = "pending"
            spans.append(
                PlayerTrackingSpanOut(
                    start_frame=seg.start_frame,
                    end_frame=seg.end_frame,
                    camera_view=seg.camera_view,
                    tracked=done,
                    status=seg_status,
                )
            )

        total = len(ordered)
        if running:
            state = PlayerTrackingStatus.TRACKING
            error = None
            progress = job_progress
        elif job_error is not None and tracked_count < total:
            state = PlayerTrackingStatus.ERROR
            error = job_error
            progress = 100.0 * tracked_count / total if total > 0 else 0.0
        elif total > 0 and tracked_count == total:
            state = PlayerTrackingStatus.READY
            error = None
            progress = 100.0
        else:
            state = PlayerTrackingStatus.IDLE
            error = None
            progress = 100.0 * tracked_count / total if total > 0 else 0.0

        return PlayerTrackingOut(
            status=state,
            error=error,
            device=job_device or self._detected_device(),
            progress=round(progress, 1),
            tracked_segments=tracked_count,
            total_segments=total,
            spans=spans,
        )

    def trigger(
        self,
        match_id: MatchId,
        video_path: Path | None,
        segments: Sequence[PlaySegment],
        *,
        priority_frame: int | None = None,
        device: DevicePreference = "auto",
        wait: bool = False,
    ) -> PlayerTrackingOut:
        """Starts background Layer 1 inference for uncached segments, prioritising playhead."""
        ordered = sorted(segments, key=lambda s: s.start_frame)
        if video_path is None or not video_path.is_file() or not ordered:
            return self.status(match_id, video_path, ordered)

        prioritised = _prioritise_segments(ordered, priority_frame)
        missing = [seg for seg in prioritised if not self._cache.has_layer1(video_path, seg)]
        if not missing:
            return self.status(match_id, video_path, ordered)

        reused: _PlayerJobState | None = None
        started: _PlayerJobState | None = None
        with self._lock:
            existing = self._jobs.get(match_id)
            if existing is not None and existing.running:
                reused = existing
            elif not self._closed:
                started = _PlayerJobState(running=True)
                self._jobs[match_id] = started

        if reused is not None:
            if wait:
                reused.done.wait()
            return self.status(match_id, video_path, ordered)

        if started is None:
            return self.status(match_id, video_path, ordered)

        if wait:
            self._run_job(match_id, started, video_path, tuple(prioritised), device)
            return self.status(match_id, video_path, ordered)

        thread = threading.Thread(
            target=self._run_job,
            args=(match_id, started, video_path, tuple(prioritised), device),
            daemon=True,
        )
        thread.start()
        return self.status(match_id, video_path, ordered)

    def cancel(
        self,
        match_id: MatchId,
        video_path: Path | None,
        segments: Sequence[PlaySegment],
    ) -> PlayerTrackingOut:
        """Cancels an active Player Tracking job for `match_id`."""
        with self._lock:
            job = self._jobs.get(match_id)
            if job is not None and job.running:
                job.cancel.set()
        if job is not None:
            job.done.wait(timeout=2.0)
        return self.status(match_id, video_path, segments)

    def _run_job(
        self,
        match_id: MatchId,
        state: _PlayerJobState,
        video_path: Path,
        prioritised_segments: tuple[PlaySegment, ...],
        device: DevicePreference,
    ) -> None:
        error: str | None = None
        try:
            with self._slot:
                if state.cancel.is_set():
                    return
                backend = self._get_backend(device)
                with self._lock:
                    state.device = backend.device
                    self._default_device = backend.device

                total_samples = sum(
                    len(sample_frames_for_segment(s.start_frame, s.end_frame, self._cache.stride))
                    for s in prioritised_segments
                )
                completed = 0
                for seg in prioritised_segments:
                    if state.cancel.is_set():
                        return
                    seg_samples = len(
                        sample_frames_for_segment(
                            seg.start_frame, seg.end_frame, self._cache.stride
                        )
                    )
                    if self._cache.has_layer1(video_path, seg):
                        completed += seg_samples
                        with self._lock:
                            state.progress = (
                                100.0 * completed / total_samples if total_samples > 0 else 100.0
                            )
                        continue
                    with self._lock:
                        state.active_segment = (seg.start_frame, seg.end_frame)

                    def on_progress(
                        done_in_seg: int,
                        _seg_total: int,
                        _base: int = completed,
                        _total: int = total_samples,
                    ) -> None:
                        pct = 100.0 * min(_total, _base + done_in_seg) / max(1, _total)
                        with self._lock:
                            state.progress = pct

                    self._cache.get_or_extract_layer1(
                        video_path,
                        seg,
                        backend,
                        on_progress=on_progress,
                        cancel=state.cancel,
                    )
                    completed += seg_samples
                    with self._lock:
                        state.progress = (
                            100.0 * completed / total_samples if total_samples > 0 else 100.0
                        )
        except PlayerTrackingCancelledError:
            pass
        except Exception as exc:
            error = str(exc)
        finally:
            with self._lock:
                state.running = False
                state.active_segment = None
                if self._jobs.get(match_id) is state:
                    state.error = error
                state.done.set()

    def frames(
        self,
        video_path: Path | None,
        roster: MatchRoster,
        segments: Sequence[PlaySegment],
        calibrations: Sequence[Calibration],
        player_anchors: Sequence[PlayerAnchor],
        team_ends: Sequence[TeamEnd],
        start_frame: int,
        end_frame: int,
    ) -> PlayerTrackingFramesOut:
        """Solves (or loads cached) Layer 2 tracking for frames `[start_frame, end_frame]`."""
        if start_frame < 0 or end_frame < start_frame:
            raise ValueError(f"Invalid frame range: {start_frame}-{end_frame}")
        if end_frame - start_frame + 1 > MAX_PLAYER_FRAME_WINDOW:
            raise ValueError(f"Frame window exceeds limit of {MAX_PLAYER_FRAME_WINDOW} frames")

        reg_map = (
            self._motion_cache.landmark_frame_to_ref(video_path, segments, calibrations)
            if video_path is not None and video_path.is_file()
            else {}
        )
        motion = (
            self._motion_cache.load_cached(video_path, segments, calibrations)[0]
            if video_path is not None and video_path.is_file()
            else None
        )
        mapping = CourtMapping(
            segments, calibrations, camera_motion=motion, landmark_frame_to_ref=reg_map
        )
        tracking = self._cache.load_or_solve(
            video_path=video_path,
            roster=roster,
            segments=segments,
            calibrations=calibrations,
            court_mapping=mapping,
            camera_motion=motion,
            player_anchors=player_anchors,
            team_ends=team_ends,
        )

        frames_out: list[PlayerTrackingFrameOut] = []
        for f in range(start_frame, end_frame + 1):
            fs = tracking.frame_state(f)
            players_out = [
                TrackedPlayerOut(
                    player_id=p.id,
                    position_x=None if st.position.value is None else st.position.value.x,
                    position_y=None if st.position.value is None else st.position.value.y,
                    position_certainty=st.position.certainty,
                    zone=st.zone,
                    settled=st.settled.value,
                    settled_certainty=st.settled.certainty,
                    image_x=None if st.image_point is None else st.image_point.x,
                    image_y=None if st.image_point is None else st.image_point.y,
                    bbox=None if st.bbox is None else list(st.bbox),
                    anchor_kind=st.anchor_kind,
                )
                for p in roster.players
                for st in (fs.players[p.id],)
            ]
            dets_out = [
                FrameDetectionOut(
                    x1=d.x1,
                    y1=d.y1,
                    x2=d.x2,
                    y2=d.y2,
                    foot_x=d.foot_x,
                    foot_y=d.foot_y,
                    score=d.score,
                    ankles_visible=d.ankles_visible,
                    feet_cropped=d.feet_cropped,
                    court_x=d.court_x,
                    court_y=d.court_y,
                    player_id=d.player_id,
                )
                for d in fs.detections
            ]
            frames_out.append(
                PlayerTrackingFrameOut(
                    frame=f,
                    near_team_id=fs.near_team_id,
                    players=players_out,
                    detections=dets_out,
                )
            )
        return PlayerTrackingFramesOut(
            start_frame=start_frame,
            end_frame=end_frame,
            frames=frames_out,
        )
