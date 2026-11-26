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
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import replace
from enum import StrEnum
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import unquote
from uuid import UUID

import duckdb
from fastapi import Body, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import AwareDatetime, BaseModel, Field, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from pb_tokei.annotate.footage_jobs import (
    FetchFootageIn,
    FootageJobConflictError,
    FootageJobOut,
    FootageJobService,
    FootageJobSummaryOut,
)
from pb_tokei.annotate.frontend import STATIC_DIR
from pb_tokei.annotate.games import GameIO, frames_in, games_from_domain
from pb_tokei.annotate.match_setup import CreatedMatchOut, CreateMatchIn, RosterOut, roster_catalog
from pb_tokei.annotate.motion import (
    CameraMotionFramesOut,
    CameraMotionOut,
    CameraMotionService,
)
from pb_tokei.annotate.players import (
    PlayerAnchorIO,
    PlayerTrackingFramesOut,
    PlayerTrackingOut,
    PlayerTrackingService,
    TeamEndIO,
    TrackPlayersIn,
)
from pb_tokei.calibration import Matrix, assess
from pb_tokei.camera_motion import default_cache_dir, video_frame_count
from pb_tokei.convert import FootageConversionError, converted_path_for
from pb_tokei.footage import (
    CommandRunner,
    FootageDownloadError,
    StreamRunner,
    validate_cookies_from_browser,
    validate_url,
)
from pb_tokei.player_tracking import default_player_cache_dir
from pb_tokei.player_vision import DevicePreference, VisionBackend
from pb_tokei.rally_log import (
    ASSISTED_RATIO_BUDGET,
    AnnotationMode,
    Calibration,
    CameraView,
    Landmark,
    MatchId,
    MatchNotFound,
    MatchRoster,
    MatchSummary,
    OperatorSession,
    OperatorTimeSummary,
    OperatorWorkspace,
    PlacedLandmark,
    PlayerAnchor,
    PlaySegment,
    RallyLog,
    SourceVideo,
    TeamEnd,
    resolve_video_path,
)
from pb_tokei.roster import set_up_match
from pb_tokei.state import (
    read_cookies_from_browser,
    read_recent_rally_logs,
    write_cookies_from_browser,
    write_last_rally_log,
)

# The server binds 127.0.0.1 only. Checking the Host header as well stops DNS rebinding: a page
# whose domain re-resolves to 127.0.0.1 would otherwise be same-origin with the app.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")
MUTATING_METHODS = frozenset({"POST", "PUT", "DELETE", "PATCH"})

# Names the Rally Log a request means; see `_open_rally_log`.
RALLY_LOG_HEADER = "X-Rally-Log"
RALLY_LOG_SUFFIX = ".duckdb"


def _allowed_origins_for_host(host_header: str) -> frozenset[str]:
    """Origins allowed to make mutating requests to `host_header` (`127.0.0.1` or `localhost` on
    the same port)."""
    host, sep, port = host_header.strip().lower().partition(":")
    if host not in ALLOWED_HOSTS:
        return frozenset()
    if sep:
        if not port.isdigit():
            return frozenset()
        suffix = "" if port == "80" else f":{port}"
    else:
        suffix = ""
    return frozenset(f"http://{allowed}{suffix}" for allowed in ALLOWED_HOSTS)


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


class OperatorSessionIn(BaseModel):
    workspace: OperatorWorkspace
    started_at: AwareDatetime
    ended_at: AwareDatetime
    active_seconds: float = Field(ge=0, allow_inf_nan=False)

    @field_validator("active_seconds", mode="before")
    @classmethod
    def _json_safe_validation_input(cls, value: object) -> object:
        # Preserve the validation failure while keeping its input serializable in a 422 response.
        if isinstance(value, float) and not math.isfinite(value):
            return str(value)
        return value


class OperatorTimeOut(BaseModel):
    active_seconds: float
    calibrate_seconds: float
    annotate_seconds: float
    review_seconds: float

    @classmethod
    def from_summary(cls, time: OperatorTimeSummary) -> OperatorTimeOut:
        return cls(
            active_seconds=time.total_seconds,
            calibrate_seconds=time.calibrate_seconds,
            annotate_seconds=time.annotate_seconds,
            review_seconds=time.review_seconds,
        )


