# Operator-edited Player anchors, two-layer Player Tracking cache, and Settled on shot_positions

_Extends [ADR 0001](0001-rally-log-is-the-seam.md), [ADR 0003](0003-judgments-are-derived-by-rule.md), [ADR 0005](0005-operators-edit-calibration-and-play-segments.md), [ADR 0006](0006-calibration-anchors-a-moving-camera.md), and [ADR 0011](0011-camera-motion-carries-the-lens.md)._

Player Tracking derives all four Players' court positions, Zones, and `Settled` facts across calibrated Play Segments from broadcast footage using person detection, ankle pose estimation, and each frame's `CourtMapping`. Three storage decisions keep Tracking fast to iterate on while preserving the Rally Log seam.

## Decisions

### 1. `player_anchors` and `team_ends` live in `rally_log.duckdb` alongside Calibration and Play Segments

Operator identity and position fixes (`player_anchors`) and near-end Team records (`team_ends`) are stored inside the Rally Log database, under the Match (included in `MATCH_CONTENT_TABLES`), extending ADR 0005. Event Processing never reads them.

- `player_anchors (match_id, frame, player_id, kind, image_x, image_y)` stores normalised image coordinates `[0, 1]^2` and `kind IN ('identity', 'position')`, never ephemeral tracker IDs. Mirroring `PlacedLandmark`, bumping `METHOD_VERSION` or changing detector/pose models preserves all operator work.
- Partial anchors (1–4 Players on a frame) are allowed so Sideline View frames with off-screen Players work naturally.
- `team_ends (match_id, effective_from_frame, near_team_id)` records which Team plays at the near end (`y < 0`, Main View camera end) with the same effective-from semantics as `Calibration`. It enables explicit Swap ends even on frames with missing detections, drives `CourtPanel`'s near/far labels, and narrows cross-gap partner matching without ever inferring identity from serve/receive court boxes (because pros stack).

### 2. Two-layer rebuildable Player Tracking cache in `.pb-tokei-cache/player_tracking/`

Extending ADR 0006, per-Match Player Tracking outputs live outside `rally_log.duckdb` in `.pb-tokei-cache/player_tracking/` and are split into two layers:

- **Layer 1 (calibration-free raw inference):** per-Play-Segment person detections, ankle keypoints, and appearance embeddings sampled at `DEFAULT_DETECTION_STRIDE` (default 4 = 15 fps on 60 fps footage, always including segment endpoints), keyed by source video fingerprint, Play Segment bounds, stride, detector/pose model IDs, and `METHOD_VERSION`. Tweaking Calibration Landmarks, re-running Camera Motion, or editing `player_anchors` / `team_ends` never re-runs GPU/MPS inference.
- **Layer 2 (fast court solve):** projects Layer 1 detections through `CourtMapping.at(frame)` (carrying lens distortion per ADR 0011), filters non-players (referees, line judges, spectators), tracks within segments, propagates piecewise identities across anchors, live Camera View cuts, and replay gaps, applies occlusion and cropped-feet certainty rules, and computes `Settled`. Fast to recompute on any Calibration, Camera Motion, anchor, or `team_ends` edit.

### 3. `Settled` is recorded as `Fact[bool]` on `shot_positions`

`Settled` ("in the Frontcourt and no longer moving toward the net at a Shot's contact") requires multi-frame trailing velocity from Tracking. Under ADR 0001, Event Processing reads only the Rally Log and never reads Tracking. Recording `settled` (`settled BOOLEAN`, `settled_certainty VARCHAR NOT NULL`, standard `_fact` CHECK) beside `position` on `shot_positions` preserves that boundary: Tracking computes `Settled` at contact frames, operators can inspect or override it, and Event Processing reads it directly from the Rally Log without depending on video or Tracking caches.

Existing Rally Logs migrate automatically: rows with a known position outside Frontcourt (`|y| > 9.0 ft`) migrate to `settled = False` with `position_certainty`; rows inside Frontcourt or with `Unknown` position migrate to `Unknown`.

## Considered Options

- **Compute `Settled` in Event Processing from adjacent Shots' positions:** rejected because consecutive Shots are 0.5–2 s apart and cannot tell whether a Player stopped moving toward the net in the trailing 0.25 s before contact.
- **Store raw detections and per-frame tracks in `rally_log.duckdb`:** rejected for the same reasons as ADR 0006 — bloats the hand-edited Rally Log, mixes rebuildable model output with operator facts, and creates DuckDB single-writer lock contention during background tracking.
- **Cache a single combined layer keyed by Calibration + anchors:** rejected because every Landmark tweak or anchor click would re-run neural inference across the whole Play Segment.

## Consequences

- `Shot.positions` pairs `position: Fact[CourtPoint]` and `settled: Fact[bool]` in `PlayerPosition`.
- Bumping `METHOD_VERSION` invalidates `.pb-tokei-cache/player_tracking/` cleanly while keeping every operator anchor and `team_ends` record intact in `rally_log.duckdb`.
- Layer 1 uses strictly Apache-2.0 / BSD PyTorch models (`ustc-community/dfine-small-coco` + `usyd-community/vitpose-plus-small`, weights downloaded on first run into the `platformdirs` user cache), picking CUDA, Apple MPS, or CPU at runtime.
- Event Processing remains 100% decoupled from Tracking and video files.
