"""The annotation web app's HTTP API, and the built front end served from the same origin.

The Rally Log is opened afresh for each request and closed straight after, before any video
streams, so the CLI (`match add`, `download --match`) can still write to the DuckDB file while the
app runs. The app serves one Rally Log at a time and can switch to another, or to a new one,
without restarting (`POST /api/rally-log`).
"""

from __future__ import annotations

import math
import shlex
import threading
from collections.abc import Callable, Mapping
from enum import StrEnum
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote
from uuid import UUID

import duckdb
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from pb_tokei.annotate.frontend import STATIC_DIR
from pb_tokei.annotate.motion import (
    CameraMotionFramesOut,
    CameraMotionOut,
    CameraMotionService,
)
from pb_tokei.calibration import Matrix, assess
from pb_tokei.camera_motion import default_cache_dir, video_frame_count
from pb_tokei.convert import FootageConversionError, converted_path_for
from pb_tokei.rally_log import (
    Calibration,
    CameraView,
    Landmark,
    MatchId,
    MatchNotFound,
    MatchSummary,
    PlacedLandmark,
    PlaySegment,
    RallyLog,
    SourceVideo,
    resolve_video_path,
)
from pb_tokei.state import read_recent_rally_logs, write_last_rally_log

# The server binds 127.0.0.1 only. Checking the Host header as well stops DNS rebinding: a page
# whose domain re-resolves to 127.0.0.1 would otherwise be same-origin with the app.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")

# Names the Rally Log a request means; see `_open_rally_log`.
RALLY_LOG_HEADER = "X-Rally-Log"
RALLY_LOG_SUFFIX = ".duckdb"


class VideoStatus(StrEnum):
    NONE = "none"
    NOT_CONVERTED = "not_converted"
    READY = "ready"


class RecentRallyLogOut(BaseModel):
    """A Rally Log opened before; `exists` is false once its file has gone (moved, deleted, or
    on a drive that isn't mounted)."""

    path: str
    exists: bool


class RallyLogOut(BaseModel):
    """The Rally Log the app is serving (null until one is chosen), and those opened recently."""

    path: str | None
    recent: list[RecentRallyLogOut]


class OpenRallyLogIn(BaseModel):
    """A Rally Log to switch to, or with `create`, a new empty one to make and switch to.

    A relative `path` is taken from the open Rally Log's directory (the server's start directory
    when none is open), and `~` is expanded. A new Rally Log gets `.duckdb` added if its name
    lacks it.
    """

    path: str = Field(min_length=1)
    create: bool = False


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


class PlacedLandmarkIO(BaseModel):
    """A Landmark clicked on a video frame, in normalised coordinates (0 to 1)."""

    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    frame: int = Field(ge=0)


class ImagePointIO(BaseModel):
    """A point in normalised image coordinates; mapped clicks may fall outside 0..1."""

    x: float
    y: float


