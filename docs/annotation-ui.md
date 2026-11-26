# Annotation app UI

The layout, look and interaction model of the annotation app (`pb-tokei annotate`). Every annotation frontend feature builds on it: Calibration and Play Segments (#10), Player positions (#11), Rally and Shot entry (#12), rule checks (#13), operator time (#14) and the Assisted Annotation review (#30).

A clickable prototype with sample data and working keys lives in [design/annotation-prototype.html](design/annotation-prototype.html). Where this document and the prototype disagree, this document wins.

## Principles

- **Premiere-style editor.** Dense, dark, panel-based. It is a pro tool used for hours, not a web form.
- **Rally by Rally.** The operator works on one Rally at a time and moves to the next with one key. The timeline gives orientation across the whole Game.
- **Keyboard first, modeless.** Letter keys always act on the current Shot, so there is no edit mode to enter. The mouse is only for the court diagram (landing spots, position fixes) and for navigation.
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
- **Resizing.** Three splitters: right column width, bottom row height, and Rallies panel width. Sizes are remembered per browser in `localStorage`. There is no drag-docking.
- **Status bar** (24 px), left to right:
  - save state
  - the last action or hint
  - in Review only, the confidence threshold slider
  - `Active m:ss` or `Active h:mm:ss`, dimmed while idle. Hover to see the Calibrate, Annotate, and Review totals.
  - `Ratio 0.19`, with the full broadcast length in its tooltip. In Assisted mode or Review, it shows `Ratio 0.19 / 0.25` in green within budget or amber over it. A known broadcast length and zero active time show `0.00`. An unknown broadcast length shows `—`.
  - issue counts, red and amber
  - the `?` hint

- **Rally Log picker.** A modal opened from the Rally Log's name. It shows the open Rally Log and up to 10 recent ones (the open one and missing files can't be chosen; missing files carry an amber `missing` pill). It has a path field, prefilled with the open Rally Log's folder, with **Open** and **New Rally Log** buttons. Choosing one waits for queued saves ("Saving changes…"), and refuses with the save's error if any save is retrying or was refused. After saves land, the picker gives the operator time flush up to two seconds before opening the Rally Log. On success the app goes Home on the new Rally Log. The picker opens by itself when no Rally Log is open, and the header then reads `No Rally Log` in amber. When another tab has switched the Rally Log, the name becomes an amber **Rally Log switched elsewhere: reload**.

## Workspaces

The workspace tabs are how the operator switches jobs. All three tabs use the same frame.

