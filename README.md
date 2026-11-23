# pb-tokei

Statistics on professional side-out-scored doubles pickleball (PPA, APP, MLP), derived from recorded broadcast footage.

- Vocabulary: [GLOSSARY.md](GLOSSARY.md)
- Decisions: [docs/adr/](docs/adr/)

## Usage

Download broadcast footage into `footage/` and convert it to constant 60 fps MP4 (requires `yt-dlp` and `ffmpeg` on `PATH`):

```bash
uv run pb-tokei download <url>
uv run pb-tokei download <url> --match <match-id> [--db rally_log.duckdb]
uv run pb-tokei convert <path-to-original> [--force]
```

Set up a Match from a Roster File (by convention kept in `rosters/`), then list Matches:

```bash
uv run pb-tokei match new rosters/<tournament>/<match>.toml
uv run pb-tokei match add rosters/<tournament>/<match>.toml [--db rally_log.duckdb]
uv run pb-tokei match list [--tournament <name>] [--db rally_log.duckdb]
```

## Development

```bash
uv sync
uv run pre-commit install
```

Checks (also run by the pre-commit hook and in CI):

```bash
uv run ruff format --check
uv run ruff check
uv run ty check
uv run pytest
```
