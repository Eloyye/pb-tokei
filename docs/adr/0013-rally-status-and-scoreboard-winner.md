# Rally status and the scoreboard winner live on `rallies`

_Extends [ADR 0001](0001-rally-log-is-the-seam.md), [ADR 0005](0005-operators-edit-calibration-and-play-segments.md), and [ADR 0012](0012-player-tracking-anchors-cache-and-settled.md)._

Rally and Shot entry (#12) needs two things the Rally Log did not hold: how far the operator has got with each Rally, and what the broadcast scoreboard showed, kept apart from the winner we record.

## Decisions

### 1. `rallies.status` is annotation-workflow state that Event Processing ignores

`status VARCHAR NOT NULL CHECK (status IN ('empty', 'in_progress', 'done'))` (`RallyStatus` in `model.py`, default `empty`) records the Rallies panel's ○ Empty / ● In progress / ✓ Done. The first edit to a Rally makes it In progress, `Enter` makes it Done, and Done never locks editing.

It is stored in the Rally Log, like Play Segments, Calibrations, Player anchors and Team ends (ADR 0005, ADR 0012), because it is the operator's own record of their work: it must survive reloads, travel with the Rally Log file, and feed Home's Progress column (`done_rallies` / `total_rallies` on `MatchSummary` and `MatchOut`). It is not a fact about the Rally, so Event Processing (#16) never reads it and no stat depends on it. A Rally left In progress still counts in every stat.

### 2. `rallies.scoreboard_winner_id` is a fact stored beside `winner_id` + `winner_source`

`scoreboard_winner_id` is a standard `Fact[TeamId]` (`scoreboard_winner_id UUID REFERENCES teams (id)`, `scoreboard_winner_id_certainty`). It records who the broadcast scoreboard says won, separately from `winner_id`, whose `winner_source` says which evidence decided it (Challenge, Referee Call, scoreboard, next Serve, or play, in that priority).

Keeping both means a disagreement between the Referee Call and the scoreboard is not resolved away at entry time: the winner follows the higher-priority Referee Call, and the scoreboard's reading is still there for the rule checks (#13) to flag the mismatch.

## Considered Options

- **Keep `status` in the browser (`localStorage`)**: rejected. Progress would not survive another browser or machine, and Home could not show it.
- **Derive status from content** (In progress when anything is recorded, Done when a winner is known): rejected. "Done" is the operator's judgment that they have finished checking a Rally, which no rule can infer; an Unseen Rally can be Done with almost nothing recorded.
- **Store the scoreboard reading only as `winner_source = scoreboard`**: rejected. A Referee Call outranks the scoreboard, so the scoreboard's reading would be lost exactly when it disagrees, which is the case the rule checks need.

## Consequences

- Older Rally Logs migrate in `schema.py:migrate`: `rallies` is rebuilt with `scoreboard_winner_id` Unknown, and `status = 'in_progress'` for a Rally that already has Shots, Observation Gaps, a Challenge, or any known score, Serving Team, Server, Returner, Referee Call or winner; otherwise `'empty'`.
- `RallyLog.replace_games` rewrites only a Match's `shot_positions`, `observation_gaps`, `shots`, `rallies` and `games`, so the Annotate workspace autosaves Rally edits without touching Play Segments, Calibrations, Player anchors or Team ends. It and `save_match` check that Game and Rally numbers are unique and positive, frames are in order, and every Team and Player belongs to the Match.
- Event Processing reads `scoreboard_winner_id` only through rule checks; the winner it uses is `winner_id`.
