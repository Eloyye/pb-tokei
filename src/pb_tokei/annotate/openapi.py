"""Prints the annotation API's OpenAPI schema as JSON, for generating front-end types."""

from __future__ import annotations

import json
import sys

from pb_tokei.annotate.app import create_app
from pb_tokei.rally_log import DEFAULT_DB_PATH


def main() -> None:
    schema = create_app(DEFAULT_DB_PATH).openapi()
    json.dump(schema, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
