"""The annotation web app's HTTP API, and the built front end served from the same origin.

The Rally Log is opened afresh for each request and closed straight after, before any video
streams, so the CLI (`match add`, `download --match`) can still write to the DuckDB file while the
app runs.
"""

from __future__ import annotations

import math
import shlex
from collections.abc import Callable
from enum import StrEnum
from pathlib import Path
from uuid import UUID

import duckdb
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from pb_tokei.annotate.motion import (
    CameraMotionFramesOut,
    CameraMotionOut,
    CameraMotionService,
)
from pb_tokei.calibration import Matrix, assess
from pb_tokei.camera_motion import default_cache_dir
from pb_tokei.convert import FootageConversionError, converted_path_for
from pb_tokei.rally_log import (
    Calibration,
    CameraView,
    ImagePoint,
    Landmark,
    MatchId,
    MatchNotFound,
    MatchSummary,
    PlaySegment,
    RallyLog,
    SourceVideo,
    resolve_video_path,
)

STATIC_DIR = Path(__file__).parent / "static"

# The server binds 127.0.0.1 only. Checking the Host header as well stops DNS rebinding: a page
# whose domain re-resolves to 127.0.0.1 would otherwise be same-origin with the app.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")


class VideoStatus(StrEnum):
    NONE = "none"
    NOT_CONVERTED = "not_converted"
    READY = "ready"


class RallyLogOut(BaseModel):
    """The Rally Log file the annotation app is serving."""

    path: str


class MatchOut(BaseModel):
    """A Match's roster by name and whether its 60 fps video can be played."""

    id: UUID
    tournament: str
    team_a: tuple[str, str]
    team_b: tuple[str, str]
    franchise_a: str | None
    franchise_b: str | None
    video_status: VideoStatus

    @classmethod
    def from_summary(cls, summary: MatchSummary, video_status: VideoStatus) -> MatchOut:
        return MatchOut(
            id=summary.id,
            tournament=summary.tournament,
            team_a=summary.team_a,
            team_b=summary.team_b,
            franchise_a=summary.franchise_a,
            franchise_b=summary.franchise_b,
            video_status=video_status,
        )


class MatchDetailOut(MatchOut):
    """A Match, plus the CLI command that makes its video playable when it isn't yet."""

    fix_command: str | None

    @classmethod
    def from_match(cls, match: MatchOut, fix_command: str | None) -> MatchDetailOut:
        return MatchDetailOut(**match.model_dump(), fix_command=fix_command)


class PlaySegmentIO(BaseModel):
    """Live play from one Camera View, from `start_frame` to `end_frame` inclusive."""

    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=0)
    camera_view: CameraView

    def to_domain(self) -> PlaySegment:
        return PlaySegment(self.start_frame, self.end_frame, self.camera_view)

    @classmethod
    def from_domain(cls, segment: PlaySegment) -> PlaySegmentIO:
        return PlaySegmentIO(
            start_frame=segment.start_frame,
            end_frame=segment.end_frame,
            camera_view=segment.camera_view,
        )


class ImagePointIO(BaseModel):
    """A point in the video frame, from 0 to 1 across (left to right) and down (top to bottom)."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)


class CalibrationIn(BaseModel):
    """One Calibration's clicked Landmarks; its Camera View is given by the URL."""

    effective_from_frame: int = Field(ge=0)
    reference_frame: int = Field(ge=0)
    landmarks: dict[Landmark, ImagePointIO]

    def to_domain(self, camera_view: CameraView) -> Calibration:
        return Calibration(
            camera_view,
            self.effective_from_frame,
            self.reference_frame,
            {lm: ImagePoint(p.x, p.y) for lm, p in self.landmarks.items()},
        )


class LandmarkErrorOut(BaseModel):
    """How far off the fit puts a Landmark, in feet: with it, and refitted without it.

    JSON has no infinity, so an error that puts the click off the court (above the horizon) is
    null with `off_court` true. `leave_one_out_ft` is also null, with `off_court` false, when the
    other Landmarks can't be fitted without this one.
    """

    residual_ft: float | None
    leave_one_out_ft: float | None
    off_court: bool
    # Whether the error is big enough to flag: over `ERROR_WARNING_FT`, or off the court.
    needs_attention: bool


class CalibrationOut(CalibrationIn):
    """A Calibration with its fit. The matrices are None while it is incomplete."""

    camera_view: CameraView
    complete: bool
    image_to_court: list[list[float]] | None
    court_to_image: list[list[float]] | None
    errors: dict[Landmark, LandmarkErrorOut]
    # Null with no fit, or when some click is off the court (that Landmark's `off_court` says so).
    worst_error_ft: float | None
    needs_attention: bool

    @classmethod
    def from_domain(cls, calibration: Calibration) -> CalibrationOut:
        fit = assess(calibration)
        homography = fit.homography
        return CalibrationOut(
            camera_view=calibration.camera_view,
            effective_from_frame=calibration.effective_from_frame,
            reference_frame=calibration.reference_frame,
            landmarks={lm: ImagePointIO(x=p.x, y=p.y) for lm, p in calibration.landmarks.items()},
            complete=fit.complete,
            image_to_court=None if homography is None else _rows(homography.image_to_court),
            court_to_image=None if homography is None else _rows(homography.court_to_image),
            errors={
                lm: LandmarkErrorOut(
                    residual_ft=_finite(e.residual_ft),
                    leave_one_out_ft=_finite(e.leave_one_out_ft),
                    off_court=e.off_court,
                    needs_attention=e.needs_attention,
                )
                for lm, e in fit.errors.items()
            },
            worst_error_ft=_finite(fit.worst_error_ft),
            needs_attention=fit.needs_attention,
        )