class CalibrationIn(BaseModel):
    """One Calibration's clicked Landmarks; its Camera View is given by the URL."""

    effective_from_frame: int = Field(ge=0)
    reference_frame: int = Field(ge=0)
    landmarks: dict[Landmark, PlacedLandmarkIO]
    not_visible: list[Landmark] = Field(default_factory=list)

    def to_domain(self, camera_view: CameraView) -> Calibration:
        return Calibration(
            camera_view,
            self.effective_from_frame,
            self.reference_frame,
            {lm: PlacedLandmark(p.x, p.y, p.frame) for lm, p in self.landmarks.items()},
            frozenset(self.not_visible),
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
    not_visible: list[Landmark]
    complete: bool
    image_to_court: list[list[float]] | None
    court_to_image: list[list[float]] | None
    errors: dict[Landmark, LandmarkErrorOut]
    # Placed Landmarks mapped into `reference_frame` coordinates (used by the fit).
    resolved_landmarks: dict[Landmark, ImagePointIO]
    # Placed Landmarks from other frames that could not be mapped to `reference_frame`.
    unmapped_landmarks: list[Landmark]
    # Null with no fit, or when some click is off the court (that Landmark's `off_court` says so).
    worst_error_ft: float | None
    needs_attention: bool

    @classmethod
    def from_domain(
        cls,
        calibration: Calibration,
        *,
        frame_to_ref: Mapping[int, Matrix] | None = None,
    ) -> CalibrationOut:
        fit = assess(calibration, frame_to_ref=frame_to_ref)
        homography = fit.homography
        return CalibrationOut(
            camera_view=calibration.camera_view,
            effective_from_frame=calibration.effective_from_frame,
            reference_frame=calibration.reference_frame,
            landmarks={
                lm: PlacedLandmarkIO(x=p.x, y=p.y, frame=p.frame)
                for lm, p in calibration.landmarks.items()
            },
            not_visible=sorted(calibration.not_visible, key=lambda lm: lm.value),
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
            resolved_landmarks={
                lm: ImagePointIO(x=p.x, y=p.y) for lm, p in fit.resolved_landmarks.items()
            },
            unmapped_landmarks=sorted(fit.unmapped_landmarks, key=lambda lm: lm.value),
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


class _OpenRallyLog:
    """The Rally Log the app is serving, with the Camera Motion service for its Matches.

    A request takes this once and uses it throughout, so switching Rally Log mid-request never
    splits one request across two files.
    """

    def __init__(self, db_file: Path) -> None:
        self.db_file = db_file
        self.motion = CameraMotionService(default_cache_dir(db_file))

    def video(self, source_video: SourceVideo | None) -> _VideoState:
        return _VideoState(source_video, self.db_file)

    def lookup(self, match_id: UUID) -> tuple[MatchSummary, _VideoState]:
        summary = self.run(lambda log: _match_summary(log, match_id))
        return summary, self.video(summary.source_video)

    def motion_inputs(
        self, match_id: UUID
    ) -> tuple[MatchId, Path | None, tuple[PlaySegment, ...], tuple[Calibration, ...]]:
        mid = MatchId(match_id)

        def load(
            log: RallyLog,
        ) -> tuple[MatchSummary, tuple[PlaySegment, ...], tuple[Calibration, ...]]:
            summary = _match_summary(log, match_id)
            return summary, log.get_play_segments(mid), log.get_calibrations(mid)

        summary, segments, calibrations = self.run(load)
        video = self.video(summary.source_video)
        video_path = video.converted_path if video.status is VideoStatus.READY else None
        return mid, video_path, segments, calibrations

    def run[T](self, action: Callable[[RallyLog], T]) -> T:
        """Runs an action on the Rally Log: 404 for a missing Match, 422 for invalid data."""
        with RallyLog.open(self.db_file) as log:
            try:
                return action(log)
            except MatchNotFound as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from None
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from None

    def fit_calibrations(
        self,
        calibrations: list[Calibration] | tuple[Calibration, ...],
        segments: tuple[PlaySegment, ...],
        source_video: SourceVideo | None,
    ) -> list[CalibrationOut]:
        video = self.video(source_video)
        video_path = video.converted_path if video.status is VideoStatus.READY else None
        out: list[CalibrationOut] = []
        for cal in calibrations:
            f2r = (
                self.motion.cache.register_calibration_frames(video_path, cal, segments)
                if cal.has_off_reference_landmarks and video_path is not None
                else None
            )
            out.append(CalibrationOut.from_domain(cal, frame_to_ref=f2r))
        return out


def _match_summary(log: RallyLog, match_id: UUID) -> MatchSummary:
    try:
        return log.get_match_summary(MatchId(match_id))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Match not found: {match_id}") from None


class _RallyLogs:
    """Which Rally Log the app serves (one at a time, or none yet); switching swaps it for every
    later request."""

    def __init__(self, db_file: Path | None) -> None:
        self._lock = threading.Lock()
        self._current = None if db_file is None else _OpenRallyLog(db_file)

    @property
    def current(self) -> _OpenRallyLog | None:
        return self._current

    def switch(self, db_file: Path) -> None:
        """Serves `db_file` from now on, cancelling the old Rally Log's Camera Motion jobs."""
        with self._lock:
            old = self._current
            if old is not None and old.db_file == db_file:
                return
            self._current = _OpenRallyLog(db_file)
        if old is not None:
            old.motion.close()


def _open_rally_log(request: Request) -> _OpenRallyLog:
    """The open Rally Log, provided it is the one the request means.

    The front end names the Rally Log it loaded its data from in `X-Rally-Log` (percent-encoded),
    or in a `rally_log` query parameter where it can't set headers (video). So a tab left on a
    Rally Log another tab has switched away from gets a 409 rather than reading or saving the
    wrong file. Requests naming none (curl, scripts) take whichever is open.
    """
    rally_logs: _RallyLogs = request.app.state.rally_logs
    current = rally_logs.current
    if current is None:
        raise HTTPException(status_code=409, detail="No Rally Log is open: open or create one")
    header = request.headers.get(RALLY_LOG_HEADER)
    # A <video> element can't send headers, so its URL carries the path as a query parameter.
    wanted = unquote(header) if header is not None else request.query_params.get("rally_log")
    if wanted is not None and wanted != str(current.db_file):
        raise HTTPException(
            status_code=409,
            detail=f"The app has switched to another Rally Log ({current.db_file}); reload",
        )
    return current


OpenLog = Annotated[_OpenRallyLog, Depends(_open_rally_log)]


def _check_is_rally_log(path: Path) -> None:
    """422 unless `path` holds a Rally Log.

    Only a file DuckDB can't read at all counts as not a Rally Log. A Rally Log that is just busy
    (the CLI holds its lock, or a request here has it open) raises `duckdb.Error`, which the app
    answers with 503 so the operator tries again.
    """
    try:
        is_log = RallyLog.is_rally_log(path)
    except duckdb.IOException as exc:
        if "not a valid DuckDB database file" not in str(exc):
            raise
        is_log = False
    if not is_log:
        raise HTTPException(status_code=422, detail=f"Not a Rally Log: {path}")


def create_app(db_path: Path | None, *, static_dir: Path = STATIC_DIR) -> FastAPI:
    """Builds the app, serving the Rally Log at `db_path`, or none until one is chosen in the app.

    Relative `SourceVideo.path` values are resolved against the Rally Log's directory (ADR 0007).
    """
    rally_logs = _RallyLogs(None if db_path is None else db_path.resolve())
    app = FastAPI(title="pb-tokei annotate")
    app.state.rally_logs = rally_logs
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(ALLOWED_HOSTS))

    @app.exception_handler(duckdb.Error)
    async def rally_log_unavailable(_request: Request, exc: duckdb.Error) -> JSONResponse:
        # Most often the CLI is writing to the file at that moment; a retry will succeed.
        return JSONResponse(status_code=503, content={"detail": f"Rally Log unavailable: {exc}"})

    # --- Rally Log -----------------------------------------------------------------------

    def rally_log_out() -> RallyLogOut:
        current = rally_logs.current
        return RallyLogOut(
            path=None if current is None else str(current.db_file),
            recent=[
                RecentRallyLogOut(path=str(p), exists=p.is_file()) for p in read_recent_rally_logs()
            ],
        )

    @app.get("/api/rally-log", operation_id="getRallyLog")
    def get_rally_log() -> RallyLogOut:
        return rally_log_out()

    @app.post("/api/rally-log", operation_id="openRallyLog")
    def open_rally_log(body: OpenRallyLogIn) -> RallyLogOut:
        """Switches the app to another Rally Log, or creates an empty one, and remembers it.

        404 if the file to open doesn't exist, 422 if it isn't a Rally Log or the folder for a new
        one doesn't exist, 409 if a new one's file already exists.
        """
        current = rally_logs.current
        base = Path.cwd() if current is None else current.db_file.parent
        target = (base / Path(body.path).expanduser()).resolve()
        if body.create:
            if target.suffix != RALLY_LOG_SUFFIX:
                target = target.with_name(target.name + RALLY_LOG_SUFFIX)
            if target.exists():
                raise HTTPException(status_code=409, detail=f"Already exists: {target}")
            if not target.parent.is_dir():
                raise HTTPException(status_code=422, detail=f"No such folder: {target.parent}")
            try:
                with RallyLog.open(target):
                    pass
            except duckdb.Error as exc:
                target.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=422, detail=f"Couldn't create {target}: {exc}"
                ) from None
        elif current is not None and target == current.db_file:
            # Already open: keep its Camera Motion jobs running.
            pass
        elif not target.is_file():
            raise HTTPException(status_code=404, detail=f"Rally Log not found: {target}")
        else:
            _check_is_rally_log(target)
        rally_logs.switch(target)
        write_last_rally_log(target)
        return rally_log_out()

    # --- Matches -------------------------------------------------------------------------

    @app.get("/api/matches", operation_id="listMatches")
    def list_matches(rally_log: OpenLog) -> list[MatchOut]:
        summaries = rally_log.run(lambda log: log.list_matches())
        return [MatchOut.from_summary(s, rally_log.video(s.source_video).status) for s in summaries]

    @app.get("/api/matches/{match_id}", operation_id="getMatch")
    def get_match(match_id: UUID, rally_log: OpenLog) -> MatchDetailOut:
        summary, video = rally_log.lookup(match_id)
        return MatchDetailOut.from_match(
            MatchOut.from_summary(summary, video.status),
            video.fix_command(summary.id, rally_log.db_file),
        )

    @app.get(
        "/api/matches/{match_id}/video",
        operation_id="getMatchVideo",
        response_class=FileResponse,
        responses={200: {"content": {"video/mp4": {}}}, 206: {"content": {"video/mp4": {}}}},
    )
    def get_match_video(match_id: UUID, rally_log: OpenLog) -> FileResponse:
        # The Rally Log is closed before the file streams, which can take as long as playback.
        _summary, video = rally_log.lookup(match_id)
        if video.status is not VideoStatus.READY or video.converted_path is None:
            raise HTTPException(status_code=404, detail=f"No converted video for Match {match_id}")
        return FileResponse(video.converted_path, media_type="video/mp4")

    # --- Play Segments and Calibrations --------------------------------------------------

    @app.get("/api/matches/{match_id}/play-segments", operation_id="getPlaySegments")
    def get_play_segments(match_id: UUID, rally_log: OpenLog) -> list[PlaySegmentIO]:
        segments = rally_log.run(lambda log: log.get_play_segments(MatchId(match_id)))
        return [PlaySegmentIO.from_domain(s) for s in segments]

    @app.put("/api/matches/{match_id}/play-segments", operation_id="replacePlaySegments")
    def replace_play_segments(
        match_id: UUID, body: list[PlaySegmentIO], rally_log: OpenLog
    ) -> list[PlaySegmentIO]:
        """Replaces all of a Match's Play Segments. 422 if any two share a frame."""

        def change(log: RallyLog) -> tuple[PlaySegment, ...]:
            log.replace_play_segments(MatchId(match_id), [s.to_domain() for s in body])
            return log.get_play_segments(MatchId(match_id))

        return [PlaySegmentIO.from_domain(s) for s in rally_log.run(change)]

    @app.get("/api/matches/{match_id}/calibrations", operation_id="getCalibrations")
    def get_calibrations(match_id: UUID, rally_log: OpenLog) -> list[CalibrationOut]:
        mid = MatchId(match_id)

        def load(
            log: RallyLog,
        ) -> tuple[tuple[Calibration, ...], tuple[PlaySegment, ...], SourceVideo | None]:
            calibrations = log.get_calibrations(mid)
            segments = log.get_play_segments(mid)
            summary = log.get_match_summary(mid)
            return calibrations, segments, summary.source_video

        calibrations, segments, source_video = rally_log.run(load)
        return rally_log.fit_calibrations(calibrations, segments, source_video)

    @app.put(
        "/api/matches/{match_id}/calibrations/{camera_view}", operation_id="replaceCalibrations"
    )
    def replace_calibrations(
        match_id: UUID, camera_view: CameraView, body: list[CalibrationIn], rally_log: OpenLog
    ) -> list[CalibrationOut]:
        """Replaces a Match's Calibrations of one Camera View, returning them with their fits."""
        mid = MatchId(match_id)
        summary, video = rally_log.lookup(match_id)
        if video.status is VideoStatus.READY and video.converted_path is not None:
            frame_count = video_frame_count(video.converted_path)
            if frame_count is not None:
                for item in body:
                    if item.reference_frame >= frame_count:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"reference_frame {item.reference_frame} is outside the video "
                                f"(length {frame_count} frames)"
                            ),
                        )
                    for lm, placed in item.landmarks.items():
                        if placed.frame >= frame_count:
                            raise HTTPException(
                                status_code=422,
                                detail=(
                                    f"Landmark {lm.value} frame {placed.frame} is outside the "
                                    f"video (length {frame_count} frames)"
                                ),
                            )

        def change(
            log: RallyLog,
        ) -> tuple[list[Calibration], tuple[PlaySegment, ...]]:
            calibrations = [c.to_domain(camera_view) for c in body]
            log.replace_calibrations(mid, camera_view, calibrations)
            saved = log.get_calibrations(mid)
            segments = log.get_play_segments(mid)
            return [c for c in saved if c.camera_view is camera_view], segments

        saved_of_view, segments = rally_log.run(change)
        return rally_log.fit_calibrations(saved_of_view, segments, summary.source_video)

    # --- Camera Motion -------------------------------------------------------------------

    @app.get("/api/matches/{match_id}/camera-motion", operation_id="getCameraMotion")
    def get_camera_motion(match_id: UUID, rally_log: OpenLog) -> CameraMotionOut:
        mid, video_path, segments, calibrations = rally_log.motion_inputs(match_id)
        return rally_log.motion.status(mid, video_path, segments, calibrations)

    @app.post("/api/matches/{match_id}/camera-motion/track", operation_id="trackCameraMotion")
    def track_camera_motion(
        match_id: UUID, rally_log: OpenLog, wait: bool = False
    ) -> CameraMotionOut:
        """Tracks and caches Camera Motion for any uncached Calibration spans of the Match."""
        mid, video_path, segments, calibrations = rally_log.motion_inputs(match_id)
        return rally_log.motion.trigger(mid, video_path, segments, calibrations, wait=wait)

    @app.get("/api/matches/{match_id}/camera-motion/frames", operation_id="getCameraMotionFrames")
    def get_camera_motion_frames(
        match_id: UUID,
        rally_log: OpenLog,
        start_frame: int = Query(ge=0),
        end_frame: int = Query(ge=0),
    ) -> CameraMotionFramesOut:
        """Per-frame court-to-image matrices across an inclusive frame window."""
        _mid, video_path, segments, calibrations = rally_log.motion_inputs(match_id)
        try:
            return rally_log.motion.frames(
                video_path, segments, calibrations, start_frame, end_frame
            )
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
