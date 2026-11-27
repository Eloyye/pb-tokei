import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import {
  ApiError,
  getTabRallyLog,
  isRetryable,
  listMatches,
  type Match,
  type MatchDetail,
  updateMatch,
} from "../api/client";
import {
  formatActiveTime,
  formatRatio,
  operatorTimeTitle,
  ratioClassName,
} from "../lib/operatorTime";
import { useOpenRallyLogPicker } from "../shell/rallyLog";
import { compareMatches, franchisesLabel, isValidMatchDate, teamsLabel, videoPill } from "./teams";

const POLL_MS = 1000;

export function MatchList() {
  const openPicker = useOpenRallyLogPicker();
  const queryClient = useQueryClient();
  const [dateError, setDateError] = useState<{ matchId: string; message: string } | null>(null);
  const matches = useQuery({
    queryKey: ["matches"],
    queryFn: listMatches,
    retry: (failures, error) => failures < 3 && isRetryable(error),
    refetchInterval: (query) =>
      query.state.data?.some(
        (m) =>
          m.footage_job &&
          (m.footage_job.state === "queued" ||
            m.footage_job.state === "downloading" ||
            m.footage_job.state === "converting"),
      )
        ? POLL_MS
        : false,
  });

  if (matches.isPending) return <p className="notice">Loading Matches…</p>;
  if (matches.isError) {
    // 409: no Rally Log is open yet, or another tab has switched it.
    const conflict = matches.error instanceof ApiError && matches.error.status === 409;
    return (
      <p className="notice error">
        {matches.error.message}
        {conflict && (
          <>
            {" "}
            <button type="button" className="button" onClick={openPicker}>
              Choose a Rally Log
            </button>
          </>
        )}
      </p>
    );
  }

  function handleDateSaved(updated: Match) {
    setDateError((current) => (current?.matchId === updated.id ? null : current));
    queryClient.setQueryData<Match[]>(["matches"], (current) =>
      current?.map((item) => (item.id === updated.id ? updated : item)).toSorted(compareMatches),
    );
    queryClient.setQueryData<MatchDetail>(
      ["matches", updated.id],
      (current) => current && { ...current, ...updated },
    );
  }

  function handleDateError(matchId: string, message: string | null) {
    setDateError((current) => {
      if (message === null) return current?.matchId === matchId ? null : current;
      return { matchId, message };
    });
  }

  const activeDateError =
    dateError && matches.data.some((m) => m.id === dateError.matchId) ? dateError : null;
  const [firstMatch] = matches.data;
  return (
    <main className="home">
      <div className="home-head">
        <div className="match-list-title">
          <h1>Matches</h1>
          <span className="mono">{matches.data.length}</span>
        </div>
        <Link to="/matches/new" className="button primary">
          New Match
        </Link>
      </div>
      {activeDateError && (
        <p className="match-list-error" role="alert">
          {activeDateError.message}
        </p>
      )}
      {matches.data.length === 0 ? (
        <p className="notice">No Matches yet.</p>
      ) : (
        <div className="match-table">
          <div className="tr thead">
            <span>Date</span>
            <span>Tournament</span>
            <span>Match</span>
            <span>Franchise Match</span>
            <span>Video</span>
            <span>Mode</span>
            <span>Progress</span>
            <span className="number">Active</span>
            <span className="number">Ratio</span>
          </div>
          {matches.data.map((match) => {
            const pill = videoPill(match);
            const assisted = match.annotation_mode === "assisted";
            const budget = assisted ? match.assisted_ratio_budget : null;
            const rowError = activeDateError?.matchId === match.id ? activeDateError.message : null;
            return (
              <div key={match.id} className="tr">
                <MatchDateCell
                  match={match}
                  error={rowError}
                  onSaved={handleDateSaved}
                  onError={handleDateError}
                />
                <Link
                  to="/matches/$matchId/$workspace"
                  params={{ matchId: match.id, workspace: "annotate" }}
                  className="match-row-main"
                >
                  <span className="dimmed">{match.tournament}</span>
                  <span className="teams-cell">
                    <span className="swatch team-a" />
                    {match.team_a.join(" / ")}
                    <span className="vs">vs</span>
                    <span className="swatch team-b" />
                    {match.team_b.join(" / ")}
                  </span>
                  <span className="dimmed">{franchisesLabel(match) ?? "—"}</span>
                  <span>
                    <span className={pill.className}>{pill.label}</span>
                  </span>
                  <span>
                    <span className={`pill ${assisted ? "pill-active" : "pill-none"}`}>
                      {assisted ? "Assisted" : "Gold"}
                    </span>
                  </span>
                  <Progress done={match.done_rallies} total={match.total_rallies} />
                  <span
                    className="number mono dimmed"
                    title={operatorTimeTitle(match.operator_time)}
                  >
                    {formatActiveTime(match.operator_time.active_seconds)}
                  </span>
                  <span
                    className={`number mono ${ratioClassName(match.operator_time_ratio, budget)}`}
                  >
                    {formatRatio(match.operator_time_ratio)}
                  </span>
                </Link>
                <Link
                  to="/matches/$matchId/$workspace"
                  params={{ matchId: match.id, workspace: "report" }}
                  className="button match-report-link"
                  title={`Report for ${match.team_a.join(" / ")} vs ${match.team_b.join(" / ")}`}
                >
                  Report
                </Link>
              </div>
            );
          })}
        </div>
      )}
      {firstMatch && (
        <p className="ratio-note">
          Ratio = operator minutes ÷ broadcast minutes. Assisted Annotation has a{" "}
          {formatRatio(firstMatch.assisted_ratio_budget)} budget (ADR 0004). Gold Annotation has no
          time budget.
        </p>
      )}
    </main>
  );
}