def _finite(feet: float | None) -> float | None:
    return None if feet is None or math.isinf(feet) else feet


def _rows(matrix: Matrix) -> list[list[float]]:
    return [[float(v) for v in row] for row in matrix]


class _VideoState:
    """Where a Match's video stands on disk, resolved against the Rally Log's directory."""

    def __init__(self, source_video: SourceVideo | None, db_file: Path) -> None:
        self.source_video = source_video
        self.source_path: Path | None = None
        self.converted_path: Path | None = None
        if source_video is None:
            self.status = VideoStatus.NONE
            return
        self.source_path = resolve_video_path(source_video.path, db_file)
        try:
            self.converted_path = converted_path_for(self.source_path)
        except FootageConversionError:
            # The recorded file is itself the 60 fps copy.
            self.converted_path = self.source_path
        self.status = (
            VideoStatus.READY if self.converted_path.is_file() else VideoStatus.NOT_CONVERTED
        )

    def fix_command(self, match_id: MatchId, db_file: Path) -> str | None:
        if self.status is VideoStatus.READY:
            return None
        if self.source_video is None or self.source_path is None or not self.source_path.is_file():
            url = "<url>" if self.source_video is None else shlex.quote(self.source_video.url)
            return f"pb-tokei download {url} --match {match_id} --db {shlex.quote(str(db_file))}"
        return f"pb-tokei convert {shlex.quote(str(self.source_path))}"


