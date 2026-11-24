"""Runs the annotation web app with uvicorn on 127.0.0.1 and opens it in the browser."""

from __future__ import annotations

import sys
import threading
import time
import webbrowser
from collections.abc import Callable
from pathlib import Path

import uvicorn

from pb_tokei.annotate.app import create_app
from pb_tokei.annotate.frontend import STATIC_DIR, UPDATE_COMMAND, WEB_DIR, bundle_is_current

HOST = "127.0.0.1"


class FrontEndNotBuiltError(RuntimeError):
    """Raised when the built front end (index.html) is missing from the static directory."""


def serve(
    db_path: Path,
    *,
    port: int,
    open_browser: bool,
    static_dir: Path | None = None,
    web_dir: Path | None = None,
    on_started: Callable[[], object] | None = None,
) -> None:
    """Serves the app until interrupted. Never builds the front end itself."""
    static_dir = STATIC_DIR if static_dir is None else static_dir
    web_dir = WEB_DIR if web_dir is None else web_dir
    if not (static_dir / "index.html").is_file():
        raise FrontEndNotBuiltError(
            f"the web front end is not built ({static_dir} has no index.html). "
            f"Run `{UPDATE_COMMAND}`."
        )
    if web_dir.is_dir() and not bundle_is_current(web_dir, static_dir):
        print(f"warning: the built front end is stale. Run `{UPDATE_COMMAND}`.", file=sys.stderr)
    app = create_app(db_path, static_dir=static_dir)
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="info"))
    watcher: threading.Thread | None = None
    if open_browser or on_started is not None:
        watcher = threading.Thread(
            target=_after_start,
            args=(server, f"http://{HOST}:{port}/" if open_browser else None, on_started),
            daemon=True,
        )
        watcher.start()
    try:
        server.run()
    finally:
        if watcher is not None:
            server.should_exit = True
            watcher.join(timeout=2.0)


def _after_start(
    server: uvicorn.Server,
    url: str | None,
    on_started: Callable[[], object] | None,
) -> None:
    while not server.started:
        if server.should_exit:
            return
        time.sleep(0.01)
    if on_started is not None:
        on_started()
    if url is not None:
        webbrowser.open(url)
