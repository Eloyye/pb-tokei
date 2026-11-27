# pb-tokei

[![checks](https://github.com/Eloyye/pb-tokei/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/Eloyye/pb-tokei/actions/workflows/checks.yml)
[![Python 3.15](https://img.shields.io/badge/python-3.15-blue.svg)](.python-version)
[![License](https://img.shields.io/github/license/Eloyye/pb-tokei)](LICENSE)

Statistics on professional side-out-scored doubles pickleball (PPA, APP, MLP), derived from recorded broadcast footage, for understanding how pros win and lose rallies.

![The annotation app's Calibrate workspace: the court template fitted over a video on the Monitor, the Landmark checklist on the right, and Play Segments on the Timeline](docs/images/annotation-app.png)

Create a Match in the local annotation app, fetch its broadcast, and annotate it Rally by Rally. Every Rally ends up in a Rally Log (a DuckDB file), and stats are derived from the Rally Log by rule. The words used throughout (Match, Rally, Play Segment, Calibration…) are defined in the [Glossary](GLOSSARY.md).

## Status

Works today:

- **Footage**: download a broadcast with `yt-dlp` and convert it to constant 60 fps for frame-exact seeking.
- **Matches**: set up a Match, with its Tournament, Teams and MLP Franchises, in the annotation app or from a Roster File.
- **Annotation app**: list Matches and open each in a Premiere-style workspace with frame-by-frame playback, a zoomable Timeline and keyboard controls.
- **Calibrate**: mark Play Segments and their Camera View, fit the court from up to 12 Landmarks, and follow Camera Motion through each Play Segment.
- **Report** shows Team and Player stats for a Match, with 90% Wilson intervals and Shot breakdowns.

Progress by milestone:

| Milestone | What it delivers | Status |
|---|---|---|
| [1: Ingest](https://github.com/Eloyye/pb-tokei/issues/3) | Footage download, 60 fps conversion, Match setup, the Rally Log | ✅ Done |
| [2: Manual Gold Annotation](https://github.com/Eloyye/pb-tokei/issues/8) | Calibration, Play Segments, Player positions, Rally and Shot entry, rule checks | 🚧 In progress |
| [3: Event Processing and the first dashboard page](https://github.com/Eloyye/pb-tokei/issues/15) | Derived facts, Shot Outcome rules, Team and Player stats, the Match report | Planned |
| [4: Benchmarks](https://github.com/Eloyye/pb-tokei/issues/21) | An annotated Gold Set and a benchmark harness | Planned |
| [5: Assisted pre-fill](https://github.com/Eloyye/pb-tokei/issues/24) | Models that pre-fill the Rally Log for an operator to review | Planned |
| [Later](https://github.com/Eloyye/pb-tokei/issues/31) | Ball tracking, Player movement, deferred decisions | Planned |

## Quick start

Runs on macOS and Linux (CI runs on Ubuntu). Windows is untested.

### Prerequisites

- [uv](https://docs.astral.sh/uv/getting-started/installation/). It installs Python 3.15 for you, so you don't need to install Python.
- [Bun](https://bun.sh), to build the annotation app's front end.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) and [ffmpeg](https://ffmpeg.org/download.html), both on your `PATH`.
- [Chrome](https://www.google.com/chrome/), the only browser the annotation app supports.

### From clone to an open Match

```bash
git clone https://github.com/Eloyye/pb-tokei.git
cd pb-tokei
uv run pb-tokei dev update
```

Run `uv run pb-tokei dev update` again after `git pull` or `git switch`.

Start the annotation app.

```bash
uv run pb-tokei annotate
```

1. If the Rally Log picker opens, enter `rally_log.duckdb` and click **New Rally Log**.
2. Click **New Match**. Enter the Tournament and the four Players, and paste the YouTube broadcast URL into **Footage URL**.
3. Click **Create Match**. The Workspace opens and shows download and conversion progress. Once the footage is ready, it plays at a constant 60 fps.

`annotate` remembers the Rally Log for the next session.

## Usage

Commands that read or write the Rally Log (`annotate`, `match add`, `match list`, `download --match`) take `--db <path>`. When `--db` is omitted, they use the last Rally Log opened in `annotate`, falling back to `./rally_log.duckdb`, and print `Rally Log: <path>` to stderr so writes never go somewhere unexpected. Pass `--db <path>` to `match add` when creating a new Rally Log.

### Footage

For scripting or terminal use, `download` saves a broadcast and converts it to a constant 60 fps MP4, and `convert` re-runs the conversion on a file already on disk (the annotation app runs the same code):

```bash
uv run pb-tokei download <url>
uv run pb-tokei download <url> --match <match-id> [--db <path>]
uv run pb-tokei download <url> --cookies-from-browser chrome   # or --cookies path/to/cookies.txt
uv run pb-tokei convert <path-to-original> [--force]
```

With `--match`, `--footage-dir` defaults to `<Rally Log dir>/footage` (otherwise `./footage`), and the video path is recorded relative to the Rally Log's directory when inside it, or absolute otherwise ([ADR 0007](docs/adr/0007-relative-video-paths-follow-the-rally-log.md)).

YouTube sometimes asks you to sign in to confirm you're not a bot. If it does, pass `--cookies-from-browser <browser>` (for example `chrome`, `firefox` or `safari`) or `--cookies <path>`. To set a default instead, add a line such as `--cookies-from-browser chrome` to `~/.config/yt-dlp/config`.

### Matches and Roster Files

A Roster File is a TOML file that sets up one Match: its Tournament, its two Teams and, for MLP, its Franchises. By convention they are kept in `rosters/`. `match new` writes a template with a fresh Match id, `match add` creates the Match it describes, and `match list` shows the Matches in the Rally Log:

```bash
uv run pb-tokei match new rosters/<tournament>/<match>.toml
uv run pb-tokei match add rosters/<tournament>/<match>.toml [--db <path>]
uv run pb-tokei match list [--tournament <name>] [--db <path>]
```

### Annotation app

A local web app for Chrome. It lists Matches and opens each in a Premiere-style workspace (Calibrate, Annotate, Review), with the Match's 60 fps video, a Timeline and keyboard playback:

```bash
uv run pb-tokei annotate [--db <path>] [--port 8000] [--no-browser]
```

The app serves on `127.0.0.1` only, opens your browser, and shows the open Rally Log's filename in the header (full path on hover). `annotate` remembers the Rally Log it opens, and relative video paths are resolved relative to the Rally Log's directory ([ADR 0007](docs/adr/0007-relative-video-paths-follow-the-rally-log.md)), so `uv run pb-tokei annotate` reopens it from any directory with its videos playing. If a Match has no playable video, you can fetch and convert it from the app — or run the equivalent terminal command shown underneath ([ADR 0009](docs/adr/0009-the-annotation-app-may-fetch-footage.md)).

Click the Rally Log's name in the header to switch Rally Log without restarting: pick one of the last 10 opened (missing files are listed but greyed out), type a path and **Open**, or type a path and **New Rally Log** to make an empty one there (`.duckdb` is added if missing). The Match list has a **New Match** button. A relative path starts from the open Rally Log's folder. Unsaved edits are saved before the switch, which is refused while a save is failing. The app then goes Home on the new Rally Log and remembers it as the last one. When `annotate` finds no Rally Log at all (no `--db`, nothing remembered, no `./rally_log.duckdb`), it starts anyway and opens this picker. A `--db` path that doesn't exist is still an error.

The server has one Rally Log open at a time ([ADR 0008](docs/adr/0008-one-rally-log-per-annotation-server.md)). Other tabs still on the old Rally Log can't save to it any more. Their header shows **Rally Log switched elsewhere: reload**.

Press `?` in the app for every key that works. The full layout and keymap, including planned keys, are in [docs/annotation-ui.md](docs/annotation-ui.md).

### Match report

Open **Report** from Home or a Match to see Team and Player stats for the whole Match. **Break down by** selects a Shot breakdown and keeps it in the URL. The report reflects the saved Rally Log each time it opens.

To try it with a synthetic Match, run these commands and select **Report** on Home.

```bash
uv run pb-tokei demo-match
uv run pb-tokei annotate --db demo-match.duckdb
```

## Project layout

```
src/pb_tokei/      the Python package: CLI, Rally Log, footage, Calibration, Camera Motion
  annotate/        the annotation app's API server (it also serves the built front end)
web/               the annotation app's front end (React, TypeScript, Vite, Bun)
tests/             pytest suite
docs/
  adr/             architecture decision records
  annotation-ui.md the annotation app's layout, keys and interaction model
  design/          clickable UI prototypes
scripts/           developer check pages
GLOSSARY.md        the project's vocabulary
rosters/           your Roster Files (by convention; not in the repository)
footage/           downloaded broadcasts (local only, gitignored)
```

## Contributing

Issues are welcome. Setup, checks, the front-end dev loop and how to propose changes are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
