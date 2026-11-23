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
