import { type FormEvent, useEffect, useRef, useState } from "react";
import { deleteMatch, type MatchDetail } from "../api/client";
import { formatOperatorDuration } from "../lib/operatorTime";
import { teamsLabel } from "./teams";

function isPathInsideDir(filePath: string, dirPath: string): boolean {
  const normalizedDir = dirPath.replace(/[\\/]+$/, "");
  if (!normalizedDir) {
    return filePath.startsWith("/") || filePath.startsWith("\\");
  }
  return filePath.startsWith(`${normalizedDir}/`) || filePath.startsWith(`${normalizedDir}\\`);
}

/**
 * Confirmation dialog for hard-deleting a Match. Lists what will be lost, notes where footage
 * files stay on disk, and requires typing the Tournament name when the Match has any Rallies.
 */
export function DeleteMatchDialog({
  match,
  rallyLog,
  onClose,
  onDeleted,
}: {
  match: MatchDetail;
  rallyLog: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsName = match.total_rallies > 0;
  const confirmed = !needsName || typed === match.tournament;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (needsName) inputRef.current?.focus();
  }, [needsName]);

  const ralliesText = `${match.total_rallies} ${match.total_rallies === 1 ? "Rally" : "Rallies"}`;
  const durationText = formatOperatorDuration(match.operator_time.active_seconds);
  const summary = `Delete ${match.tournament} · ${teamsLabel(match)}: ${ralliesText}, ${durationText} of operator time. This can't be undone.`;
  const extraVideoNote =
    match.source_video_path !== null && !isPathInsideDir(match.source_video_path, match.footage_dir)
      ? ` (and ${match.source_video_path})`
      : "";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deleting || !confirmed) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteMatch(match.id, { rallyLog });
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDeleting(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="sheet-card edit-dialog danger-dialog"
      aria-labelledby="delete-match-title"
      onClose={onClose}
      onCancel={(event) => {
        if (deleting) event.preventDefault();
      }}
    >
      <header>
        <h2 id="delete-match-title">Delete Match</h2>
        <button type="button" className="button" onClick={onClose} disabled={deleting}>
          Cancel
        </button>
      </header>
      <form className="edit-dialog-body" onSubmit={(event) => void handleSubmit(event)}>
        <p className="delete-match-summary">{summary}</p>
        <p className="edit-dialog-scope">
          Footage files in <span className="mono">{match.footage_dir}</span>
          {extraVideoNote && <span className="mono">{extraVideoNote}</span>} and the Player Tracking
          cache are kept.
        </p>

        {needsName && (
          <label className="new-match-field">
            <span>
              Type <strong>{match.tournament}</strong> to confirm
            </span>
            <input
              ref={inputRef}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={deleting}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}

        {error && (
          <p className="new-match-error" role="alert">
            {error}
          </p>
        )}

        <div className="edit-dialog-actions">
          <button type="submit" className="button danger" disabled={deleting || !confirmed}>
            {deleting ? "Deleting Match…" : "Delete Match"}
          </button>
          <button type="button" className="button" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