def create_app(
    db_path: Path,
    *,
    static_dir: Path = STATIC_DIR,
    cache_dir: Path | None = None,
) -> FastAPI:
    """Builds the app for the Rally Log at `db_path`.

    Relative `SourceVideo.path` values are resolved against the Rally Log's directory (ADR 0007).
    """
    db_file = db_path.resolve()
    motion_service = CameraMotionService(
        default_cache_dir(db_file) if cache_dir is None else cache_dir
    )
    app = FastAPI(title="pb-tokei annotate")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(ALLOWED_HOSTS))

    def lookup(match_id: UUID) -> tuple[MatchSummary, _VideoState]:
        with RallyLog.open(db_file) as log:
            try:
                summary = log.get_match_summary(MatchId(match_id))
            except KeyError:
                raise HTTPException(
                    status_code=404, detail=f"Match not found: {match_id}"
                ) from None
        return summary, _VideoState(summary.source_video, db_file)

    def lookup_motion_inputs(
        match_id: UUID,
    ) -> tuple[MatchId, Path | None, tuple[PlaySegment, ...], tuple[Calibration, ...]]:
        mid = MatchId(match_id)
        with RallyLog.open(db_file) as log:
            try:
                summary = log.get_match_summary(mid)
            except KeyError:
                raise HTTPException(
                    status_code=404, detail=f"Match not found: {match_id}"
                ) from None
            segments = log.get_play_segments(mid)
            calibrations = log.get_calibrations(mid)
        video = _VideoState(summary.source_video, db_file)
        video_path = video.converted_path if video.status is VideoStatus.READY else None
        return mid, video_path, segments, calibrations

    def with_log[T](action: Callable[[RallyLog], T]) -> T:
        """Runs an action on the Rally Log: 404 for a missing Match, 422 for invalid data."""
        with RallyLog.open(db_file) as log:
            try:
                return action(log)
            except MatchNotFound as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from None
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from None

    @app.exception_handler(duckdb.Error)
    async def rally_log_unavailable(_request: Request, exc: duckdb.Error) -> JSONResponse:
        # Most often the CLI is writing to the file at that moment; a retry will succeed.
        return JSONResponse(status_code=503, content={"detail": f"Rally Log unavailable: {exc}"})

    @app.get("/api/rally-log", operation_id="getRallyLog")
    def get_rally_log() -> RallyLogOut:
        return RallyLogOut(path=str(db_file))

    @app.get("/api/matches", operation_id="listMatches")
    def list_matches() -> list[MatchOut]:
        with RallyLog.open(db_file) as log:
            summaries = log.list_matches()
        return [
            MatchOut.from_summary(s, _VideoState(s.source_video, db_file).status) for s in summaries
        ]

    @app.get("/api/matches/{match_id}", operation_id="getMatch")
    def get_match(match_id: UUID) -> MatchDetailOut:
        summary, video = lookup(match_id)
        return MatchDetailOut.from_match(
            MatchOut.from_summary(summary, video.status), video.fix_command(summary.id, db_file)
        )

    @app.get(
        "/api/matches/{match_id}/video",
        operation_id="getMatchVideo",
        response_class=FileResponse,
        responses={200: {"content": {"video/mp4": {}}}, 206: {"content": {"video/mp4": {}}}},
    )
    def get_match_video(match_id: UUID) -> FileResponse:
        # The Rally Log is closed before the file streams, which can take as long as playback.
        _summary, video = lookup(match_id)
        if video.status is not VideoStatus.READY or video.converted_path is None:
            raise HTTPException(status_code=404, detail=f"No converted video for Match {match_id}")
        return FileResponse(video.converted_path, media_type="video/mp4")

    # --- Play Segments and Calibrations --------------------------------------------------

    @app.get("/api/matches/{match_id}/play-segments", operation_id="getPlaySegments")
    def get_play_segments(match_id: UUID) -> list[PlaySegmentIO]:
        segments = with_log(lambda log: log.get_play_segments(MatchId(match_id)))
        return [PlaySegmentIO.from_domain(s) for s in segments]

    @app.put("/api/matches/{match_id}/play-segments", operation_id="replacePlaySegments")
    def replace_play_segments(match_id: UUID, body: list[PlaySegmentIO]) -> list[PlaySegmentIO]:
        """Replaces all of a Match's Play Segments. 422 if any two share a frame."""

        def change(log: RallyLog) -> tuple[PlaySegment, ...]:
            log.replace_play_segments(MatchId(match_id), [s.to_domain() for s in body])
            return log.get_play_segments(MatchId(match_id))

        return [PlaySegmentIO.from_domain(s) for s in with_log(change)]

    @app.get("/api/matches/{match_id}/calibrations", operation_id="getCalibrations")
    def get_calibrations(match_id: UUID) -> list[CalibrationOut]:
        calibrations = with_log(lambda log: log.get_calibrations(MatchId(match_id)))
        return [CalibrationOut.from_domain(c) for c in calibrations]

    @app.put(
        "/api/matches/{match_id}/calibrations/{camera_view}", operation_id="replaceCalibrations"
    )
    def replace_calibrations(
        match_id: UUID, camera_view: CameraView, body: list[CalibrationIn]
    ) -> list[CalibrationOut]:
        """Replaces a Match's Calibrations of one Camera View, returning them with their fits."""

        def change(log: RallyLog) -> list[Calibration]:
            calibrations = [c.to_domain(camera_view) for c in body]
            log.replace_calibrations(MatchId(match_id), camera_view, calibrations)
            saved = log.get_calibrations(MatchId(match_id))
            return [c for c in saved if c.camera_view is camera_view]

        return [CalibrationOut.from_domain(c) for c in with_log(change)]

    # --- Camera Motion -------------------------------------------------------------------

    @app.get("/api/matches/{match_id}/camera-motion", operation_id="getCameraMotion")
    def get_camera_motion(match_id: UUID) -> CameraMotionOut:
        mid, video_path, segments, calibrations = lookup_motion_inputs(match_id)
        return motion_service.status(mid, video_path, segments, calibrations)

    @app.post("/api/matches/{match_id}/camera-motion/track", operation_id="trackCameraMotion")
    def track_camera_motion(match_id: UUID, wait: bool = False) -> CameraMotionOut:
        """Tracks and caches Camera Motion for any uncached Calibration spans of the Match."""
        mid, video_path, segments, calibrations = lookup_motion_inputs(match_id)
        return motion_service.trigger(mid, video_path, segments, calibrations, wait=wait)

    @app.get("/api/matches/{match_id}/camera-motion/frames", operation_id="getCameraMotionFrames")
    def get_camera_motion_frames(
        match_id: UUID,
        start_frame: int = Query(ge=0),
        end_frame: int = Query(ge=0),
    ) -> CameraMotionFramesOut:
        """Per-frame court-to-image matrices across an inclusive frame window."""
        _mid, video_path, segments, calibrations = lookup_motion_inputs(match_id)
        try:
            return motion_service.frames(video_path, segments, calibrations, start_frame, end_frame)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None

    @app.get("/api/{rest:path}", include_in_schema=False)
    def unknown_api(rest: str) -> None:
        raise HTTPException(status_code=404, detail=f"Not found: /api/{rest}")

    static_root = static_dir.resolve()

    @app.get("/{path:path}", include_in_schema=False)
    def front_end(path: str) -> FileResponse:
        # Built assets are served as files; any other path is a front-end route, so it gets
        # index.html and the router in the browser takes over (e.g. a reload on /matches/<id>).
        candidate = (static_root / path).resolve()
        if path and candidate.is_relative_to(static_root) and candidate.is_file():
            return FileResponse(candidate)
        index = static_root / "index.html"
        if not index.is_file():
            raise HTTPException(status_code=404, detail="Front end not built")
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app