type QueuedDateEdit = { date: string; rallyLog: string | null };

function takeQueued(ref: { current: QueuedDateEdit | null }): QueuedDateEdit | null {
  const next = ref.current;
  ref.current = null;
  return next;
}

/** Inline date display ("—" when empty) that opens a date input and saves immediately on change. */
function MatchDateCell({
  match,
  error,
  onSaved,
  onError,
}: {
  match: Match;
  error: string | null;
  onSaved: (updated: Match) => void;
  onError: (matchId: string, message: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(match.date ?? "");
  const [saving, setSaving] = useState(false);
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlightRef = useRef(false);
  const pendingDateRef = useRef<string | null>(null);
  const queuedRef = useRef<QueuedDateEdit | null>(null);
  const latestSavedRef = useRef(match.date);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    latestSavedRef.current = match.date;
  }, [match.date]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing && !inFlightRef.current) {
      setDraft(match.date ?? "");
    }
  }, [editing, match.date]);

  async function saveDate(nextDate: string, rallyLog: string | null) {
    pendingDateRef.current = nextDate;
    setPendingDate(nextDate);
    if (inFlightRef.current) {
      queuedRef.current = { date: nextDate, rallyLog };
      return;
    }
    inFlightRef.current = true;
    setSaving(true);
    onError(match.id, null);
    let target: QueuedDateEdit | null = { date: nextDate, rallyLog };
    let activeRallyLog = rallyLog;
    try {
      while (target !== null) {
        const current = target;
        activeRallyLog = current.rallyLog;
        const updated = await updateMatch(
          match.id,
          { date: current.date },
          { rallyLog: current.rallyLog },
        );
        if (mountedRef.current && getTabRallyLog() === current.rallyLog) {
          latestSavedRef.current = updated.date;
          onSaved(updated);
        }
        target = takeQueued(queuedRef);
        if (target !== null && mountedRef.current) {
          pendingDateRef.current = target.date;
          setPendingDate(target.date);
        }
      }
    } catch (err) {
      queuedRef.current = null;
      if (mountedRef.current && getTabRallyLog() === activeRallyLog) {
        setDraft(latestSavedRef.current ?? "");
        onError(match.id, err instanceof Error ? err.message : "Could not save Match date.");
      }
    } finally {
      inFlightRef.current = false;
      pendingDateRef.current = null;
      if (mountedRef.current) {
        setSaving(false);
        setPendingDate(null);
      }
    }
  }

  function startEditing() {
    setDraft(pendingDateRef.current ?? latestSavedRef.current ?? "");
    setEditing(true);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setDraft(value);
    // Clearing a Match's date is not allowed; wait for a full YYYY-MM-DD date or revert on blur.
    if (!value || !isValidMatchDate(value)) return;
    if (value === (pendingDateRef.current ?? latestSavedRef.current)) return;
    void saveDate(value, getTabRallyLog());
  }

  function finishEditing() {
    setEditing(false);
    if (!inFlightRef.current) {
      setDraft(latestSavedRef.current ?? "");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      finishEditing();
    }
  }

  const label = teamsLabel(match);
  if (editing) {
    return (
      <span className="match-date-cell">
        <input
          ref={inputRef}
          type="date"
          className={`match-date-input mono${error ? " error" : ""}`}
          aria-label={`Date for ${label}`}
          aria-invalid={error ? true : undefined}
          aria-busy={saving || undefined}
          value={draft}
          required
          onChange={handleChange}
          onBlur={finishEditing}
          onKeyDown={handleKeyDown}
        />
      </span>
    );
  }

  const displayed = pendingDate ?? match.date;
  return (
    <span className="match-date-cell">
      <button
        type="button"
        className={`match-date-button mono${displayed === null ? " dimmed" : ""}${error ? " error" : ""}`}
        aria-label={`Date for ${label}`}
        title={error ?? (displayed === null ? "Set Match date" : "Edit Match date")}
        aria-busy={saving || undefined}
        onClick={startEditing}
      >
        {displayed ?? "—"}
      </button>
    </span>
  );
}

/** Rallies Done out of all Rallies, with a bar; or a note when there are none yet. */
function Progress({ done, total }: { done: number; total: number }) {
  if (total === 0) return <span className="dimmed">no Rallies yet</span>;
  return (
    <span className="progress" title={`${done} of ${total} Rallies Done`}>
      <span className="progress-bar" aria-hidden>
        <span style={{ width: `${(done / total) * 100}%` }} />
      </span>
      {done} / {total}
    </span>
  );
}
