"""The annotation web app's HTTP API, and the built front end served from the same origin.

The Rally Log is opened afresh for each request and closed straight after, before any video
streams, so the CLI (`match add`, `download --match`) can still write to the DuckDB file while the
app runs.
"""

from __future__ import annotations

import shlex
from enum import StrEnum
from pathlib import Path
from uuid import UUID

import duckdb
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from pb_tokei.cli import DEFAULT_DB_PATH
from pb_tokei.convert import FootageConversionError, converted_path_for
from pb_tokei.rally_log import MatchId, MatchSummary, RallyLog, SourceVideo

STATIC_DIR = Path(__file__).parent / "static"


class VideoStatus(StrEnum):
    NONE = "none"
    NOT_CONVERTED = "not_converted"
    READY = "ready"


class MatchOut(BaseModel):
    """A Match's roster by name and whether its 60 fps video can be played."""

    id: UUID
    tournament: str
    team_a: tuple[str, str]
    team_b: tuple[str, str]
    franchise_a: str | None
    franchise_b: str | None
    video_status: VideoStatus


class MatchDetailOut(MatchOut):
    """A Match, plus the CLI command that makes its video playable when it isn't yet."""

    fix_command: str | None


class _VideoState:
    """Where a Match's video stands on disk, resolved against the server's start directory."""

    def __init__(self, source_video: SourceVideo | None, base_dir: Path) -> None:
        self.source_video = source_video
        self.source_path: Path | None = None
        self.converted_path: Path | None = None
        if source_video is None:
            self.status = VideoStatus.NONE
            return
        source = source_video.path
        self.source_path = source if source.is_absolute() else base_dir / source
        try:
            self.converted_path = converted_path_for(self.source_path)
        except FootageConversionError:
            # The recorded file is itself the 60 fps copy.
            self.converted_path = self.source_path
        self.status = (
            VideoStatus.READY if self.converted_path.is_file() else VideoStatus.NOT_CONVERTED
        )

    def fix_command(self, match_id: MatchId, db_path: Path) -> str | None:
        if self.status is VideoStatus.READY:
            return None
        if self.source_video is None or self.source_path is None or not self.source_path.is_file():
            url = "<url>" if self.source_video is None else shlex.quote(self.source_video.url)
            command = f"pb-tokei download {url} --match {match_id}"
            if db_path != DEFAULT_DB_PATH:
                command += f" --db {shlex.quote(str(db_path))}"
            return command
        return f"pb-tokei convert {shlex.quote(str(self.source_video.path))}"


def create_app(db_path: Path, *, base_dir: Path, static_dir: Path = STATIC_DIR) -> FastAPI:
    """Builds the app for the Rally Log at `db_path`.

    Relative paths (`db_path`, each `SourceVideo.path`) are resolved against `base_dir`, the
    directory the server was started from, just as the CLI resolves them.
    """
    db_file = db_path if db_path.is_absolute() else base_dir / db_path
    app = FastAPI(title="pb-tokei annotate")

    def lookup(match_id: UUID) -> tuple[MatchSummary, _VideoState]:
        with RallyLog.open(db_file) as log:
            try:
                summary = log.get_match_summary(MatchId(match_id))
            except KeyError:
                raise HTTPException(
                    status_code=404, detail=f"Match not found: {match_id}"
                ) from None
        return summary, _VideoState(summary.source_video, base_dir)

    @app.exception_handler(duckdb.Error)
    async def rally_log_unavailable(_request: Request, exc: duckdb.Error) -> JSONResponse:
        # Most often the CLI is writing to the file at that moment; a retry will succeed.
        return JSONResponse(status_code=503, content={"detail": f"Rally Log unavailable: {exc}"})

    def match_out(summary: MatchSummary, video: _VideoState) -> dict[str, object]:
        return {
            "id": summary.id,
            "tournament": summary.tournament,
            "team_a": summary.team_a,
            "team_b": summary.team_b,
            "franchise_a": summary.franchise_a,
            "franchise_b": summary.franchise_b,
            "video_status": video.status,
        }

    @app.get("/api/matches", operation_id="listMatches")
    def list_matches() -> list[MatchOut]:
        with RallyLog.open(db_file) as log:
            summaries = log.list_matches()
        return [
            MatchOut.model_validate(match_out(s, _VideoState(s.source_video, base_dir)))
            for s in summaries
        ]

    @app.get("/api/matches/{match_id}", operation_id="getMatch")
    def get_match(match_id: UUID) -> MatchDetailOut:
        summary, video = lookup(match_id)
        return MatchDetailOut.model_validate(
            {**match_out(summary, video), "fix_command": video.fix_command(summary.id, db_path)}
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