class MatchOut(BaseModel):
    """A Match's roster, footage status and active operator time."""

    id: UUID
    tournament: str
    team_a: tuple[str, str]
    team_b: tuple[str, str]
    franchise_a: str | None
    franchise_b: str | None
    video_status: VideoStatus
    annotation_mode: AnnotationMode
    broadcast_seconds: float | None
    operator_time: OperatorTimeOut
    operator_time_ratio: float | None
    assisted_ratio_budget: float = ASSISTED_RATIO_BUDGET
    footage_job: FootageJobSummaryOut | None = None
    # Rallies marked Done, and all Rallies, for Home's Progress column.
    done_rallies: int = 0
    total_rallies: int = 0

    @classmethod
    def from_summary(
        cls,
        summary: MatchSummary,
        video_status: VideoStatus,
        footage_job: FootageJobSummaryOut | None = None,
    ) -> MatchOut:
        return MatchOut(
            id=summary.id,
            tournament=summary.tournament,
            team_a=summary.team_a,
            team_b=summary.team_b,
            franchise_a=summary.franchise_a,
            franchise_b=summary.franchise_b,
            video_status=video_status,
            annotation_mode=summary.annotation_mode,
            broadcast_seconds=summary.broadcast_seconds,
            operator_time=OperatorTimeOut.from_summary(summary.operator_time),
            operator_time_ratio=summary.operator_time_ratio,
            footage_job=footage_job,
            done_rallies=summary.done_rallies,
            total_rallies=summary.total_rallies,
        )


class MatchPlayerOut(BaseModel):
    """One Player in a Match, with their Team assignment."""

    id: UUID
    name: str
    team_id: UUID
    team: Literal["a", "b"]


class MatchDetailOut(MatchOut):
    """A Match, plus its recorded video metadata, roster IDs, and fix command."""

    fix_command: str | None
    source_url: str | None
    original_present: bool
    team_a_id: UUID
    team_b_id: UUID
    players: list[MatchPlayerOut]

    @classmethod
    def from_match(
        cls,
        match: MatchOut,
        roster: MatchRoster,
        fix_command: str | None,
        *,
        source_url: str | None,
        original_present: bool,
    ) -> MatchDetailOut:
        players = [
            *(
                MatchPlayerOut(id=p.id, name=p.name, team_id=roster.team_a_id, team="a")
                for p in roster.team_a_players
            ),
            *(
                MatchPlayerOut(id=p.id, name=p.name, team_id=roster.team_b_id, team="b")
                for p in roster.team_b_players
            ),
        ]
        return MatchDetailOut(
            **match.model_dump(),
            fix_command=fix_command,
            source_url=source_url,
            original_present=original_present,
            team_a_id=roster.team_a_id,
            team_b_id=roster.team_b_id,
            players=players,
        )


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

    @property
    def original_present(self) -> bool:
        return (
            self.source_video is not None
            and self.source_path is not None
            and self.source_path.is_file()
        )

    @property
    def ready_url(self) -> str | None:
        if self.status is VideoStatus.READY and self.source_video is not None:
            return self.source_video.url
        return None

    def fix_command(self, match_id: MatchId, db_file: Path) -> str | None:
        if self.status is VideoStatus.READY:
            return None
        if not self.original_present or self.source_path is None:
            url = "<url>" if self.source_video is None else shlex.quote(self.source_video.url)
            return f"pb-tokei download {url} --match {match_id} --db {shlex.quote(str(db_file))}"
        return f"pb-tokei convert {shlex.quote(str(self.source_path))}"


