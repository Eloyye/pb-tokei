import { useEffect, useRef } from "react";

const GROUPS: [string, [string[], string][]][] = [
  [
    "Playback",
    [
      [["Space"], "Play / pause"],
      [["←", "→"], "One frame back / forward"],
      [["⇧←", "⇧→"], "±1 second"],
      [["⌥←", "⌥→"], "±10 seconds"],
      [["[", "]"], "Slower / faster"],
      [["\\"], "Back to 1×"],
      [["/"], "Go to a frame or time"],
    ],
  ],
  [
    "Timeline",
    [
      [["-", "="], "Zoom out / in around the playhead"],
      [
        ["Scroll ↑ / ↓", "Pinch"],
        "Zoom at the pointer when paused, or at the playhead while playing or over track headers",
      ],
      [["⇧Scroll", "Swipe ↔"], "Pan the Timeline"],
      [["Scroll on Overview"], "Move the visible window"],
      [["Drag"], "Scrub on the ruler or tracks"],
      [
        ["Drag Rally edge"],
        "Move its start or end in Annotate and Review. Open-ended Rallies have a start handle",
      ],
      [["Drag Play Segment edge"], "Move its start or end in any workspace"],
      [["⌘Z", "⇧⌘Z"], "Undo / redo a Timeline edit in any workspace"],
    ],
  ],
  [
    "Calibrate: Play Segments",
    [
      [["⇧I"], "Start a segment, or move its start here"],
      [["⇧O"], "End the segment, or move its end here"],
      [["1", "2"], "Main View / Sideline View"],
      [["⌫"], "Remove the segment under the playhead"],
      [["Esc"], "Drop a segment not yet ended"],
      [["⌘Z", "⇧⌘Z"], "Undo / redo"],
    ],
  ],
  [
    "Calibrate: Landmarks",
    [
      [["Click"], "Place the highlighted Landmark on the video"],
      [["Drag"], "Move a placed Landmark"],
      [["V"], "Mark the selected Landmark as not visible"],
      [["C"], "Confirm a carried-over Landmark on the current frame"],
      [["Tab"], "Skip to the next Landmark"],
      [["X"], "Clear the selected Landmark"],
      [["N"], "New Calibration from this Play Segment, carrying over the one in effect"],
    ],
  ],
  [
    "Annotate: Rallies",
    [
      [["⇧I"], "Start an open-ended Rally here, or move the selected Rally's start"],
      [["⇧O"], "End the selected Rally here"],
      [["⇧P", "⇧2", "⇧X"], "Referee Call: Point / Second server / Side out (again clears)"],
      [["⇧S"], "Rally details: score, Serving Team, Server, Returner, scoreboard, winner"],
      [["⇧C"], "Challenge: challenger, original call, ruling"],
      [["⇧U"], "Insert an Unseen Rally after this one"],
      [["⇧⌫"], "Delete the selected Rally"],
      [["Enter"], "Mark the Rally Done and go to the next"],
      [["⇧Enter"], "Start the next Game"],
      [["PgUp", "PgDn"], "Previous / next Rally"],
      [["F8", "⇧F8"], "Next / previous rule issue"],
      [["Space"], "Play; pauses at the Rally's end (again replays it until Done)"],
    ],
  ],
  [
    "Annotate: Shots",
    [
      [["M"], "Add a Shot here, with Players' tracked positions and Settled"],
      [["↑", "↓"], "Previous / next Shot"],
      [["S", "H", "L", "O"], "Shot Class: Soft / Hard / Lob / Overhead"],
      [["V", "B"], "Contact Kind: Volley / Bounce"],
      [["X", "⇧H"], "Hitter: partner / other Team"],
      [["E", "T"], "Erne / ATP"],
      [["1", "2", "3", "4", "5"], "Error: Net, Out, Kitchen Fault, Double Hit, Body Hit"],
      [["5 5", "3 3"], "Again: cycle the hit opponent / the faulting Player"],
      [["0"], "Clear the Error"],
      [["G", "⇧G"], "Odd / even Observation Gap after this Shot (again removes)"],
      [["⌫"], "Delete the selected Shot or gap"],
      [["Click court"], "Set the landing"],
      [["Drag dot"], "Fix this Shot's position (no Calibration needed)"],
      [["Tab", "⇧Tab"], "Move the field cursor"],
      [["C"], "Cycle the field's certainty: Observed → Inferred → Unknown"],
      [["Esc"], "Close a form, or deselect the Shot then the Rally"],
      [["⌘Z", "⇧⌘Z"], "Undo / redo"],
    ],
  ],
  [
    "Soft or Hard?",
    [
      [
        ["Soft"],
        "Descending as it crosses the net and landing (or, for a Volley, would land) in the opponent's Frontcourt",
      ],
      [["Hard"], "Anything else that isn't a Lob or Overhead"],
    ],
  ],
  [
    "Players (Calibrate & Annotate)",
    [
      [["Click box"], "Bind the selected Player to a detected person (auto-advances)"],
      [
        ["Drag dot"],
        "Override a Player's foot position on the Monitor (or Court, with no Shot selected)",
      ],
      [["⌘Z", "⇧⌘Z"], "Undo / redo anchor and end-change edits"],
    ],
  ],
  [
    "App",
    [
      [["?"], "This sheet"],
      [["Esc"], "Close"],
    ],
  ],
];

/** The shortcuts and Timeline gestures that work today. */
export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog ref={dialogRef} className="sheet-card" aria-labelledby="sheet-title" onClose={onClose}>
      <header>
        <h2 id="sheet-title">Keyboard shortcuts</h2>
        <button type="button" className="button" onClick={onClose}>
          Close <kbd>Esc</kbd>
        </button>
      </header>
      <div className="sheet-grid">
        {GROUPS.map(([title, keys]) => (
          <div key={title}>
            <h3>{title}</h3>
            <dl>
              {keys.map(([combo, action]) => (
                <div key={action} style={{ display: "contents" }}>
                  <dt>
                    {combo.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </dialog>
  );
}
