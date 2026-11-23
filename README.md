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

### Annotation app

A local web app (Chrome) that lists Matches and opens each in a Premiere-style workspace (Calibrate, Annotate, Review) with the Match's 60 fps video, a Timeline and keyboard playback. Layout and keys: [docs/annotation-ui.md](docs/annotation-ui.md). Build the front end once (needs [Bun](https://bun.sh)), then start it:

```bash
cd web && bun install && bun run build && cd ..
uv run pb-tokei annotate [--db rally_log.duckdb] [--port 8000] [--no-browser]
```

It serves on `127.0.0.1` only and opens the browser. Relative video paths are resolved from the directory you start it in, as with the other commands. A Match without a playable video shows the command that fixes it; the app never downloads or converts anything.

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` / `→` | one frame back / forward (pauses; hold to repeat) |
| `Shift+←` / `Shift+→` | ±1 s |
| `Alt+←` / `Alt+→` | ±10 s |
| `[` / `]` | slower / faster (0.25×, 0.5×, 1×, 2×, 4×) |
| `\` | back to 1× |
| `/` | go to a frame number, `m:ss` or `h:mm:ss.sss` (`Esc` closes) |
| `-` / `=` | zoom the Timeline out / in |
| `?` | keyboard shortcuts |

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

Front end (in `web/`; checked by the same pre-commit hook and in CI):

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun run test
bun run gen:api   # regenerate src/api/schema.d.ts after changing the API
```

To work on the annotation app, run the API and the Vite dev server side by side; Vite (port 5173) forwards `/api` to the API (port 8000):

```bash
uv run pb-tokei annotate --no-browser
```

```bash
cd web && bun run dev
```
