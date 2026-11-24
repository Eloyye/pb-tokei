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
      [["Drag"], "Scrub on the ruler or tracks"],
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
      [["Drag"], "Move a segment's edge on the Segments track"],
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
    "App",
    [
      [["?"], "This sheet"],
      [["Esc"], "Close"],
    ],
  ],
];

/** Every key that works today. Rally and Shot keys are added as those features land. */
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
