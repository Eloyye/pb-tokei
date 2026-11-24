"""Per-user CLI state (last-opened Rally Log) and Rally Log path resolution."""

from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path

import platformdirs

from pb_tokei.rally_log import DEFAULT_DB_PATH

STATE_DIR_ENV = "PB_TOKEI_STATE_DIR"
STATE_FILENAME = "state.json"
APP_NAME = "pb-tokei"


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


def read_last_rally_log() -> Path | None:
    """Returns the remembered Rally Log absolute path, or None if missing/corrupt."""
    data = _read_state_dict(state_file())
    value = data.get("last_rally_log")
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        return None
    candidate = Path(value)
    if not candidate.is_absolute():
        return None
    return candidate


def write_last_rally_log(db_path: Path) -> bool:
    """Atomically records `db_path` (as an absolute path) in the per-user state file.

    Returns True on success. On failure, prints a warning to stderr and returns False.
    """
    target = state_file()
    resolved = db_path.resolve()
    payload = _read_state_dict(target)
    payload["last_rally_log"] = str(resolved)
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
