# The annotation app may fetch footage

Previously, the annotation app only displayed the terminal command needed to download or convert a Match's video, requiring the operator to leave the app before annotating. To let an operator's workflow stay inside the annotation app, the server may now run footage downloads and 60 fps conversions as background jobs.

- **Explicit start only:** download and conversion jobs are started only by an explicit operator click (**Fetch** or **Convert**). Opening a Match never triggers network traffic or encoding on its own.
- **One network boundary:** `pb_tokei.footage` remains the only module in the repository that invokes `yt-dlp` or touches the network.
- **Shared implementation, scriptable CLI:** the annotation app and the CLI (`pb-tokei download`, `pb-tokei convert`) call the same functions in `pb_tokei.footage` and `pb_tokei.convert`. The CLI remains the scriptable equivalent (including CLI-only options such as `--cookies <path>` and custom `--footage-dir`).
- **One job at a time, in memory:** `FootageJobService` runs a single download or conversion at a time across all Matches in a first-in-first-out queue, with live progress and cancellation. Jobs are not persisted across server restarts; cancelling a download preserves `yt-dlp`'s `.part` file so a retry resumes, while cancelling a conversion removes its temporary output file.
- **Cross-site protection:** because the server now starts local subprocesses and writes files on `POST`, every mutating API request (`POST`, `PUT`, `DELETE`, `PATCH`) must carry a same-origin `Origin` header (`http://127.0.0.1:<port>` or `http://localhost:<port>`), complementing the existing `Host` check.

## Considered Options

- **Keep fetching CLI-only:** rejected because leaving the app to run `download` and `convert` for every Match adds friction for routine annotation, especially when queuing several Matches at once.
- **Persist a job queue in DuckDB:** rejected because it would keep the Rally Log locked or add operational tables to a domain database. Partial downloads already resume via `.part` files on disk, and recorded `SourceVideo` rows already distinguish un-downloaded from un-converted Matches.

## Consequences

- Footage downloaded from the app lands in `<Rally Log dir>/footage` and is recorded on the Match immediately after download (before conversion) following ADR 0007's path rule, so a failed conversion leaves a Match that only needs converting.
- Browser cookie choice (`cookies_from_browser`) is stored per user in `state.json` for the annotation app only; the CLI continues to use only its own flags and `yt-dlp` config.
- Switching Rally Log (ADR 0008) or stopping the server cancels any queued or running footage jobs for the previous Rally Log.
