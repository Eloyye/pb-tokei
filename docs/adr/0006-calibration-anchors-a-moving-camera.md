# A Calibration anchors a moving camera; Tracking follows the camera from it

Broadcast cameras, especially the Sideline View, pan and zoom during a Play Segment (and the Main View can drift slightly over the course of a Match), so one fixed mapping per Calibration is wrong away from its reference frame. An operator still clicks Landmarks only to anchor a Calibration on its reference frame. Tracking then estimates **Camera Motion** — registering every frame of the Play Segment to that Calibration's reference frame by chaining image-wide homographies and refining against the visible white court lines — and composes the result with the Landmark fit. This is valid because a broadcast camera rotates and zooms about a fixed point, so frames are related by an image-wide homography.

Recomputing registration on every `CourtMapping.at` call is too slow, so per-frame Camera Motion is cached on disk beside the Rally Log (under `.pb-tokei-cache/`, outside the DuckDB file) as derived, rebuildable data keyed by the Calibration's landmarks and frames, the Play Segment bounds, the source video fingerprint, and a tracking `METHOD_VERSION`. Changing a Calibration, editing a Play Segment, replacing the video, or bumping `METHOD_VERSION` invalidates the cached span so a better method still applies everywhere. ADR 0005's "store only Landmarks, never a fitted matrix" therefore still holds for what operators edit and what lives in the Rally Log database.

## Considered Options

- **Store Camera Motion inside `rally_log.duckdb`:** rejected because it mixes rebuildable pixel-tracking cache with hand-edited records, bloats the Rally Log file, and creates DuckDB single-writer lock contention while Tracking runs alongside the annotation app.
- **Re-click a new Calibration every few seconds:** rejected because it breaks the 25% Operator Time Ratio budget (ADR 0004).

## Consequences

- `CourtMapping.at(frame)` depends on the frame, not just on which Calibration is in effect.
- Both Sideline View and Main View use the same Camera Motion tracking; a steady camera simply produces near-identity transforms with minimal work.
- Per-frame Camera Motion is derived data: cached outside the Rally Log, rebuildable on demand, never edited by operators, and never read by Event Processing.
- A frame that cannot be registered (below feature-inlier or court-line agreement thresholds, e.g. on a cut inside a mis-marked Play Segment, a whip pan, or severe motion blur) has no court mapping, so its positions are Unknown rather than wrong. The Calibrate workspace highlights unmapped frames so the operator can fix the Play Segment or re-anchor there.
- Extra Calibrations inside a Play Segment become re-anchors after a tracking failure, not the normal way to follow a panning or zooming camera.
