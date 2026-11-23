"""Prints the annotation API's OpenAPI schema as JSON, for generating front-end types."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pb_tokei.annotate.app import create_app


def main() -> None:
    schema = create_app(Path("rally_log.duckdb"), base_dir=Path.cwd()).openapi()
    json.dump(schema, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
