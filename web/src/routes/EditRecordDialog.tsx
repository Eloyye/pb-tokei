import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type ExactNameConflict,
  type Handedness,
  mergeFranchise,
  mergePlayer,
  mergeTournament,
  type Tour,
  updateFranchise,
  updatePlayer,
  updateTournament,
} from "../api/client";

export type EditableRecord =
  | { kind: "player"; id: string; name: string; handedness: Handedness }
  | { kind: "tournament"; id: string; name: string; tour: Tour }
  | { kind: "franchise"; id: string; name: string };

const TOURS: Tour[] = ["ppa", "app", "mlp"];

const KIND_LABELS: Record<EditableRecord["kind"], string> = {
  player: "Player",
  tournament: "Tournament",
  franchise: "Franchise",
};

type Step =
  | { stage: "edit" }
  | { stage: "confirm-edit"; affectedMatches: number }
  | { stage: "conflict"; conflict: ExactNameConflict; message: string }
  | { stage: "confirm-merge"; conflict: ExactNameConflict; affectedMatches: number };

function otherMatchesNote(affectedMatches: number): string {
  const others = Math.max(0, affectedMatches - 1);
  if (others === 0) return "Only affects this Match.";
  return `Also changes ${others} other ${others === 1 ? "Match" : "Matches"}.`;
}

/**
 * Dialog for editing or merging a Player, Tournament, or Franchise across every Match that uses
 * it. Always runs a server dry run first so the operator sees the affected Match count before
 * confirming, and offers Merge when renaming to another record's exact name.
 */
