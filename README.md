# pb-tokei

Statistics on professional side-out-scored doubles pickleball (PPA, APP, MLP), derived from recorded broadcast footage.

- Vocabulary: [GLOSSARY.md](GLOSSARY.md)
- Decisions: [docs/adr/](docs/adr/)

## Usage

Download broadcast footage and convert it to constant 60 fps MP4 (requires `yt-dlp` and `ffmpeg` on `PATH`):

```bash
uv run pb-tokei download <url>
uv run pb-tokei download <url> --match <match-id> [--db <path>]
uv run pb-tokei download <url> --cookies-from-browser chrome   # or --cookies path/to/cookies.txt
uv run pb-tokei convert <path-to-original> [--force]
```

With `--match`, `--footage-dir` defaults to `<Rally Log dir>/footage` (otherwise `./footage`), and the video path is recorded relative to the Rally Log's directory when inside it (or absolute otherwise; see [ADR 0007](docs/adr/0007-relative-video-paths-follow-the-rally-log.md)).

If YouTube asks you to sign in to confirm you're not a bot, pass `--cookies-from-browser <browser>` (e.g. `chrome`, `firefox`, `safari`) or `--cookies <path>`, or configure a default in `~/.config/yt-dlp/config` (e.g. `--cookies-from-browser chrome`).

Set up a Match from a Roster File (by convention kept in `rosters/`), then list Matches:

```bash
uv run pb-tokei match new rosters/<tournament>/<match>.toml
uv run pb-tokei match add rosters/<tournament>/<match>.toml --db rally_log.duckdb
uv run pb-tokei match list [--tournament <name>] [--db <path>]
```

Pass `--db <path>` to `match add` when creating a new Rally Log. Once a Rally Log has been opened in `annotate` (or `./rally_log.duckdb` exists), you can omit `--db`: `annotate`, `match add`, `match list`, and `download --match` fall back to the last Rally Log opened in `annotate`, then `./rally_log.duckdb`, and print `Rally Log: <path>` to stderr so writes never go somewhere unexpected.

### Annotation app

A local web app (Chrome) that lists Matches and opens each in a Premiere-style workspace (Calibrate, Annotate, Review) with the Match's 60 fps video, a Timeline and keyboard playback. Layout and keys: [docs/annotation-ui.md](docs/annotation-ui.md). Build the front end once (needs [Bun](https://bun.sh)), then start it:

```bash
cd web && bun install && bun run build && cd ..
uv run pb-tokei annotate --db rally_log.duckdb   # remembers this Rally Log
uv run pb-tokei annotate [--port 8000] [--no-browser]
```

It serves on `127.0.0.1` only, opens the browser, and shows the open Rally Log's name in the header (full path on hover). `annotate` remembers the Rally Log it opens, and relative video paths are resolved relative to the Rally Log's directory, so `uv run pb-tokei annotate` reopens it from any directory with its videos playing. A Match without a playable video shows the command that fixes it; the app never downloads or converts anything.

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
