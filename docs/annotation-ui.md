# Annotation app UI

The layout, look and interaction model of the annotation app (`pb-tokei annotate`). Every annotation frontend feature builds on it: Calibration and Play Segments (#10), Player positions (#11), Rally and Shot entry (#12), rule checks (#13), operator time (#14) and the Assisted Annotation review (#30).

A clickable prototype with sample data and working keys lives in [design/annotation-prototype.html](design/annotation-prototype.html). Where this document and the prototype disagree, this document wins.

## Principles

- **Premiere-style editor.** Dense, dark, panel-based. It is a pro tool used for hours, not a web form.
- **Rally by Rally.** The operator works on one Rally at a time and moves to the next with one key. The timeline gives orientation across the whole Game.
- **Keyboard first, modeless.** Letter keys always act on the current Shot, so there is no edit mode to enter. Use the pointer to navigate, edit the Court diagram and adjust frames on the Timeline.
- **Facts show how we know them.** Every Rally Log value shows whether it is Observed, Inferred or Unknown, using one visual rule everywhere.
- **Derived things are visibly derived.** Shot Type, Rally Phase and Team Status appear read-only and labeled as computed (ADR 0003).
- **Nothing blocks.** Rule checks flag; they never stop saving or moving on.

## Target

- Chrome on one desktop monitor at least 1440 px wide. Below about 1280 px no layout effort is made. The prototype stacks panels on narrow screens only so it can be viewed at all.
- Dark only. No light theme.

## Frame

```
┌ pb-tokei  Home › Tournament › Teams      Calibrate · Annotate · Review           ? ┐
├──────────────── Monitor ─────────────────────────┬─ Court ───────────┤
│                                                  │                   │
│                                                  ├─ Inspector ───────┤
│                                                  │ Shot | Rally      │
├─ Rallies ─┬──────────── Timeline ────────────────┴───────────────────┤
│ G1 R1 ✓   │ overview  ▬ ▬ ▬ ▬ ▬ ▬ ▬ ▬                                │
│ G1 R2 ●   │ ruler + playhead                                         │
│ G1 R3 ○   │ Segments / Rallies / Shots / Issues                      │
├───────────┴──────────────────────────────────────────────────────────┤
│ Saved · message · Active 14:32 · Ratio 0.19 · ● 2 issues · ? shortcuts│
└──────────────────────────────────────────────────────────────────────┘
```

- **Top bar.** Holds the brand, a breadcrumb (`Home › Tournament › Teams`), the workspace tabs in the center, and on the right the open Rally Log's filename (full path on hover; click it to switch Rally Log, see below) and a `?` button. There is no menu bar. The active workspace is shown in accent blue and underlined.
- **Panels** have a 28 px header with tab labels, and are separated by 4 px gutters. The panel last clicked gets a 1 px accent outline (Premiere's focused panel).
- **Resizing.** Three splitters set the right column width, bottom row height, and Rallies panel width. Sizes are remembered per browser in `localStorage`.
- **Panel swap.** In Annotate and Review, click **⇄** in either the Court or Monitor header or press backtick (`` ` ``) to put the Court in the wide left slot and the Monitor above the Inspector. The browser remembers the swap. Calibrate always shows the Monitor in the wide slot.
- **Status bar** (24 px), left to right:
  - save state
  - the last action or hint
  - in Review only, the confidence threshold slider
  - `Active m:ss` or `Active h:mm:ss`, dimmed while idle. Hover to see the Calibrate, Annotate, and Review totals.
  - `Ratio 0.19`, with the full broadcast length in its tooltip. In Assisted mode or Review, it shows `Ratio 0.19 / 0.25` in green within budget or amber over it. A known broadcast length and zero active time show `0.00`. An unknown broadcast length shows `—`.
  - Match-wide issue counts across all Games (red and amber, or `No issues`) in Annotate and Review; clicking cycles to the next rule issue (`F8` / `Shift+F8`)
  - the `?` hint

- **Rally Log picker.** A modal opened from the Rally Log's name. It shows the open Rally Log and up to 10 recent ones (the open one and missing files can't be chosen; missing files carry an amber `missing` pill). It has a path field, prefilled with the open Rally Log's folder, with **Open** and **New Rally Log** buttons. Choosing one waits for queued saves ("Saving changes…"), and refuses with the save's error if any save is retrying or was refused. After saves land, the picker gives the operator time flush up to two seconds before opening the Rally Log. On success the app goes Home on the new Rally Log. The picker opens by itself when no Rally Log is open, and the header then reads `No Rally Log` in amber. When another tab has switched the Rally Log, the name becomes an amber **Rally Log switched elsewhere: reload**.

## Workspaces

The workspace tabs are how the operator switches jobs. All three tabs use the same frame.

| Workspace | Right column in the default layout | Timeline | Notes |
|---|---|---|---|
| **Calibrate** (#10, #11, #51) | Two tabs: **Landmarks** and **Players**. Under **Landmarks**: the Calibration in effect at the playhead (mini court, 12-Landmark checklist with leave-one-out errors in feet, Camera Motion status and clickable unmapped ranges with one-click re-anchoring), then every Calibration of each Camera View (click to seek, × to delete, **Use here**). Under **Players**: explicit **Track Players** / **Cancel** with progress %, active compute device badge (`MPS` / `CUDA` / `CPU`), and per-segment status (prioritising the Play Segment under the playhead first); 4-Player checklist showing Zone, Settled, certainty, and active selection; 1-click **Swap A**, **Swap B**, and **Swap ends** buttons acting from the playhead forward; interactive Court diagram preview; and clickable lists of anchors and end changes (click to seek, × to delete) | Segments track editable (with amber hatching on unmapped Camera Motion ranges); Issues track shows clickable amber bars for unmapped ranges; Rallies and Shots dimmed | Under **Landmarks**: Landmarks are clicked on the Monitor with a 4× magnifier and lens-corrected court template; `Tab` skips, `V` marks not visible, `C` confirms carried-over clicks, `X` clears, `N` starts a new Calibration. Under **Players**: detected person boxes, foot dots, and Player labels render over the Monitor for 1-click/1-drag anchoring (see [Player positions and anchoring](#player-positions-and-anchoring)). Play Segment keys (`Shift+I`/`Shift+O`, `⌘K`, `1`/`2`, `Backspace`, `Esc`, and edge drags) work on both tabs. |
| **Annotate** (#11, #12, Gold) | Court diagram (the selected Shot's recorded positions, or live tracked Players when no Shot is selected) + Inspector | All tracks | Monitor header includes a toggleable **Players** overlay (boxes, foot dots, labels) plus quick **Swap A**, **Swap B**, and **Swap ends** controls; parked on the selected Shot's contact, Swap A / Swap B also swap those teammates on that Shot. A whole Game is entered with the keyboard (see [Keymap](#keymap)), apart from landing clicks on the Monitor or Court diagram. `Enter` marks the Rally Done. |
| **Review** (#30, Assisted) | Court + Inspector | All tracks; Shot markers with low-confidence fields get an amber dot | Low-confidence fields get an amber outline and a percentage. `N`/`Shift+N` move between them. `Enter` accepts the Rally. Threshold slider in the status bar. |

Each key's meaning is set by the workspace. The same key never does two things in one workspace.

In Calibrate, **Split Play Segment at playhead** (`⌘K` or `Ctrl+K`) ends the first Play Segment on the previous frame and starts the second on the playhead frame. Both keep the original Camera View. The edit autosaves and `⌘Z` undoes it in one step. Calibrate automatically rebuilds missing Camera Motion. Select **Track Players** in the Players tab to track the halves listed as pending. If a Calibration fit fails to reload, select **Retry Calibration fits** in the status bar. A split works from the frame after the start through the last frame. If the command is unavailable, the status bar explains why.

Annotate and Review share the saved panel swap. In the small slot, the Monitor shows timecode in its header and keeps its playback controls. In Annotate it also keeps **Players**, **Swap A**, **Swap B**, and **Swap ends**. Click it to bring the focus outline to the Monitor.

## Home

A separate screen: a dense table of Matches with these columns:

- Tournament
- Match (Teams with color swatches)
- Franchise Match
- Video
- Mode (Gold or Assisted pill)
- Progress (Rallies Done out of total, with a bar)
- Active (persisted active time, with a workspace breakdown on hover)
- Ratio (green within the 0.25 budget and amber over it in Assisted mode)

Clicking a row opens the Match in Annotate.

The table footer explains the Operator Time Ratio. Divide operator minutes by full broadcast minutes. Assisted Annotation has a 0.25 budget under ADR 0004. Gold Annotation has no time budget. Both Home and the workspace can show the ratio from the saved broadcast length while footage is offline.

## Operator time

The clock starts idle in Calibrate, Annotate, or Review when the video is ready. It tracks keyboard presses, pointer presses, scrolling, and form input in a focused, visible Match window. Pointer movement and playback alone leave the clock idle. The clock stays idle on Home, on New Match, and while footage is fetching or unavailable.

The Active display ticks after the first deliberate input. Each subsequent input within two minutes commits the time since the previous input. Two minutes of inactivity, a hidden tab, lost window focus, or leaving the workspace pauses the clock and removes the uncommitted interval. The next input starts a fresh interval. Changing workspace starts a new session and carries forward the Match's totals.

Committed time saves in the background every 15 seconds during activity and when pausing or leaving. The Rally Log picker and page close also flush it. These writes run independently of the save indicator and the annotation undo history.

## Monitor

Follows Premiere's Program Monitor:

- Black viewer.
- Camera View tag top-left: `MAIN VIEW`, `SIDELINE VIEW`, or `NOT A PLAY SEGMENT` in amber.
- Frame number bottom-left, large and monospace, with HH:MM:SS:FF timecode under it in accent blue.
- Bottom-right: playback speed (amber when below 1×), the Rally's frame range, and the play state.
- A transport row under the viewer:
  - left: Rally start, Rally end, add Shot
  - center: previous Rally, previous Shot, frame back, play, frame forward, next Shot, next Rally
  - right: a hint for `Enter`

Playback pauses at the selected Rally's end frame when playback started at or before it, unless the Rally is Done. `Space` there replays the Rally from its start; once it is Done, `Space` plays on. Seeking outside the Rally is always allowed so its bounds can be moved.

## Court diagram

A top-down Court with an orientation toggle in its header. The browser remembers the orientation for each slot. The side slot starts vertical, with the Main View camera's near end at the bottom and Team names above and below. The wide slot starts horizontal, with the near end on the right, the camera's left sideline at the bottom, and Team names to the left and right. The Zone labels and 12 ft ticks move to the top and bottom edges.

- Scroll or pinch on a trackpad to zoom around the pointer, up to 8×. Hold `Space` and drag or drag with the middle mouse button to pan. Click **Fit** or double-click the surround outside the court lines to show the whole playing area. The zoom and pan reset when you switch Matches. These controls also work in Calibrate → Players.
- The diagram draws the 32 × 64 ft playing area around the court (32 ft from the net, 16 ft from the centre line). A Player tracked beyond that area is drawn at its edge, and their dot's title gives the real position. Dots, labels, and line widths keep their size while you zoom.

- Zone bands are shaded: Frontcourt 0–9 ft, Midcourt 9–18 ft, Backcourt 18 ft and beyond. Dashed lines mark 9 and 18 ft, ticks outside the sidelines mark 12 ft (the Established rule), and the side labels read FC / MC / BC.
- **Players at the selected Shot.** Four dots in Team colors with initials, from the Shot's recorded `shot_positions`:
  - The hitter has a white ring.
  - An Inferred position is drawn at reduced opacity.
  - An Unknown position is drawn as a hollow dashed dot parked outside the court.
  - Dragging any dot (parked Unknown ones included) sets that Shot's position only, as Observed, with no Calibration needed. A Player dragged out of the Frontcourt becomes not Settled, and the hitter's Contact Zone follows their dot. Clicking a dot without dragging selects it (clicking it again deselects it).
- **Previous Shot.** Its positions are drawn as faint ghosts for context.
- **Landing.** Clicking the court — or clicking where the ball bounces on the **Monitor** video on any calibrated, mapped frame — sets the landing (Observed, clamped to the court and surround), shown as a ✕ in the hitter's Team color on both the Court (with a dashed arc from the hitter) and the Monitor. Monitor clicks map through the playhead frame's Calibration and Camera Motion (including lens distortion, ADR 0011), so scrub to the bounce before clicking. Plain clicks on the Monitor give way to Player foot dots, detection-box binding, and Player placement; `Alt`+click always sets the landing even over a Player. Because the mapping is for the ground plane, click the bounce spot on the court surface and keep using the Court diagram for a Volley's "would land" point. Clicking an unmapped frame, outside a Play Segment, or off the court plane does nothing and explains why in the status bar.
- **Header.** Shows what the diagram is drawing: `Shot <N|?> · contact HH:MM:SS:FF` (or `contact Unknown`) with a **Live** button that deselects the Shot when a Shot is selected, or `Live · HH:MM:SS:FF` at the playhead otherwise.
- **No Shot selected.** The diagram shows live Player Tracking at the playhead with #11's anchor fixes (below). Deselecting a Shot (clicking its selected pin, clicking **Live**, or pressing `Esc`) returns the diagram to live tracking and switches the Inspector to the Rally tab.

## Player positions and anchoring (#11)

Both `Calibrate → Players` and `Annotate` share one click/drag correction model backed by `player_anchors` and `team_ends` in the Rally Log (ADR 0012):

- **Click inside a detected person box on the Monitor** binds the selected Player to that detection (`kind = identity`), snaps to their detected ankles, seeds `team_ends` if none is set yet, and auto-advances selection through unanchored Players.
- **Drag any Player's foot dot on the Monitor or Court diagram** (or click empty court when placing an undetected Player) saves a `kind = position` anchor directly at the drop coordinates without snapping back to a bad detection box, and re-attaches tracking from there.
- **Leaving placement in Annotate.** Clicking an already-selected Player dot again (on the Monitor overlay or Court diagram) deselects them, and pressing `Esc` cancels Player placement ("Player placement cancelled") before deselecting the Shot so plain Monitor clicks return to setting landings. `Calibrate → Players` keeps its own selection auto-advance and `Esc` meaning.
- **Swap A / Swap B / Swap ends** act from the playhead forward, writing coordinate anchors (partner swaps) or `team_ends` records (end swaps) that survive cache rebuilds.
- **Live Court display:** Team colours (`--team-a`, `--team-b`) with initials, full opacity for `Observed`, reduced opacity for `Inferred`, hollow dashed dots parked outside the court for `Unknown`, and near/far Team labels driven by `team_ends`.
- Every anchor and `team_ends` edit autosaves and participates in `⌘Z` / `⇧⌘Z` undo/redo in both `Calibrate` and `Annotate`.

## Inspector

Two tabs: **Shot** and **Rally**. Setting a field switches to the tab that owns it.

The title shows the Shot or Rally, its frame and timecode, and counts. When a Shot follows an Observation Gap, the title says its number is unknown. When the playhead isn't on the selected Shot's contact (stepping on to watch where the ball lands, say), the title shows the offset and a **Move contact here** button.

Each row has three parts: label, value, then key hints on the right. A key hint lights up when it matches the current value.

**Shot tab**

- Recorded:
  - Hitter (`X` swaps to the partner, `Shift+H` or clicking the row switches to the other Team; both Observed)
  - Shot Class (`S H L O`), with a collapsible Soft/Hard checklist under it (open by default, remembered per browser):
    - **Soft:** descending as it crosses the net and landing (or, for a Volley, would land) in the opponent's Frontcourt.
    - **Hard:** anything else that isn't a Lob or Overhead.
  - Contact Kind (`V B`)
  - Contact Zone (follows the hitter's position; click to set it by hand when the position is Unknown)
  - Erne (`E`)
  - ATP (`T`)
  - Landing (click the court, or click the ground bounce on the Monitor video; `Alt`+click over a Player)
  - Error (`1`–`5`, `0` clears). The Error's Player defaults to the hitter, except for a Body Hit, where it is the opponent nearest the landing (or the first opponent). Pressing `5` again cycles between the opponents and `3` again between the hitter and partner; the row's picker sets any Player.
- Positions at contact, with a **Sync from tracking** button that re-pulls Player Tracking for the Shot (undoable): one row per Player with Team swatch, name, `(x, |y| ft, Zone)` in certainty style, and a clickable Settled badge (`Settled` / `Moving` / `Unknown`, ADR 0012).
- Derived, computed and never stored: Shot Type, Rally Phase, Team Status, labeled "Derived · computed, never stored".

**Rally tab**

- Frames (`Shift+I` / `Shift+O`)
- Score called, Serving Team, Server, Returner (pre-filled from side-out logic; `Shift+S` opens an inline form for them, the scoreboard reading and a winner seen in play)
- Referee Call (`Shift+P` / `Shift+2` / `Shift+X`; the same key again clears it)
- Challenge (`Shift+C` opens an inline form: challenger, original call from presets or free text, ruling, and Clear Challenge)
- Winner, with its source: Challenge, Referee Call, scoreboard, next Serve, or seen in play. Seen in play is either a winner entered by hand in the Rally details form (Observed) or one Inferred from the last Shot's Error, which is recomputed and goes away with the Error
- Scoreboard reading (stored apart from the winner, ADR 0013)
- Status
- Shot issues in this Rally (#13): clickable rows (`Shot <N|?>: <message>`) that select the Shot, seek to its contact frame, switch to the Shot tab, and focus the offending field

In a form, `Enter` saves and `Esc` cancels; other shortcuts are off while a field has focus.

**Field cursor.** The last field set keeps focus (blue row highlight). `Tab` / `Shift+Tab` move it. `C` acts on it. No other key depends on the cursor.

## Facts: Observed, Inferred, Unknown

One rule, used everywhere:

| Certainty | Look |
|---|---|
| Observed | Plain value in normal text color |
| Inferred | Italic, dimmed, with a small `inf` tag |
| Unknown | The word "Unknown" in a dashed empty slot |

`C` cycles the focused field: Observed → Inferred → Unknown → Observed. Going to Unknown clears the value, as the Rally Log requires. Coming back restores the stashed value. The winner can't be cycled: it is worked out from its sources.

Model confidence (Review only) is a separate channel: an amber outline and a percentage. Certainty and confidence never share a visual channel.

## Rallies panel

Rallies are grouped by Game. Each row shows:

- status: ○ Empty, ● In progress, ✓ Done
- Rally number
- the Serving Team's color swatch
- the score called (dashed swatch and "—" when Unknown)
- red and amber issue counts

The panel header shows Done out of total, with **+ Unseen** (`Shift+U`) and **+ Game** (`Shift+Enter`). Clicking a row, or `PgUp`/`PgDn`, moves to that Rally, selects its first Shot and fits the timeline to it. Clicking the selected Rally's row again deselects the Rally and any Shot. Clicking a Game's header makes it the active Game; an empty Game can be deleted from its header.

Right-click a row to select its Rally and open the same menu as a Rally clip without moving the playhead. The menu includes Rally start and end, Insert Unseen Rally after, Delete Rally, Mark Done, Fit Rally, and Rally details. Hover a disabled action to see why it is unavailable.

Status rules (stored on `rallies.status`, ADR 0013):

- A Rally becomes In progress on its first edit.
- `Enter` marks it Done and moves to the next Rally. On the last Rally it stays selected, and since it is Done, `Space` plays on past its end to find the next Rally.
- Done never locks editing.

Lifecycle:

- `Shift+I` with no Rally selected, or with the playhead past the selected Rally's end, starts a new open-ended Rally at the playhead (creating Game 1 if there is none), pre-filled from side-out logic. Otherwise it moves the selected Rally's start (an Unseen Rally gets framed this way). Rallies in a Game never overlap and are kept in frame order, numbered 1..N; Unseen Rallies stay where they were inserted.
- Shots can be added to an open-ended Rally. `Shift+O` ends it at the playhead, or moves the end of a framed Rally (with a warning if that cuts off its last Shot).
- `Shift+U` inserts an Unseen Rally after the selected one, `Shift+Backspace` deletes the selected Rally, and `Shift+Enter` starts Game N + 1, whose first Rally opens at 0-0-2.

Side-out pre-fill (Inferred, never overwriting Observed):

- Rally 1 of every Game starts at 0-0-2.
- After a Point, the score goes up and the Server stays; after the first server loses, the partner serves at server 2; after a side out, the other Team serves at server 1 from the right-hand court.
- The app learns which Player stands in the right-hand court on an even score from the legal serving box (right at 0-0-2 and every side out, flipping on each Point and on the second server), so it works whether or not Teams stack.
- Editing a Rally's score, Serving Team, Server, Returner or winner recomputes every later Rally in the Game for each fact that isn't Observed.
- Shot 1's Observed hitter fills in the Server and Serving Team, and Shot 2's the Returner, when those aren't Observed.
- An Unseen Rally's winner is Inferred from the next Rally's Observed serve (`next Serve`).

## Timeline

- **Header.** Zoom out and in around the playhead (`-` / `=`), Fit Rally (the selected Rally with 8% padding) and Fit video.
- **Overview bar.** The whole Game: Rally blocks in the Serving Team's color, the visible window outlined in blue, and the playhead. Click to jump or scroll in any direction to pan at the same scale as the lanes.
- **Ruler.** HH:MM:SS:FF ticks, with the tick step chosen from the zoom. The blue playhead has a head on the ruler. Click or drag on the ruler or any lane to scrub.
- **Track headers** on the left, Premiere-style, with the current timecode above them.
- **Zoom.** Scroll up to zoom in and down to zoom out, or pinch. Over the ruler and lanes, zoom follows the pointer while paused. During playback or over the track headers and timecode, zoom follows the playhead.
- **Pan.** Swipe horizontally, hold `Shift` while scrolling, or drag with the middle mouse button. On the ruler and lanes, the content moves with the cursor. On the Overview bar, middle-drag moves the visible window directly across the video. A middle-click by itself has no effect. Playback continues while you hold the button, and the view can follow the playhead again on the next frame after release.
- **Context menus.** Right-click a Rally clip, Shot pin, Observation Gap pill, or Play Segment clip to select it and see its actions without moving the playhead. Right-click empty lane space for Fit Rally, Fit video, and Rally start at playhead. Items show their shortcuts and disabled actions explain why on hover. Press `Esc` or click outside to close the menu. Menu edits use the same undo history and status messages as their shortcuts.
- Scrubs and edge drags follow the frame under the pointer as you zoom or pan. An edge drag pauses playback and previews that frame in the Monitor. Releasing returns the Monitor to the playhead and saves the changed edge as one undo step.
- **Tracks:**
  - **Segments.** Play Segments are colored by Camera View (Main blue-gray, Sideline brown). Clicking a clip selects it and scrubs to the click. Drag either edge in Calibrate, Annotate or Review. The edge stops at the closest adjacent Play Segment or the segment's other edge. In Calibrate, the clip menu offers Set Main View, Set Sideline View, Delete Play Segment, and start and end at the playhead for the selected clip. **Split Play Segment at playhead** is available when the playhead is in that clip past its first frame. Use it and then drag an edge to cut out a replay. Keyboard shortcuts follow the playhead and any pending Play Segment. Scrub outside the clip or press `Esc` with the menu closed to clear the selection.
  - **Rallies.** Each framed Rally gets a clip in the Serving Team's color with its status, number and score. Click a clip to select it and show its outline; click the selected clip again to deselect the Rally and any Shot. In Annotate and Review, hover near an edge to see its handle, then drag to preview the new bounds in the track and the Overview bar. Dragging an unselected clip's edge selects that Rally. The start can go as early as one frame after the previous Rally's end (its start when open-ended) and as late as the first Shot's contact. The end can go as early as the last Shot's contact and as late as one frame before the next Rally's start. Either edge can meet the other at a single frame. The status bar explains which limit stopped the drag. Open-ended Rallies have a dashed end and a start handle. In Annotate, use `Shift+O` to set their end. `Shift+O` can also move a Rally's end before its last Shot, with a warning.
  - **Shots.** A pin per Shot in the hitter's Team color (dimmed when the hitter is Inferred), labeled with its Shot Number (`?` after an Observation Gap). The current Shot has a white ring. Click a pin to select the Shot, click the selected pin again to deselect it (keeping the Rally selected), or drag it to move its contact frame (Shots re-sort if it passes another; dragging never deselects). Observation Gaps appear as hatched dashed pills ("odd gap" / "even gap") halfway between the Shots around them; click one to select or deselect it.
  - **Issues.** In Calibrate, clickable amber bars for unmapped Camera Motion ranges (#10). In Annotate and Review, clickable merged markers for rule checks (#13): one triangle per offending Shot at its contact frame and one bar per offending framed or open-ended Rally (Unseen Rallies are omitted from the Timeline). Red takes precedence over amber when mixed; hovering lists every message on that Shot or Rally, and clicking selects the offending Rally/Shot, switches to its Inspector tab, and focuses its first offending field (red before amber).
  - Space is reserved for an audio waveform track later (#26).
- Entering a Rally zooms to it with 8% padding. During playback the view pages along with the playhead.

## Rule checks (#13)

Live, non-blocking rule checks run purely on the Match's in-memory Games and Roster in Annotate and Review (never persisted or dismissible, ADR 0003). They evaluate Observed and Inferred facts across every Rally regardless of status (`empty`, `in_progress`, or `done`) and skip Unknown facts (except that an Unknown-hitter Shot mid-Rally counts as one Team flip in alternation, and an Unknown landing on a Serve or Return raises an amber warning).

Each check appears in four linked places:

1. a merged clickable marker on the Timeline **Issues** track (triangle on a Shot with a known contact frame; bar across a framed or open-ended Rally; Unseen Rallies are omitted from the Timeline)
2. an inline `.badge.red` / `.badge.amber` message under the offending Inspector field (plus clickable **Shot issues in this Rally** rows at the bottom of the Rally tab)
3. compact red and amber count pills on each Rally row in the **Rallies** panel
4. clickable Match-wide counts in the **Status bar** (`● <red> ● <amber> issues` or `No issues`), synced with `F8` / `Shift+F8` chronological cycling across all Games (including Unseen Rallies)

- **Red** means a rule is definitely broken:
  - **Team alternation & Observation Gaps** (`Hitter`): Teams must alternate across Shots, starting from the Serving Team on Shot 1, accounting for leading and mid-Rally odd/even Observation Gaps and counting each Unknown-hitter Shot as one Team flip; re-anchors after a wrong-Team Shot so one mistake does not cascade.
  - **Two-bounce rule** (`Contact Kind`): Shot 2 or Shot 3 is a Volley (skipped on Shot 1, Unknown Contact Kind, or Shots after an Observation Gap).
  - **Volley inside the kitchen** (`Contact Kind`): Volley with the hitter's foot position inside the sidelines (`|x| ≤ 10.0 ft`) and strictly closer than `6.5 ft` to the net (0.5 ft inside the 7.0 ft kitchen line). Exempt when `Erne` is true or when the hitter committed a `Kitchen Fault` (or `Kitchen Fault` with Unknown Player).
  - **Error on a non-final Shot** (`Error`): an Error recorded on a Shot followed by another Shot or Observation Gap.
  - **Intra-rally roster & score impossibilities** (`Score called`, `Server`, `Returner`): negative score, Server not on the Serving Team, or Returner on the Serving Team.
- **Amber** means likely wrong:
  - **Serve / Return hitter mismatch** (`Hitter`): Shot 1's hitter differs from the Rally's Server, or Shot 2's hitter differs from the Returner (suppressed when Team alternation already flagged the Shot in red).
  - **Volley at the kitchen line** (`Contact Kind`): Volley inside the sidelines (`|x| ≤ 10.0 ft`) in the `6.5–7.0 ft` kitchen-line margin (same `Erne` and hitter `Kitchen Fault` exemptions).
  - **Missing Serve / Return landing** (`Landing`): Shot 1 (Serve) or Shot 2 (Return) has an Unknown landing, so Shot Outcome (#17) cannot judge its depth (skipped when the Shot ends the Rally with an Error, and when Shot Number is Unknown).
  - **Last-Shot Error vs Rally winner** (`Error`): final Shot's Error implies a different winner than `Rally.winner_id` (exempt when a Challenge was overturned).
  - **Referee Call vs server number** (`Referee Call`): `Side out` called with Server 1, or `Second server` called with Server 2.
  - **Winner agreement** (`Winner`): post-Challenge official ruling (flipped Referee Call or last-Shot Error when overturned, else Referee Call) disagrees with the scoreboard reading, or `Rally.winner_id` disagrees with the official ruling or scoreboard (without duplicating the same conflict).
  - **Side-out sequence** (`Score called`, `Serving Team`, `Server`, `Returner`, always flagged on Rally `k + 1` only):
    - Game opening score other than `0-0-2`.
    - Adjacent `k → k + 1` score & Serving Team transition (exact match when Rally `k`'s winner is known; 2-outcome Point vs loss check when Unknown).
    - Adjacent `k → k + 1` Serving Team continuity when either score is Unknown.
    - Server and Returner continuity within a service turn (Point keeps Server and flips Returner; Second server flips both).
    - Stacking-safe `even_right[Team]` parity across the Game, reusing the side-out legal serving box tracking.
    - Cross-gap score monotonicity across intermediate Unknown-score Rallies (flags backwards scores or jumps exceeding the Rally span).

Checks never block autosaving, `Enter` (Mark Done), or navigation.

## Saving and undo

Every change autosaves at once through the API. There is no Save button. The status bar shows `Saved`, `Saving…` or `Save failed, retrying`.

`⌘Z` / `⇧⌘Z` undo and redo from an in-memory history for the session. Undo is not in the prototype.

## Keymap

Playback keys are unchanged from the current app (`web/src/lib/keymap.ts`). Plain letters and digits never move the playhead.

This is the Annotate and Review keymap. **Today** marks the inputs that work in the current app (✓). The remaining shortcuts are planned with the Assisted Annotation review (#30). Calibrate's own keys are under [Workspaces](#workspaces). The in-app `?` sheet lists the current shortcuts, Court and Timeline gestures, and the Soft/Hard checklist. Shift combinations are matched by physical key, so `Shift+2` works on any layout.

| Action | Input | Today |
|---|---|---|
| Play / pause (stops at the Rally's end; again replays it until Done) | `Space` | ✓ |
| One frame back / forward | `←` / `→` | ✓ |
| ±1 s / ±10 s | `Shift+←/→` / `Alt+←/→` | ✓ |
| Slower / faster / back to 1× | `[` / `]` / `\` | ✓ |
| Go to frame or time | `/` | ✓ |
| Previous / next Shot (seek to contact) | `↑` / `↓` | ✓ |
| Previous / next Rally (fit and seek to it) | `PgUp` / `PgDn` | ✓ |
| Next / previous rule issue (chronological across Games, wraps around) | `F8` / `Shift+F8` | ✓ (Annotate and Review) |
| Zoom the Timeline | `-` / `=`, vertical scroll or pinch | ✓ |
| Pan the Timeline | Horizontal swipe, `Shift`+scroll, middle-button drag, or scroll on the Overview bar | ✓ |
| Swap Court and Monitor | Backtick (`` ` ``) or **⇄** in either header | ✓ (Annotate and Review) |
| Zoom the Court around the pointer | Scroll or trackpad pinch | ✓ |
| Pan the Court | `Space`+drag or middle-button drag | ✓ |
| Fit the whole playing area | **Fit** or double-click the Court surround | ✓ |
| Move a Rally's start or end (start only when open-ended) | Drag a clip edge on the Rallies track | ✓ in Annotate and Review |
| Move a Play Segment's start or end | Drag a clip edge on the Segments track | ✓ in all workspaces |
| Split Play Segment at playhead | `⌘K`, `Ctrl+K`, or the Play Segment clip menu | ✓ in Calibrate, after the Play Segment's first frame |
| Move field cursor | `Tab` / `Shift+Tab` | ✓ (in Calibrate, `Tab` skips to the next Landmark) |
| Rally start / end at playhead (starts a new open-ended Rally when none is selected or past its end) | `Shift+I` / `Shift+O` | ✓ (in Calibrate: Play Segment start / end) |
| Rally details form (score, Serving Team, Server, Returner, scoreboard, winner in play) | `Shift+S` | ✓ |
| Insert an Unseen Rally after this one | `Shift+U` | ✓ |
| Delete the Rally | `Shift+Backspace` | ✓ |
| Start the next Game | `Shift+Enter` | ✓ |
| Add Shot at playhead (snapshots tracked positions and Settled) | `M` | ✓ |
| Shot Class: Soft / Hard / Lob / Overhead | `S` `H` `L` `O` | ✓ |
| Contact Kind: Volley / Bounce | `V` `B` | ✓ |
| Swap hitter to partner / to the other Team | `X` / `Shift+H` | ✓ (in Calibrate, `X` clears the selected Landmark) |
| Toggle Erne / ATP | `E` / `T` | ✓ |
| Set the selected Shot's landing (ground-plane bounce on mapped frames) | Click Court or Monitor (`Alt`+click Monitor over a Player) | ✓ |
| Error: Net, Out, Kitchen Fault, Double Hit, Body Hit / clear (repeat `5` / `3` cycles the Player) | `1`–`5` / `0` | ✓ (in Calibrate, `1` / `2` set Main / Sideline View) |
| Observation Gap after current Shot (a leading gap before any Shot): odd / even; again removes, the other key flips | `G` / `Shift+G` | ✓ |
| Delete Shot or Observation Gap | `Backspace` | ✓ (in Calibrate: remove the Play Segment) |
| Cycle certainty of focused field | `C` | ✓ (in Calibrate, `C` confirms a Landmark) |
| Referee Call: point / second server / side out (again clears) | `Shift+P` / `Shift+2` / `Shift+X` | ✓ |
| Record a Challenge | `Shift+C` | ✓ |
| Mark Rally Done (Review: accept), go to next | `Enter` | ✓ in Annotate |
| Close a popup or inline form; otherwise cancel Player placement (Annotate), then deselect the Shot, then the Rally | `Esc` | ✓ |
| Next / previous low-confidence field (Review) | `N` / `Shift+N` | planned (in Calibrate, `N` starts a new Calibration) |
| Undo / redo (Rally Log, anchors and Team ends alike) | `⌘Z` / `⇧⌘Z` | ✓ in all workspaces |
| Shortcut sheet | `?` | ✓ |

Premiere's `J/K/L` shuttle is deliberately left out: `L` is Lob, and `Space` plus `[ ]` cover shuttling. Premiere's `I`/`O` move to `Shift+I`/`Shift+O` because `O` is Overhead.

New Shots alternate Teams. Shot 1's hitter defaults to the Rally's Server (else the Serving Team's first Player), Shot 2's to the Returner (else the Receiving Team's first Player), and later Shots' to the first Player of the Team expected to hit, counting odd and even Observation Gaps; all Inferred. `X` picks the partner. Shots 2 and 3 are Inferred to Bounce (the two-bounce rule); the Serve's Contact Kind starts Unknown. New Shots start with no Error and Erne and ATP Observed off. Shot Numbers count 1, 2, ... up to the first Observation Gap and are Unknown after it.

A new Shot snapshots all four Players' positions and Settled facts from Player Tracking (#11) at its contact frame, keeping their certainties, and its Contact Zone follows the hitter's position. Where Tracking hasn't been run, or the frame is unmapped or outside a Play Segment, they stay Unknown: nothing is copied from the previous Shot.

## Visual tokens

These replace the current tokens in `web/src/styles.css` across the whole app.

| Token | Value | Use |
|---|---|---|
| `--app` | `#1a1a1a` | App background, gutters |
| `--panel` | `#232323` | Panel body |
| `--header` | `#2b2b2b` | Panel headers, track headers, table headers |
| `--raised` / `--hover` | `#333333` / `#3b3b3b` | Controls, row hover |
| `--line` / `--line-2` | `#383838` / `#4a4a4a` | Dividers, control borders |
| `--text` / `--dim` / `--faint` | `#e2e2e2` / `#a2a2a2` / `#6c6c6c` | Text levels |
| `--accent` | `#2d8ceb` | Selection, playhead, focus, active workspace, timecode |
| `--team-a` | `#2bb3a3` (teal) | Team A everywhere |
| `--team-b` | `#9b7cf6` (violet) | Team B everywhere |
| `--warn` | `#e8a33d` (amber) | Only low confidence and likely-wrong checks |
| `--fail` | `#ec4c56` (red) | Only broken rules and save failure |
| `--ok` | `#4cb26b` | Saved, Done, within budget |

Type:

- System UI font (SF Pro on macOS), 12 px base, 11 px labels, 10 px uppercase section labels with letter-spacing.
- `ui-monospace` / SF Mono with tabular numbers for frames, timecodes, scores and coordinates.
- No web fonts.

## Out of scope for this design

- Drag-docking panels and saved custom workspaces.
- A light theme or a laptop/responsive layout.
- The dashboard pages (#19, #20). They are a separate product surface and only share the tokens.
