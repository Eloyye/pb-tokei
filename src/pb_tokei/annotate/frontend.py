"""Stamp and check the annotation app's built front end."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parents[3] / "web"
STATIC_DIR = Path(__file__).parent / "static"
SOURCE_HASH_FILE = ".source-hash"
UPDATE_COMMAND = "uv run pb-tokei dev update"

_ROOT_BUILD_INPUTS = {
    ".bun-version",
    "bun.lock",
    "index.html",
    "package.json",
    "tsconfig.json",
    "vite.config.ts",
}
_IGNORED_DIRECTORIES = {"coverage", "node_modules"}
_IGNORED_SUFFIXES = (".test.ts", ".test.tsx", ".swp", ".swo", ".orig", ".bak", "~")


def _raise_walk_error(exc: OSError) -> None:
    raise exc


def _build_inputs(web_dir: Path) -> Iterator[Path]:
    for path in sorted(web_dir.iterdir()):
        if path.name in _ROOT_BUILD_INPUTS and path.is_file():
            yield path

    for name in ("public", "src"):
        root = web_dir / name
        if not root.is_dir():
            continue
        for directory, dirs, files in root.walk(on_error=_raise_walk_error):
            dirs[:] = sorted(child for child in dirs if child not in _IGNORED_DIRECTORIES)
            for filename in sorted(files):
                if (
                    filename == ".DS_Store"
                    or filename.startswith(".#")
                    or filename.endswith(_IGNORED_SUFFIXES)
                ):
                    continue
                path = directory / filename
                if path.is_file():
                    yield path


def source_hash(web_dir: Path) -> str:
    """Hash the paths and contents of the front end's build inputs."""
    digest = hashlib.sha256()
    for path in _build_inputs(web_dir):
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


def stamp_bundle(static_dir: Path, source_digest: str) -> None:
    """Record the pre-build source hash after a successful build."""
    index = static_dir / "index.html"
    if not index.is_file():
        raise FileNotFoundError(f"the built front end is missing {index}")
    (static_dir / SOURCE_HASH_FILE).write_text(f"{source_digest}\n", encoding="ascii")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("hash", help="Print the build inputs hash.")
    stamp = commands.add_parser("stamp", help="Record the source hash used for a build.")
    stamp.add_argument("digest", help="Source hash captured before the build.")
    commands.add_parser("check", help="Check whether the built front end is current.")
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
        if args.command == "hash":
            print(source_hash(WEB_DIR))
        else:
            stamp_bundle(STATIC_DIR, args.digest)
    except OSError as exc:
        print(f"error: could not {args.command} the front end: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