export function EditRecordDialog({
  record,
  rallyLog,
  onClose,
  onSaved,
}: {
  record: EditableRecord;
  rallyLog: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(record.name);
  const [handedness, setHandedness] = useState<Handedness>(
    record.kind === "player" ? record.handedness : "right",
  );
  const [tour, setTour] = useState<Tour>(record.kind === "tournament" ? record.tour : "ppa");
  const [step, setStep] = useState<Step>({ stage: "edit" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const kindLabel = KIND_LABELS[record.kind];
  const trimmedName = name.trim();
  const changed =
    trimmedName !== record.name ||
    (record.kind === "player" && handedness !== record.handedness) ||
    (record.kind === "tournament" && tour !== record.tour);

  async function runEdit(dryRun: boolean) {
    const opts = { dryRun, rallyLog };
    if (record.kind === "player") {
      return updatePlayer(record.id, { name: trimmedName, handedness }, opts);
    }
    if (record.kind === "tournament") {
      return updateTournament(record.id, { name: trimmedName, tour }, opts);
    }
    return updateFranchise(record.id, { name: trimmedName }, opts);
  }

  async function runMerge(intoId: string, dryRun: boolean) {
    const opts = { dryRun, rallyLog };
    if (record.kind === "player") return mergePlayer(record.id, { into: intoId }, opts);
    if (record.kind === "tournament") return mergeTournament(record.id, { into: intoId }, opts);
    return mergeFranchise(record.id, { into: intoId }, opts);
  }

  async function handleReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!trimmedName) {
      setError(`Enter a ${kindLabel} name.`);
      return;
    }
    if (!changed) {
      setError("Make a change before saving.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const preview = await runEdit(true);
      setStep({ stage: "confirm-edit", affectedMatches: preview.affected_matches });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && caught.conflict) {
        setStep({ stage: "conflict", conflict: caught.conflict, message: caught.message });
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmEdit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await runEdit(false);
      onSaved(`Updated ${kindLabel} "${trimmedName}".`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handlePreviewMerge(conflict: ExactNameConflict) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const preview = await runMerge(conflict.id, true);
      setStep({
        stage: "confirm-merge",
        conflict,
        affectedMatches: preview.affected_matches,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmMerge(conflict: ExactNameConflict) {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await runMerge(conflict.id, false);
      onSaved(`Merged ${kindLabel} "${record.name}" into "${conflict.name}".`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const clearingFranchiseMatches =
    record.kind === "tournament" && record.tour === "mlp" && tour !== "mlp";

  return (
    <dialog
      ref={dialogRef}
      className="sheet-card edit-dialog"
      aria-labelledby="edit-record-title"
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header>
        <h2 id="edit-record-title">
          Edit {kindLabel}: {record.name}
        </h2>
        <button type="button" className="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </header>
      <div className="edit-dialog-body">
        <p className="edit-dialog-scope">
          Changes every Match in this Rally Log that uses this {kindLabel}.
        </p>

        {step.stage === "edit" && (
          <form onSubmit={(event) => void handleReview(event)} noValidate>
            <div className="edit-dialog-fields">
              <label className="new-match-field">
                Name
                <input
                  ref={inputRef}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setError(null);
                  }}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>

              {record.kind === "player" && (
                <label className="new-match-field">
                  Handedness
                  <select
                    value={handedness}
                    onChange={(event) => {
                      setHandedness(event.target.value as Handedness);
                      setError(null);
                    }}
                    disabled={busy}
                  >
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                  </select>
                </label>
              )}

              {record.kind === "tournament" && (
                <label className="new-match-field">
                  Tour
                  <select
                    value={tour}
                    onChange={(event) => {
                      setTour(event.target.value as Tour);
                      setError(null);
                    }}
                    disabled={busy}
                  >
                    {TOURS.map((item) => (
                      <option key={item} value={item}>
                        {item.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {error && (
              <p className="new-match-error" role="alert">
                {error}
              </p>
            )}

            <div className="edit-dialog-actions">
              <button type="submit" className="button primary" disabled={busy || !changed}>
                {busy ? "Checking…" : "Continue"}
              </button>
              <button type="button" className="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {step.stage === "confirm-edit" && (
          <div className="edit-dialog-confirm">
            <p className="edit-dialog-warning">
              {otherMatchesNote(step.affectedMatches)}
              {clearingFranchiseMatches &&
                " Changing this Tournament away from MLP clears Franchise Matches on its Matches."}
            </p>
            <p>
              Update {kindLabel} <strong>{record.name}</strong>
              {trimmedName !== record.name && (
                <>
                  {" "}
                  to <strong>{trimmedName}</strong>
                </>
              )}
              {record.kind === "player" && handedness !== record.handedness && (
                <> ({handedness}-handed)</>
              )}
              {record.kind === "tournament" && tour !== record.tour && <> ({tour.toUpperCase()})</>}
              ?
            </p>

            {error && (
              <p className="new-match-error" role="alert">
                {error}
              </p>
            )}

            <div className="edit-dialog-actions">
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void handleConfirmEdit()}
              >
                {busy ? "Saving…" : "Confirm"}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep({ stage: "edit" });
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {step.stage === "conflict" && (
          <div className="edit-dialog-confirm">
            <p className="new-match-error" role="alert">
              {step.message}
            </p>
            <p>
              To combine them, merge <strong>{record.name}</strong> into{" "}
              <strong>{step.conflict.name}</strong> instead.
            </p>

            {error && (
              <p className="new-match-error" role="alert">
                {error}
              </p>
            )}

            <div className="edit-dialog-actions">
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void handlePreviewMerge(step.conflict)}
              >
                {busy ? "Checking…" : `Merge into "${step.conflict.name}"`}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep({ stage: "edit" });
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {step.stage === "confirm-merge" && (
          <div className="edit-dialog-confirm">
            <p className="edit-dialog-warning">
              Affects {step.affectedMatches} {step.affectedMatches === 1 ? "Match" : "Matches"}.{" "}
              {otherMatchesNote(step.affectedMatches)}
            </p>
            <p>
              Merge <strong>{record.name}</strong> into <strong>{step.conflict.name}</strong> and
              delete <strong>{record.name}</strong>? This can't be undone.
            </p>

            {error && (
              <p className="new-match-error" role="alert">
                {error}
              </p>
            )}

            <div className="edit-dialog-actions">
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => void handleConfirmMerge(step.conflict)}
              >
                {busy ? "Merging…" : `Confirm Merge into "${step.conflict.name}"`}
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep({ stage: "edit" });
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
