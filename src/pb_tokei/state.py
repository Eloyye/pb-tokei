"""Per-user state (the last-opened and recent Rally Logs, and app settings) and Rally Log path
resolution."""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

import platformdirs

from pb_tokei.rally_log import DEFAULT_DB_PATH

STATE_DIR_ENV = "PB_TOKEI_STATE_DIR"
STATE_FILENAME = "state.json"
APP_NAME = "pb-tokei"
RECENT_LIMIT = 10
"""How many Rally Logs the recent list keeps, most recent first."""

_state_lock = threading.Lock()


class RallyLogNotFoundError(FileNotFoundError):
    """Raised when no usable Rally Log database could be resolved."""


def state_dir() -> Path:
    """Per-user state directory, overridable with `PB_TOKEI_STATE_DIR`."""
    override = os.environ.get(STATE_DIR_ENV)
    if override:
        return Path(override)
    return Path(platformdirs.user_state_dir(APP_NAME))


def state_file() -> Path:
    return state_dir() / STATE_FILENAME


def _read_state_dict(path: Path) -> dict[str, object]:
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except OSError, UnicodeDecodeError, json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _write_state_dict(target: Path, payload: dict[str, object]) -> bool:
    encoded = json.dumps(payload, indent=2) + "\n"
    tmp_path: Path | None = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=target.parent,
            prefix=f".{STATE_FILENAME}.",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(encoded)
            tmp.flush()
        os.replace(tmp_path, target)
    except OSError as exc:
        if tmp_path is not None:
            with contextlib.suppress(OSError):
                tmp_path.unlink(missing_ok=True)
        print(f"warning: could not save Rally Log state to {target}: {exc}", file=sys.stderr)
        return False
    return True


def _absolute_path(value: object) -> Path | None:
    """A remembered path, or None unless it is a usable absolute path string."""
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        return None
    candidate = Path(value)
    return candidate if candidate.is_absolute() else None


def _cookies_spec(value: object) -> str | None:
    """A remembered `--cookies-from-browser` spec, or None unless it is a usable string."""
    if not isinstance(value, str):
        return None
    spec = value.strip(" ")
    if not spec or spec.startswith("-") or any(ord(ch) < 32 or ord(ch) == 127 for ch in spec):
        return None
    return spec


def read_last_rally_log() -> Path | None:
    """Returns the remembered Rally Log absolute path, or None if missing/corrupt."""
    return _absolute_path(_read_state_dict(state_file()).get("last_rally_log"))


def read_recent_rally_logs() -> list[Path]:
    """The Rally Logs opened in `annotate`, most recent first, whether or not they still exist.

    Entries that aren't usable absolute paths are skipped. A state file written before the
    recent list existed yields just its last Rally Log.
    """
    data = _read_state_dict(state_file())
    raw = data.get("recent_rally_logs")
    entries = [data.get("last_rally_log"), *(raw if isinstance(raw, list) else [])]
    recent: list[Path] = []
    for entry in entries:
        path = _absolute_path(entry)
        if path is not None and path not in recent:
            recent.append(path)
    return recent[:RECENT_LIMIT]


def write_last_rally_log(db_path: Path) -> bool:
    """Atomically records `db_path` (as an absolute path) as the last Rally Log in the per-user
    state file, and moves it to the front of the recent list.

    Returns True on success. On failure, prints a warning to stderr and returns False.
    """
    target = state_file()
    resolved = db_path.resolve()
    with _state_lock:
        recent = [resolved, *(p for p in read_recent_rally_logs() if p != resolved)]
        payload = _read_state_dict(target)
        payload["last_rally_log"] = str(resolved)
        payload["recent_rally_logs"] = [str(p) for p in recent[:RECENT_LIMIT]]
        return _write_state_dict(target, payload)


def read_cookies_from_browser() -> str | None:
    """Returns the remembered browser cookie spec for the annotation app, or None."""
    return _cookies_spec(_read_state_dict(state_file()).get("cookies_from_browser"))


def write_cookies_from_browser(spec: str | None) -> bool:
    """Atomically records the annotation app's `cookies_from_browser` choice in `state.json`.

    Shared across every Rally Log; never read by the CLI.
    """
    normalized = None if spec is None else _cookies_spec(spec)
    if spec is not None and normalized is None:
        raise ValueError(f"Invalid cookies_from_browser value: {spec!r}")
    target = state_file()
    with _state_lock:
        payload = _read_state_dict(target)
        payload["cookies_from_browser"] = normalized
        return _write_state_dict(target, payload)


def resolve_rally_log(
    explicit: Path | None,
    *,
    allow_create: bool = False,
) -> Path:
    """Resolves which Rally Log database a CLI command should use (always an absolute path).

    Order:
    1. `explicit` (`--db`) if given (error if missing unless `allow_create` is True);
    2. the remembered Rally Log from per-user state, if it still exists;
    3. `./rally_log.duckdb`, if it exists;
    4. otherwise raises `RallyLogNotFoundError` naming the paths tried.
    """
    if explicit is not None:
        if not allow_create and not explicit.is_file():
            raise RallyLogNotFoundError(f"Rally Log database not found: {explicit}")
        return explicit.resolve()

    remembered = read_last_rally_log()
    if remembered is not None and remembered.is_file():
        return remembered.resolve()

    local_default = (Path.cwd() / DEFAULT_DB_PATH).resolve()
    if local_default.is_file():
        return local_default

    if remembered is not None:
        raise RallyLogNotFoundError(
            f"Rally Log database not found (tried remembered {remembered} and {local_default})"
        )
    hint = "pass --db <path> to create or select one" if allow_create else "pass --db <path>"
    raise RallyLogNotFoundError(
        f"Rally Log database not found "
        f"(no remembered Rally Log, and {local_default} does not exist; {hint})"
    )
