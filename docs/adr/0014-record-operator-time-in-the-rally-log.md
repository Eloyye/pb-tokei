# Record operator time in the Rally Log

Extends ADRs [0004](0004-operator-time-budget.md), [0005](0005-operators-edit-calibration-and-play-segments.md), and [0012](0012-player-tracking-anchors-cache-and-settled.md).

The Rally Log stores `matches.annotation_mode`, `matches.source_video_frames`, and `operator_sessions` so the Operator Time Ratio can be computed for an archived Match. New and migrated Matches start in Gold mode. The broadcast length includes the entire converted 60 fps video. Conversion and Match setup can cache its frame count. The annotation server refreshes the count when it can read the converted video and uses the saved count when footage is offline.

Operator sessions are outside `MATCH_CONTENT_TABLES`. Saving Games, Calibration, and the rest of the Match content preserves session history. Event Processing ignores the timing metadata. The Benchmark harness can read the same Match summaries that the app and CLI use.

Each visit to Calibrate, Annotate, or Review starts a session with a UUID. A session belongs to one Match and one workspace. The client sends cumulative committed seconds within a UTC interval. The server validates that the active time fits the interval and keeps the highest total, earliest start, and latest end. Replaying a snapshot after a busy Rally Log or receiving snapshots out of order cannot double-count it. Separate visits, including concurrent visits in different tabs, retain their own IDs. The workspace breakdown lets the Benchmark harness see where operator time was spent.

The clock starts idle while a Match has ready video. Deliberate input in a visible, focused window starts or resumes it. A second input within two minutes commits the interval. The live display includes the current interval until a two-minute idle period, blur, hide, or exit discards it. Playback and pointer drift leave the clock idle. The first input after a pause starts a fresh interval. If the wall clock moves backward, the browser flushes the old session and starts a new one. This keeps breaks out of the 0.25 Assisted Annotation budget while providing a live clock without manual controls.

Background writes send committed time and carry the Rally Log named when the session started. A page close uses a keepalive request. Switching Rally Logs gives the current flush a short best-effort wait.