class _OpenRallyLog:
    """The Rally Log the app is serving, with the Camera Motion and footage services for its
    Matches.

    A request takes this once and uses it throughout, so switching Rally Log mid-request never
    splits one request across two files.
    """

    def __init__(
        self,
        db_file: Path,
        *,
        footage_runner: CommandRunner | StreamRunner | None = None,
        player_backend_factory: Callable[[DevicePreference], VisionBackend] | None = None,
    ) -> None:
        self.db_file = db_file
        self.motion = CameraMotionService(default_cache_dir(db_file))
        self.players = PlayerTrackingService(
            default_player_cache_dir(db_file),
            self.motion.cache,
            backend_factory=player_backend_factory,
        )
        self.footage = FootageJobService(db_file, runner=footage_runner)

    def close(self) -> None:
        self.motion.close()
        self.players.close()
        self.footage.close()

    def video(self, source_video: SourceVideo | None) -> _VideoState:
        return _VideoState(source_video, self.db_file)

    def match_views(self, summaries: list[MatchSummary]) -> list[tuple[MatchOut, _VideoState]]:
        """Uses the converted footage on disk and caches changed counts for offline use."""
        views = []
        backfills = []
        for summary in summaries:
            video = self.video(summary.source_video)
            if video.status is VideoStatus.READY:
                frames = video_frame_count(video.converted_path)
                if frames is not None and frames != summary.source_video_frames:
                    summary = replace(summary, source_video_frames=frames)
                    backfills.append(summary)
            job = self.footage.summary(summary.id, ready_url=video.ready_url)
            views.append((MatchOut.from_summary(summary, video.status, job), video))

        if backfills:

            def backfill(log: RallyLog) -> None:
                for match in backfills:
                    log.set_match_video_frames(
                        match.id, match.source_video_frames, expected_source=match.source_video
                    )

            # A busy Rally Log can try again on the next read. This response has the live count.
            with suppress(duckdb.Error):
                self.run(backfill)
        return views

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

    def player_tracking_inputs(
        self, match_id: UUID
    ) -> tuple[
        MatchId,
        Path | None,
        MatchRoster,
        tuple[PlaySegment, ...],
        tuple[Calibration, ...],
        tuple[PlayerAnchor, ...],
        tuple[TeamEnd, ...],
    ]:
        mid = MatchId(match_id)

        def load(
            log: RallyLog,
        ) -> tuple[
            MatchSummary,
            MatchRoster,
            tuple[PlaySegment, ...],
            tuple[Calibration, ...],
            tuple[PlayerAnchor, ...],
            tuple[TeamEnd, ...],
        ]:
            summary = _match_summary(log, match_id)
            return (
                summary,
                log.get_match_roster(mid),
                log.get_play_segments(mid),
                log.get_calibrations(mid),
                log.get_player_anchors(mid),
                log.get_team_ends(mid),
            )

        summary, roster, segments, calibrations, anchors, team_ends = self.run(load)
        video = self.video(summary.source_video)
        video_path = video.converted_path if video.status is VideoStatus.READY else None
        return mid, video_path, roster, segments, calibrations, anchors, team_ends

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

    def __init__(
        self,
        db_file: Path | None,
        *,
        footage_runner: CommandRunner | StreamRunner | None = None,
        player_backend_factory: Callable[[DevicePreference], VisionBackend] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._footage_runner = footage_runner
        self._player_backend_factory = player_backend_factory
        self._current = (
            None
            if db_file is None
            else _OpenRallyLog(
                db_file,
                footage_runner=footage_runner,
                player_backend_factory=player_backend_factory,
            )
        )

    @property
    def current(self) -> _OpenRallyLog | None:
        return self._current

    def switch(self, db_file: Path) -> None:
        """Serves `db_file` from now on, cancelling the old Rally Log's background jobs."""
        with self._lock:
            old = self._current
            if old is not None and old.db_file == db_file:
                return
            self._current = _OpenRallyLog(
                db_file,
                footage_runner=self._footage_runner,
                player_backend_factory=self._player_backend_factory,
            )
        if old is not None:
            old.close()

    def close(self) -> None:
        with self._lock:
            old = self._current
        if old is not None:
            old.close()


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


def create_app(
    db_path: Path | None,
    *,
    static_dir: Path = STATIC_DIR,
    footage_runner: CommandRunner | StreamRunner | None = None,
    player_backend_factory: Callable[[DevicePreference], VisionBackend] | None = None,
) -> FastAPI:
    """Builds the app, serving the Rally Log at `db_path`, or none until one is chosen in the app.

    Relative `SourceVideo.path` values are resolved against the Rally Log's directory (ADR 0007).
    """
    rally_logs = _RallyLogs(
        None if db_path is None else db_path.resolve(),
        footage_runner=footage_runner,
        player_backend_factory=player_backend_factory,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        try:
            yield
        finally:
            rally_logs.close()

    app = FastAPI(title="pb-tokei annotate", lifespan=lifespan)
    app.state.rally_logs = rally_logs

    # Reject cross-site mutating requests (POST, PUT, DELETE, PATCH) from other pages open in the
    # browser. Added before TrustedHostMiddleware so Host is checked outermost first.
    @app.middleware("http")
    async def check_same_origin(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.method in MUTATING_METHODS:
            origin = request.headers.get("origin")
            host = request.headers.get("host", "")
            if origin not in _allowed_origins_for_host(host):
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Cross-site request blocked: invalid Origin"},
                )
        return await call_next(request)

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
        return [match for match, _ in rally_log.match_views(summaries)]

    @app.get("/api/roster", operation_id="getRoster")
    def get_roster(rally_log: OpenLog) -> RosterOut:
        """The records used to fill in the New Match form for this Rally Log."""
        return rally_log.run(roster_catalog)

    @app.post("/api/matches", operation_id="createMatch", status_code=201)
    def create_match(body: CreateMatchIn, rally_log: OpenLog) -> CreatedMatchOut:
        """Sets up a Match and optionally starts fetching its footage after it is saved."""
        match = rally_log.run(lambda log: set_up_match(log, body.to_roster()))
        if url := (body.footage_url or "").strip():
            try:
                validate_url(url)
                rally_log.footage.enqueue(
                    match.id, url=url, cookies_from_browser=read_cookies_from_browser()
                )
            except (FootageDownloadError, RuntimeError) as exc:
                rally_log.footage.record_enqueue_error(match.id, url, str(exc))
        return CreatedMatchOut(id=match.id)

    @app.get("/api/matches/{match_id}", operation_id="getMatch")
    def get_match(match_id: UUID, rally_log: OpenLog) -> MatchDetailOut:
        mid = MatchId(match_id)

        def load(log: RallyLog) -> tuple[MatchSummary, MatchRoster]:
            summary = _match_summary(log, match_id)
            return summary, log.get_match_roster(mid)

        summary, roster = rally_log.run(load)
        [(match, video)] = rally_log.match_views([summary])
        return MatchDetailOut.from_match(
            match,
            roster,
            video.fix_command(summary.id, rally_log.db_file),
            source_url=None if summary.source_video is None else summary.source_video.url,
            original_present=video.original_present,
        )

    @app.put(
        "/api/matches/{match_id}/operator-sessions/{session_id}",
        operation_id="upsertOperatorSession",
    )
    def upsert_operator_session(
        match_id: UUID, session_id: UUID, body: OperatorSessionIn, rally_log: OpenLog
    ) -> OperatorTimeOut:
        def save(log: RallyLog) -> OperatorTimeSummary:
            session = OperatorSession(
                session_id, body.workspace, body.started_at, body.ended_at, body.active_seconds
            )
            return log.upsert_operator_session(MatchId(match_id), session)

        return OperatorTimeOut.from_summary(rally_log.run(save))

    @app.get("/api/matches/{match_id}/footage", operation_id="getMatchFootage")
    def get_match_footage(match_id: UUID, rally_log: OpenLog) -> FootageJobOut:
        summary, video = rally_log.lookup(match_id)
        return rally_log.footage.status(summary.id, ready_url=video.ready_url)

    @app.post("/api/matches/{match_id}/footage/fetch", operation_id="fetchMatchFootage")
    def fetch_match_footage(
        match_id: UUID,
        body: FetchFootageIn,
        rally_log: OpenLog,
    ) -> FootageJobOut:
        """Queues a background download and/or 60 fps conversion for a Match (ADR 0009)."""
        summary, video = rally_log.lookup(match_id)

        should_save_cookies = "cookies_from_browser" in body.model_fields_set
        if should_save_cookies:
            raw_cookies = body.cookies_from_browser
            if raw_cookies is None or not raw_cookies.strip():
                cookies_spec: str | None = None
            else:
                try:
                    cookies_spec = validate_cookies_from_browser(raw_cookies)
                except FootageDownloadError as exc:
                    raise HTTPException(status_code=422, detail=str(exc)) from None
        else:
            cookies_spec = read_cookies_from_browser()

        raw_url = None if body.url is None else body.url.strip()
        provided_url = raw_url if raw_url else None
        if provided_url is not None:
            try:
                validate_url(provided_url)
            except FootageDownloadError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from None

        recorded_url = None if summary.source_video is None else summary.source_video.url
        same_as_recorded = provided_url is None or (
            recorded_url is not None and provided_url == recorded_url
        )

        # Already playable for the same URL: nothing to do.
        if video.status is VideoStatus.READY and same_as_recorded:
            return rally_log.footage.status(summary.id, ready_url=video.ready_url)

        convert_source: Path | None = None
        target_url: str | None = None
        if same_as_recorded and video.original_present and video.source_path is not None:
            # Original is already on disk: skip straight to converting.
            convert_source = video.source_path
        elif provided_url is not None:
            target_url = provided_url
        elif recorded_url is not None:
            try:
                validate_url(recorded_url)
            except FootageDownloadError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from None
            target_url = recorded_url
        else:
            raise HTTPException(
                status_code=422,
                detail="Provide a video URL: this Match has no recorded Source Video yet",
            )

        try:
            job = rally_log.footage.enqueue(
                summary.id,
                url=target_url,
                convert_source=convert_source,
                cookies_from_browser=cookies_spec,
            )
        except FootageJobConflictError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from None

        if should_save_cookies:
            write_cookies_from_browser(cookies_spec)
            job = job.model_copy(update={"cookies_from_browser": cookies_spec})
        return job

    @app.post("/api/matches/{match_id}/footage/cancel", operation_id="cancelMatchFootage")
    def cancel_match_footage(match_id: UUID, rally_log: OpenLog) -> FootageJobOut:
        """Cancels an active footage job or removes a queued one."""
        summary, _video = rally_log.lookup(match_id)
        return rally_log.footage.cancel(summary.id)

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

    # --- Games, Rallies and Shots ----------------------------------------------------------

    @app.get("/api/matches/{match_id}/games", operation_id="getGames")
    def get_games(match_id: UUID, rally_log: OpenLog) -> list[GameIO]:
        return games_from_domain(rally_log.run(lambda log: log.get_games(MatchId(match_id))))

    @app.put("/api/matches/{match_id}/games", operation_id="replaceGames")
    def replace_games(match_id: UUID, body: list[GameIO], rally_log: OpenLog) -> list[GameIO]:
        """Replaces all of a Match's Games, Rallies, Shots and Observation Gaps, leaving its Play
        Segments, Calibrations, Player anchors and Team ends. 422 if a frame is outside the video
        or a Team or Player isn't in the Match."""
        mid = MatchId(match_id)
        _summary, video = rally_log.lookup(match_id)
        if video.status is VideoStatus.READY and video.converted_path is not None:
            frame_count = video_frame_count(video.converted_path)
            if frame_count is not None:
                for what, frame in frames_in(body):
                    if frame >= frame_count:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"{what} frame {frame} is outside the video "
                                f"(length {frame_count} frames)"
                            ),
                        )

        def change(log: RallyLog) -> list[GameIO]:
            log.replace_games(mid, [g.to_domain() for g in body])
            return games_from_domain(log.get_games(mid))

        return rally_log.run(change)

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

    # --- Player Anchors, Team Ends, and Player Tracking ----------------------------------

    @app.get("/api/matches/{match_id}/player-anchors", operation_id="getPlayerAnchors")
    def get_player_anchors(match_id: UUID, rally_log: OpenLog) -> list[PlayerAnchorIO]:
        anchors = rally_log.run(lambda log: log.get_player_anchors(MatchId(match_id)))
        return [PlayerAnchorIO.from_domain(a) for a in anchors]

    @app.put("/api/matches/{match_id}/player-anchors", operation_id="replacePlayerAnchors")
    def replace_player_anchors(
        match_id: UUID, body: list[PlayerAnchorIO], rally_log: OpenLog
    ) -> list[PlayerAnchorIO]:
        """Replaces all operator-placed Player anchors for a Match."""
        mid = MatchId(match_id)
        _summary, video = rally_log.lookup(match_id)
        if video.status is VideoStatus.READY and video.converted_path is not None:
            frame_count = video_frame_count(video.converted_path)
            if frame_count is not None:
                for item in body:
                    if item.frame >= frame_count:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"Player anchor frame {item.frame} is outside the video "
                                f"(length {frame_count} frames)"
                            ),
                        )

        def change(log: RallyLog) -> tuple[PlayerAnchor, ...]:
            log.replace_player_anchors(mid, [a.to_domain() for a in body])
            return log.get_player_anchors(mid)

        return [PlayerAnchorIO.from_domain(a) for a in rally_log.run(change)]

    @app.get("/api/matches/{match_id}/team-ends", operation_id="getTeamEnds")
    def get_team_ends(match_id: UUID, rally_log: OpenLog) -> list[TeamEndIO]:
        ends = rally_log.run(lambda log: log.get_team_ends(MatchId(match_id)))
        return [TeamEndIO.from_domain(te) for te in ends]

    @app.put("/api/matches/{match_id}/team-ends", operation_id="replaceTeamEnds")
    def replace_team_ends(
        match_id: UUID, body: list[TeamEndIO], rally_log: OpenLog
    ) -> list[TeamEndIO]:
        """Replaces all `team_ends` records for a Match."""
        mid = MatchId(match_id)
        _summary, video = rally_log.lookup(match_id)
        if video.status is VideoStatus.READY and video.converted_path is not None:
            frame_count = video_frame_count(video.converted_path)
            if frame_count is not None:
                for item in body:
                    if item.effective_from_frame >= frame_count:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"TeamEnd frame {item.effective_from_frame} is outside the video "
                                f"(length {frame_count} frames)"
                            ),
                        )

        def change(log: RallyLog) -> tuple[TeamEnd, ...]:
            log.replace_team_ends(mid, [te.to_domain() for te in body])
            return log.get_team_ends(mid)

        return [TeamEndIO.from_domain(te) for te in rally_log.run(change)]

    @app.get("/api/matches/{match_id}/player-tracking", operation_id="getPlayerTracking")
    def get_player_tracking(match_id: UUID, rally_log: OpenLog) -> PlayerTrackingOut:
        mid, video_path, segments, _calibrations = rally_log.motion_inputs(match_id)
        return rally_log.players.status(mid, video_path, segments)

    @app.post("/api/matches/{match_id}/player-tracking/track", operation_id="trackPlayers")
    def track_players(
        match_id: UUID,
        rally_log: OpenLog,
        body: Annotated[TrackPlayersIn | None, Body()] = None,
    ) -> PlayerTrackingOut:
        """Explicitly triggers background Player Tracking, prioritising the playhead segment."""
        opts = TrackPlayersIn() if body is None else body
        mid, video_path, segments, _calibrations = rally_log.motion_inputs(match_id)
        return rally_log.players.trigger(
            mid,
            video_path,
            segments,
            priority_frame=opts.priority_frame,
            device=opts.device,
            wait=opts.wait,
        )

    @app.post("/api/matches/{match_id}/player-tracking/cancel", operation_id="cancelPlayerTracking")
    def cancel_player_tracking(match_id: UUID, rally_log: OpenLog) -> PlayerTrackingOut:
        """Cancels an active background Player Tracking job."""
        mid, video_path, segments, _calibrations = rally_log.motion_inputs(match_id)
        return rally_log.players.cancel(mid, video_path, segments)

    @app.get(
        "/api/matches/{match_id}/player-tracking/frames", operation_id="getPlayerTrackingFrames"
    )
    def get_player_tracking_frames(
        match_id: UUID,
        rally_log: OpenLog,
        start_frame: int = Query(ge=0),
        end_frame: int = Query(ge=0),
    ) -> PlayerTrackingFramesOut:
        """Windowed detections and resolved Player positions, Zones, and Settled facts."""
        _mid, video_path, roster, segments, calibrations, anchors, team_ends = (
            rally_log.player_tracking_inputs(match_id)
        )
        try:
            return rally_log.players.frames(
                video_path,
                roster,
                segments,
                calibrations,
                anchors,
                team_ends,
                start_frame,
                end_frame,
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
