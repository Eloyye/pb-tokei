import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { openRallyLog, type RallyLogInfo } from "../api/client";
import { flushOperatorTimeBeforeSwitch, waitUntilSaved } from "../lib/unsavedChanges";
import { announceRallyLogSwitch, rallyLogFileName, rallyLogFolder } from "./rallyLog";

/**
 * Switches the app to another Rally Log, or a new one, without restarting the server. Queued
 * saves land first; then the app goes Home on the new Rally Log and other tabs are told.
 */
export function RallyLogPicker({
  rallyLog,
  onClose,
}: {
  rallyLog: RallyLogInfo | undefined;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openPath = rallyLog?.path ?? null;
  const [field, setField] = useState(() => (openPath === null ? "" : rallyLogFolder(openPath)));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    // showModal focuses the first button; the path field is what the operator types into.
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, []);

  const choose = async (path: string, create: boolean) => {
    setError(null);
    try {
      setBusy("Saving changes…");
      await waitUntilSaved();
      setBusy(create ? "Creating…" : "Opening…");
      await flushOperatorTimeBeforeSwitch();
      const info = await openRallyLog(path.trim(), create);
      announceRallyLogSwitch();
      queryClient.setQueryData(["rally-log"], info);
      await navigate({ to: "/" });
      await queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== "rally-log" });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;
  const hasPath = field.trim() !== "";

  return (
    <dialog
      ref={dialogRef}
      className="sheet-card picker-card"
      aria-labelledby="picker-title"
      onClose={onClose}
      onCancel={(event) => {
        if (disabled) event.preventDefault();
      }}
    >
      <header>
        <h2 id="picker-title">Rally Log</h2>
        <button type="button" className="button" onClick={onClose} disabled={disabled}>
          Close <kbd>Esc</kbd>
        </button>
      </header>
      <div className="picker-body">
        <p className="picker-open">
          {openPath === null ? (
            "No Rally Log is open. Open one, or make a new one."
          ) : (
            <>
              Open: <span className="mono">{openPath}</span>
            </>
          )}
        </p>

        {rallyLog && rallyLog.recent.length > 0 && (
          <section>
            <h3>Recent</h3>
            <ul className="picker-recent">
              {rallyLog.recent.map((recent) => {
                const isOpen = recent.path === openPath;
                return (
                  <li key={recent.path}>
                    <button
                      type="button"
                      title={recent.path}
                      disabled={disabled || isOpen || !recent.exists}
                      onClick={() => void choose(recent.path, false)}
                    >
                      <span className="mono">{rallyLogFileName(recent.path)}</span>
                      <span className="picker-folder">{rallyLogFolder(recent.path)}</span>
                      {isOpen ? (
                        <span className="pill pill-ready">open</span>
                      ) : !recent.exists ? (
                        <span className="pill pill-missing">missing</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (hasPath) void choose(field, false);
          }}
        >
          <h3>
            <label htmlFor="rally-log-path">Path</label>
          </h3>
          <input
            ref={inputRef}
            id="rally-log-path"
            className="picker-path mono"
            value={field}
            onChange={(event) => setField(event.target.value)}
            placeholder="/path/to/rally_log.duckdb"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
          />
          <div className="picker-actions">
            <button type="submit" className="button" disabled={disabled || !hasPath}>
              Open
            </button>
            <button
              type="button"
              className="button"
              disabled={disabled || !hasPath}
              onClick={() => void choose(field, true)}
            >
              New Rally Log
            </button>
            {busy && <span className="picker-busy">{busy}</span>}
          </div>
          <p className="picker-hint">
            A relative path starts from the open Rally Log's folder. New Rally Log makes an empty
            one at the path and adds <code>.duckdb</code> if needed.
          </p>
        </form>
        {error && (
          <p className="picker-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
