# Match set-up is editable

_Extends [ADR 0004](0004-operator-time-budget.md), [ADR 0009](0009-the-annotation-app-may-fetch-footage.md), and [ADR 0012](0012-player-tracking-anchors-cache-and-settled.md)._

An operator can make mistakes when creating a Match: a misspelled Player name, the wrong Tournament, a swapped Franchise Match, or an extra duplicate Match. Previously, nothing about a Match's set-up could be changed or deleted after creation except its date. Match set-up is now editable and deletable in the annotation app at `/matches/$matchId/edit`.

## Decisions

- **Editable after annotation:** a Match's date, Tournament, Franchise Match, and Players can be edited at any time, including after Rallies, Shots, Player anchors, and Team ends have been recorded. Shared records (Player name and handedness, Tournament name and Tour, Franchise name) can be edited or merged with an explicit affected-Match warning obtained from a dry run before confirming.
- **Contained per-Match rewrite in one transaction:** annotation tables reference Player and Team ids rather than names or "Team A / Team B", and every row belongs to one Match. Replacing a Player (directly or as part of a Player merge) rewrites every reference within that Match in one transaction: `rallies` (`serving_team_id`, `server_id`, `returner_id`, `challenger_id`, `winner_id`, `scoreboard_winner_id`), `shots` (`hitter_id`, `error_player_id`), `shot_positions` (`player_id`), `player_anchors` (`player_id`), `team_ends` (`near_team_id`), and `matches` (`team_a_id` / `team_b_id`), finding or creating the new Team for the replacement Player and partner. Other Matches are untouched.
- **Automatic orphan deletion:** any Tournament, Player, Team, Franchise, or Franchise Match no longer referenced by any Match after an edit, merge, or delete is deleted in the same transaction so misspelled or retired records do not linger in pickers or index pages.
- **Hard delete that keeps footage:** deleting a Match removes the Match, every table in `MATCH_CONTENT_TABLES`, its `operator_sessions`, and any orphans in one transaction, then cancels any queued or running footage, Camera Motion, or Player Tracking job for it. Footage files in `<Rally Log dir>/footage` and the rebuildable Player Tracking cache are kept because footage is slow to download again and may be shared with another Match. Deleting a Match that has Rallies requires typing its Tournament name.
- **Server-side stale-workspace rejection:** the app does not sync open tabs. Instead, the server rejects any Rally Log write for a Match that no longer exists (404) or whose Player or Team ids no longer belong to that Match (422), and the workspace displays "This Match was edited elsewhere; reload".

## Considered Options

- **Refuse Team changes after annotation:** rejected because an operator who chose the wrong Player before annotating would have to re-annotate the Match from scratch, which directly contradicts ADR 0004's operator time budget.
- **Soft delete:** rejected because nothing in the app consumes a trash or archive view, and the Rally Log is a single local DuckDB file that can be backed up before destructive edits.
- **Sync open workspace tabs live:** rejected as unnecessary complexity for one-off set-up fixes; warning the operator to close open tabs and rejecting stale writes on the server keeps the data safe without cross-tab state coordination.

## Consequences

- DuckDB forbids updating or deleting child rows and deleting now-orphaned parent rows in the same transaction when `REFERENCES` foreign keys are present. Rally Log tables therefore omit foreign-key constraints (matching how annotation tables already worked), existing Rally Logs drop legacy foreign keys automatically on open, and `RallyLog` enforces referential integrity inside its transactional operations.
- Player Tracking's Layer 2 cache keys on the Match roster and rebuilds automatically after a Player replacement or merge (ADR 0012), while Layer 1 detections remain reusable.
- All mutating Match, Player, Tournament, and Franchise endpoints sit behind the same-origin `Origin` check (ADR 0009) and remain app-only (no CLI equivalents beyond `match set-date`).
