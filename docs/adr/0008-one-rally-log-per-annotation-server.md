# The annotation server has one Rally Log open; requests name the one they mean

The operator can switch the annotation app to another Rally Log, or create a new one, without restarting `pb-tokei annotate`. The server opens the Rally Log afresh for each request, but which file it opens is now state that changes while tabs are open. Each tab queues its own saves, and Camera Motion jobs run in the background against one Rally Log's Matches and cache folder. So a switch has to settle where every save and every job belongs.

The server has **one Rally Log open at a time**, shared by every tab. Every request from the front end names the Rally Log it loaded its data from, in an `X-Rally-Log` header (percent-encoded absolute path). The video is the one exception: a `<video>` element can't send headers, so its URL carries the path in a `rally_log` query parameter instead. A request naming a Rally Log that is no longer open gets **409** and touches no file. Requests without the header (curl, scripts) use whichever Rally Log is open.

- **Switching tab.** Before switching, it waits until its queued saves have landed, including the last save of an editor that is closing. If a save is retrying or was refused, it refuses to switch and shows that save's error, so nothing is dropped or sent to the new file. It then goes Home on the new Rally Log.
- **Other tabs.** A `BroadcastChannel` tells them at once. The header refetches `GET /api/rally-log` on every window focus, set explicitly rather than left to react-query's defaults, and that catches the rest. Their saves now get 409 and show as refused, and the header offers a reload. Their unsaved edits are not moved to the new Rally Log, where the Match ids differ anyway.
- **Camera Motion.** There is one `CameraMotionService` per open Rally Log, since both its cache folder (beside the Rally Log) and its Match-id job keys belong to one file. Switching builds a new service and closes the old one. Closing cancels its running jobs at their next check and starts no new ones. Spans already tracked stay cached beside the old Rally Log, ready if it is opened again.
- **New Rally Log.** It is created at the path the operator types, relative to the open Rally Log's folder, with `.duckdb` added if missing. It holds only the empty schema; Matches are added with `match add`. An existing file is never overwritten.
- **Recent list.** `state.json` keeps `recent_rally_logs`, the last 10 opened by `annotate` or the app, most recent first. Missing files stay listed (greyed out) because a drive may simply be unmounted. They drop off as newer entries push them past the cap.

## Considered Options

- **A Rally Log per tab (every request picks its file):** rejected. Two tabs could edit two Rally Logs at once, which is more than one operator needs. It would also need a Camera Motion service and a "last Rally Log" per tab.
- **No header, single Rally Log only:** rejected. A stale tab's save to a Match id that also exists in the new file would land in the wrong Rally Log silently. Today Match ids differ, so it only 404s, but the ids are not guaranteed to differ.
- **Refuse to switch while anything is unsaved, without waiting:** rejected. Autosave is almost always mid-flight just after an edit, so the operator would hit spurious refusals.

## Consequences

- Restarting the server on the same Rally Log doesn't disturb open tabs, because the header names a path, not a server session.
- Opening a file that is only busy (the CLI holds its lock) answers 503 so the operator retries. Only a file DuckDB can't read, or a DuckDB file without the Rally Log tables, is "not a Rally Log" (422).
- With no Rally Log found at startup, `annotate` serves anyway. Every Match request gets 409 until the operator chooses or creates a Rally Log in the picker.
