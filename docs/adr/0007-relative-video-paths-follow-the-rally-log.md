# Relative Source Video paths are relative to the Rally Log's directory

Each Match in a Rally Log can point to a Source Video on disk (`SourceVideo.path`). Previously, relative paths such as `footage/abc123.mp4` were resolved against the current working directory of whatever command ran. That meant a Rally Log could only find its videos when opened from the one directory it happened to be created in, which broke opening a remembered Rally Log from anywhere else.

Relative `SourceVideo.path` values are therefore defined as **relative to the Rally Log file's directory**, not the process's start directory.

- **Reading:** the annotation app (and any tool reading a Rally Log) resolves a relative `SourceVideo.path` against the directory containing the `.duckdb` file, and leaves an absolute path as is.
- **Recording (`download --match`):** when `--match` is given, `--footage-dir` defaults to `<Rally Log dir>/footage` (without `--match` it stays `./footage`). The downloaded video's path is recorded relative to the Rally Log's directory when the file lives inside it, and as an absolute path otherwise.
- **Recording (`match add`):** a relative `[video] path` in a Roster File is interpreted relative to the Roster File's directory, then recorded in the Rally Log by the same rule (relative to the Rally Log's directory if inside it, absolute otherwise).

## Considered Options

- **Always store absolute paths:** rejected because moving or renaming a project folder (or copying a Rally Log together with its `footage/` directory to another machine) would break every video link.
- **Keep resolving relative paths against the start directory:** rejected because remembering and reopening the last-used Rally Log (`pb-tokei annotate` with no `--db`) would fail whenever run from another directory.

## Consequences

- A Rally Log together with a `footage/` directory beside it is self-contained and works regardless of which directory `pb-tokei` is launched from.
- Videos stored outside the Rally Log's directory (for example on an external drive) are stored as absolute paths rather than brittle `../../` traversals.
- Existing Rally Logs whose `SourceVideo.path` is already absolute need no migration.
- Fix commands shown by the annotation app always pass `--db <absolute path>` (and an absolute path for `pb-tokei convert`) so they run from any directory.
