"""Runs the annotation web app with uvicorn on 127.0.0.1 and opens it in the browser."""

from __future__ import annotations

import threading
import time
import webbrowser
from collections.abc import Callable
from pathlib import Path

import uvicorn

from pb_tokei.annotate.app import STATIC_DIR, create_app

HOST = "127.0.0.1"
WEB_DIR = Path(__file__).resolve().parents[3] / "web"


class FrontEndNotBuiltError(RuntimeError):
    """Raised when the built front end (index.html) is missing from the static directory."""


def serve(
    db_path: Path,
    *,
    port: int,
    open_browser: bool,
    static_dir: Path | None = None,
    on_ready: Callable[[], object] | None = None,
) -> None:
    """Serves the app until interrupted. Never builds the front end itself."""
    static_dir = STATIC_DIR if static_dir is None else static_dir
    if not (static_dir / "index.html").is_file():
        raise FrontEndNotBuiltError(
            f"the web front end is not built ({static_dir} has no index.html). "
            f"Run `bun install && bun run build` in {WEB_DIR}"
        )
    app = create_app(db_path, static_dir=static_dir)
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="info"))
    if on_ready is not None:
        on_ready()
    if open_browser:
        threading.Thread(
            target=_open_when_started, args=(server, f"http://{HOST}:{port}/"), daemon=True
        ).start()
    server.run()


def _open_when_started(server: uvicorn.Server, url: str) -> None:
    while not server.started:
        if server.should_exit:
            return
        time.sleep(0.05)
    webbrowser.open(url)
