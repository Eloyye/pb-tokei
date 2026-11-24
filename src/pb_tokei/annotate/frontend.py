"""Stamp and check the annotation app's built front end."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from collections.abc import Sequence
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parents[3] / "web"
STATIC_DIR = Path(__file__).parent / "static"
SOURCE_HASH_FILE = ".source-hash"
UPDATE_COMMAND = "uv run pb-tokei dev update"


def _raise_walk_error(exc: OSError) -> None:
    raise exc


def source_hash(web_dir: Path) -> str:
    """Hash relative paths and file contents, excluding installed dependencies."""
    digest = hashlib.sha256()
    for directory, dirs, files in web_dir.walk(on_error=_raise_walk_error):
        dirs[:] = sorted(name for name in dirs if name != "node_modules")
        for name in sorted(files):
            path = directory / name
            if not path.is_file():
                continue
            # A path terminator and a fixed-size file digest delimit each entry.
            digest.update(os.fsencode(path.relative_to(web_dir).as_posix()))
            digest.update(b"\0")
            with path.open("rb") as contents:
                digest.update(hashlib.file_digest(contents, "sha256").digest())
    return digest.hexdigest()


def bundle_is_current(web_dir: Path, static_dir: Path) -> bool:
    """Check for a built index and a stamp that matches the sources."""
    if not (static_dir / "index.html").is_file():
        return False
    try:
        stamp = (static_dir / SOURCE_HASH_FILE).read_bytes().strip()
        return stamp == source_hash(web_dir).encode("ascii")
    except OSError:
        return False


def stamp_bundle(web_dir: Path, static_dir: Path) -> None:
    """Record the source hash after a successful build."""
    index = static_dir / "index.html"
    if not index.is_file():
        raise FileNotFoundError(f"the built front end is missing {index}")
    (static_dir / SOURCE_HASH_FILE).write_text(f"{source_hash(web_dir)}\n", encoding="ascii")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("stamp", "check"))
    args = parser.parse_args(argv)

    if args.command == "check":
        if bundle_is_current(WEB_DIR, STATIC_DIR):
            return 0
        print(
            f"error: the built front end is stale or missing. Run `{UPDATE_COMMAND}`.",
            file=sys.stderr,
        )
        return 1

    try:
        stamp_bundle(WEB_DIR, STATIC_DIR)
    except OSError as exc:
        print(f"error: could not stamp the built front end: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