| Workspace | Right column | Timeline | Notes |
|---|---|---|---|
| **Calibrate** (#10, #11, #51) | Two tabs: **Landmarks** and **Players**. Under **Landmarks**: the Calibration in effect at the playhead (mini court, 12-Landmark checklist with leave-one-out errors in feet, Camera Motion status and clickable unmapped ranges with one-click re-anchoring), then every Calibration of each Camera View (click to seek, × to delete, **Use here**). Under **Players**: explicit **Track Players** / **Cancel** with progress %, active compute device badge (`MPS` / `CUDA` / `CPU`), and per-segment status (prioritising the Play Segment under the playhead first); 4-Player checklist showing Zone, Settled, certainty, and active selection; 1-click **Swap A**, **Swap B**, and **Swap ends** buttons acting from the playhead forward; interactive Court diagram preview; and clickable lists of anchors and end changes (click to seek, × to delete) | Segments track editable (with amber hatching on unmapped Camera Motion ranges); Issues track shows clickable amber bars for unmapped ranges; Rallies and Shots dimmed | Under **Landmarks**: Landmarks are clicked on the Monitor with a 4× magnifier and lens-corrected court template; `Tab` skips, `V` marks not visible, `C` confirms carried-over clicks, `X` clears, `N` starts a new Calibration. Under **Players**: detected person boxes, foot dots, and Player labels render over the Monitor for 1-click/1-drag anchoring (see [Player positions and anchoring](#player-positions-and-anchoring)). Play Segment keys (`Shift+I`/`Shift+O`, `1`/`2`, `Backspace`, `Esc`, and edge drags) work on both tabs. |
| **Annotate** (#11, #12, Gold) | Live Court diagram (with tracked Player dots and drag-to-place fixes) + Inspector | All tracks | Monitor header includes a toggleable **Players** overlay (boxes, foot dots, labels) plus quick **Swap A**, **Swap B**, and **Swap ends** controls. Unified 1-click/drag fixes work directly on the Monitor and Court diagram with `⌘Z` / `⇧⌘Z` undo/redo (no letter/digit key conflicts with #12). `Enter` marks the Rally Done (#12). |
| **Review** (#30, Assisted) | Court + Inspector | All tracks; Shot markers with low-confidence fields get an amber dot | Low-confidence fields get an amber outline and a percentage. `N`/`Shift+N` move between them. `Enter` accepts the Rally. Threshold slider in the status bar. |

Each key's meaning is set by the workspace. The same key never does two things in one workspace.

## Home

A separate screen: a dense table of Matches with these columns:

- Tournament
- Match (Teams with color swatches)
- Franchise Match
- Video
- Mode (Gold or Assisted pill)
- Progress (#12, Rallies Done out of total, with a bar)
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

Playback pauses at the current Rally's end frame. Seeking outside the Rally is allowed so its bounds can be moved.

## Court diagram

A top-down court in the right column. The near end, at the bottom, is the Main View camera's end, so it lines up with the video.

- Zone bands are shaded: Frontcourt 0–9 ft, Midcourt 9–18 ft, Backcourt 18 ft and beyond. Dashed lines mark 9 and 18 ft, ticks outside the sidelines mark 12 ft (the Established rule), and the side labels read FC / MC / BC.
- **Players at the current Shot.** Four dots in Team colors with initials:
  - The hitter has a white ring.
  - An Inferred position is drawn at reduced opacity.
  - An Unknown position is drawn as a hollow dashed dot parked outside the court.
  - Dragging a dot fixes the position and makes it Observed.
- **Previous Shot.** Its positions are drawn as faint ghosts for context.
- **Landing.** Clicking the court sets the landing, shown as a ✕ in the hitter's Team color with a dashed arc from the hitter.
- Clicks on the video do nothing until calibration exists. After that they map through the Camera View calibration.

## Player positions and anchoring (#11)

Both `Calibrate → Players` and `Annotate` share one click/drag correction model backed by `player_anchors` and `team_ends` in the Rally Log (ADR 0012):

- **Click inside a detected person box on the Monitor** binds the selected Player to that detection (`kind = identity`), snaps to their detected ankles, seeds `team_ends` if none is set yet, and auto-advances selection through unanchored Players.
- **Drag any Player's foot dot on the Monitor or Court diagram** (or click empty court when placing an undetected Player) saves a `kind = position` anchor directly at the drop coordinates without snapping back to a bad detection box, and re-attaches tracking from there.
- **Swap A / Swap B / Swap ends** act from the playhead forward, writing coordinate anchors (partner swaps) or `team_ends` records (end swaps) that survive cache rebuilds.
- **Live Court display:** Team colours (`--team-a`, `--team-b`) with initials, full opacity for `Observed`, reduced opacity for `Inferred`, hollow dashed dots parked outside the court for `Unknown`, and near/far Team labels driven by `team_ends`.
- Every anchor and `team_ends` edit autosaves and participates in `⌘Z` / `⇧⌘Z` undo/redo in both `Calibrate` and `Annotate`.

## Inspector

Two tabs: **Shot** and **Rally**. Setting a field switches to the tab that owns it.

The title shows the Shot or Rally, its frame and timecode, and counts. When a Shot follows an Observation Gap, the title says its number is unknown.

Each row has three parts: label, value, then key hints on the right. A key hint lights up when it matches the current value.

**Shot tab**

- Recorded:
  - Hitter (`X` swaps to the partner)
  - Shot Class (`S H L O`)
  - Contact Kind (`V B`)
  - Contact Zone (from the hitter's position)
  - Erne (`E`)
  - ATP (`T`)
  - Landing (click the court)
  - Error (`1`–`5`, `0` clears; the Error's Player defaults to the hitter)
- Positions at contact: one row per Player.
- Derived, computed and never stored: Shot Type, Rally Phase, Team Status.

**Rally tab**

- Frames (`Shift+I` / `Shift+O`)
- Score called, Serving Team, Server, Returner (pre-filled from side-out logic)
- Referee Call (`Shift+P` / `Shift+2` / `Shift+X`)
- Challenge (`Shift+C` opens an inline form: challenger, original call, ruling)
- Winner, with its source: Challenge, Referee Call, scoreboard, next Serve, or seen in play
- Scoreboard reading
- Status
- Shot issues in this Rally

**Field cursor.** The last field set keeps focus (blue row highlight). `Tab` / `Shift+Tab` move it. `C` acts on it. No other key depends on the cursor.

## Facts: Observed, Inferred, Unknown

One rule, used everywhere:

| Certainty | Look |
|---|---|
| Observed | Plain value in normal text color |
| Inferred | Italic, dimmed, with a small `inf` tag |
| Unknown | The word "Unknown" in a dashed empty slot |

`C` cycles the focused field: Observed → Inferred → Unknown → Observed. Going to Unknown clears the value, as the Rally Log requires. Coming back restores the stashed value.

Model confidence (Review only) is a separate channel: an amber outline and a percentage. Certainty and confidence never share a visual channel.

## Rallies panel

Rallies are grouped by Game. Each row shows:

- status: ○ Empty, ● In progress, ✓ Done
- Rally number
- the Serving Team's color swatch
- the score called (dashed swatch and "—" when Unknown)
- red and amber issue counts

The panel header shows Done out of total. Clicking a row, or `PgUp`/`PgDn`, moves to that Rally and fits the timeline to it.

Status rules:

- A Rally becomes In progress on its first edit.
- `Enter` marks it Done and moves to the next Rally.
- Done never locks editing.

## Timeline

- **Header.** Zoom out and in around the playhead (`-` / `=`) and Fit Rally.
- **Overview bar.** The whole Game: Rally blocks in the Serving Team's color, the visible window outlined in blue, and the playhead. Click to jump or scroll in any direction to pan at the same scale as the lanes.
- **Ruler.** HH:MM:SS:FF ticks, with the tick step chosen from the zoom. The blue playhead has a head on the ruler. Click or drag on the ruler or any lane to scrub.
- **Track headers** on the left, Premiere-style, with the current timecode above them.
- **Zoom.** Scroll up to zoom in and down to zoom out, or pinch. Over the ruler and lanes, zoom follows the pointer while paused. During playback or over the track headers and timecode, zoom follows the playhead.
- **Pan.** Swipe horizontally or hold `Shift` while scrolling. During playback, the view follows the playhead again on the next frame.
- During a scrub or Play Segment edge drag, the drag follows the frame under the pointer after zooming or panning.
- **Tracks:**
  - **Segments.** Play Segments colored by Camera View (Main blue-gray, Sideline brown). Editable only in Calibrate.
  - **Rallies.** One clip per Rally in the Serving Team's color, labeled with status, number and score. The current clip is outlined.
  - **Shots.** A pin per Shot in the hitter's Team color, labeled with its Shot Number (`?` after an Observation Gap). The current Shot has a white ring. Observation Gaps appear as hatched dashed boxes ("odd gap" / "even gap").
  - **Issues.** A triangle at the offending Shot, or a bar across the Rally for Rally-level issues. Red or amber; hover shows the message.
  - Space is reserved for an audio waveform track later (#26).
- Entering a Rally zooms to it with 8% padding. During playback the view pages along with the playhead.

## Rule checks (#13)

Each check shows in three linked places:

1. a marker on the Issues track
2. a badge with the message under the Inspector field it concerns
3. counts in the Rallies row and the status bar

- **Red** means a rule is definitely broken:
  - Teams don't alternate (accounting for odd and even Observation Gaps)
  - Shot 2 or 3 is a Volley
  - a Volley from inside the kitchen
- **Amber** means likely wrong:
  - the Referee Call disagrees with the scoreboard
  - the Serve isn't hit by the Server
  - the score sequence breaks side-out rules (not in the prototype)

Checks never block saving or `Enter`.

## Saving and undo

Every change autosaves at once through the API. There is no Save button. The status bar shows `Saved`, `Saving…` or `Save failed, retrying`.

`⌘Z` / `⇧⌘Z` undo and redo from an in-memory history for the session. Undo is not in the prototype.

## Keymap

Playback keys are unchanged from the current app (`web/src/lib/keymap.ts`). Plain letters and digits never move the playhead.

This is the Annotate and Review keymap. **Today** marks the inputs that work in the current app (✓). The remaining shortcuts are planned with Rally and Shot entry (#12) and the Assisted Annotation review (#30). Calibrate's own keys are under [Workspaces](#workspaces). The in-app `?` sheet lists the current shortcuts and Timeline gestures.

| Action | Input | Today |
|---|---|---|
| Play / pause (stops at the Rally's end) | `Space` | ✓ (stopping at the Rally's end is planned) |
| One frame back / forward | `←` / `→` | ✓ |
| ±1 s / ±10 s | `Shift+←/→` / `Alt+←/→` | ✓ |
| Slower / faster / back to 1× | `[` / `]` / `\` | ✓ |
| Go to frame or time | `/` | ✓ |
| Previous / next Shot (seek to contact) | `↑` / `↓` | planned |
| Previous / next Rally | `PgUp` / `PgDn` | planned |
| Zoom the Timeline | `-` / `=`, vertical scroll or pinch | ✓ |
| Pan the Timeline | Horizontal swipe, `Shift`+scroll, or scroll on the Overview bar | ✓ |
| Move field cursor | `Tab` / `Shift+Tab` | planned (in Calibrate, `Tab` skips to the next Landmark) |
| Rally start / end at playhead | `Shift+I` / `Shift+O` | planned (in Calibrate: Play Segment start / end) |
| Add Shot at playhead | `M` | planned |
| Shot Class: Soft / Hard / Lob / Overhead | `S` `H` `L` `O` | planned |
| Contact Kind: Volley / Bounce | `V` `B` | planned |
| Swap hitter to partner | `X` | planned (in Calibrate: clear the selected Landmark) |
| Toggle Erne / ATP | `E` / `T` | planned |
| Error: Net, Out, Kitchen Fault, Double Hit, Body Hit / clear | `1`–`5` / `0` | planned (in Calibrate, `1` / `2` set Main / Sideline View) |
| Observation Gap after current Shot: odd / even | `G` / `Shift+G` | planned |
| Delete Shot | `Backspace` | planned (in Calibrate: remove the Play Segment) |
| Cycle certainty of focused field | `C` | planned |
| Referee Call: point / second server / side out | `Shift+P` / `Shift+2` / `Shift+X` | planned |
| Record a Challenge | `Shift+C` | planned |
| Mark Rally Done (Review: accept), go to next | `Enter` | planned |
| Next / previous low-confidence field (Review) | `N` / `Shift+N` | planned (in Calibrate, `N` starts a new Calibration) |
| Undo / redo | `⌘Z` / `⇧⌘Z` | ✓ in Calibrate and Annotate |
| Shortcut sheet | `?` | ✓ |

Premiere's `J/K/L` shuttle is deliberately left out: `L` is Lob, and `Space` plus `[ ]` cover shuttling. Premiere's `I`/`O` move to `Shift+I`/`Shift+O` because `O` is Overhead.

New Shots alternate Teams. A new Shot's hitter is the first Player of the other Team, and `X` picks the partner. Its positions are copied from the previous Shot as Inferred.

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
