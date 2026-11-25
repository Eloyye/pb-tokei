import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  cancelMatchFootage,
  type FetchFootageIn,
  type FootageJobOut,
  type FootageJobState,
  fetchMatchFootage,
  getMatchFootage,
  type MatchDetail,
} from "../api/client";
import { VIDEO_STATUS_LABELS } from "../routes/teams";

const POLL_MS = 1000;

export const COOKIE_BROWSERS = [
  { value: "", label: "None" },
  { value: "chrome", label: "Chrome" },
  { value: "firefox", label: "Firefox" },
  { value: "safari", label: "Safari" },
  { value: "edge", label: "Edge" },
  { value: "brave", label: "Brave" },
] as const;

export function parseCookiesSpec(spec: string | null | undefined): {
  browser: string;
  profile: string;
} {
  if (!spec) return { browser: "", profile: "" };
  const colon = spec.indexOf(":");
  if (colon === -1) return { browser: spec.trim().toLowerCase(), profile: "" };
  return {
    browser: spec.slice(0, colon).trim().toLowerCase(),
    profile: spec.slice(colon + 1).trim(),
  };
}

export function formatCookiesSpec(browser: string, profile: string): string | null {
  const cleanBrowser = browser.trim();
  if (!cleanBrowser) return null;
  const cleanProfile = profile.trim();
  return cleanProfile ? `${cleanBrowser}:${cleanProfile}` : cleanBrowser;
}

function isActiveJob(state: FootageJobState | undefined): boolean {
  return state === "queued" || state === "downloading" || state === "converting";
}

function renderHintWithLinks(hint: string): ReactNode {
  const urlPattern = /(https?:\/\/[^\s)]+)/g;
  const parts = hint.split(urlPattern);
  return parts.map((part, idx) =>
    part.startsWith("http://") || part.startsWith("https://") ? (
      <a key={idx} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

/**
 * Shown in the Monitor whenever a Match does not yet have a playable 60 fps video.
 * Lets the operator download and/or convert footage in-app, track progress, cancel, or fall back
 * to the equivalent CLI command.
 */
export function FetchPanel({ match }: { match: MatchDetail }) {
  const queryClient = useQueryClient();
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [cookiesDraft, setCookiesDraft] = useState<{ browser: string; profile: string } | null>(
    null,
  );
  const [requestError, setRequestError] = useState<string | null>(null);

  const footageQuery = useQuery({
    queryKey: ["matches", match.id, "footage"],
    queryFn: () => getMatchFootage(match.id),
    refetchInterval: (query) => (isActiveJob(query.state.data?.state) ? POLL_MS : false),
  });

  const job = footageQuery.data;
  const url = urlDraft ?? job?.requested_url ?? match.source_url ?? "";
  const prevStateRef = useRef<FootageJobState | undefined>(undefined);

  // When a job moves from downloading -> converting (SourceVideo recorded), or finishes / errors,
  // refresh the Match detail and Match list so Workspace remounts once the video becomes ready.
  useEffect(() => {
    const state = job?.state;
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (state === undefined || prev === state) return;
    // A job started before the Workspace opened may have finished before its first poll.
    const mayHaveFinished = (prev === undefined || isActiveJob(prev)) && !isActiveJob(state);
    const finishedDownload =
      (prev === undefined || prev === "downloading") && state === "converting";
    if (mayHaveFinished || finishedDownload) {
      void queryClient.invalidateQueries({ queryKey: ["matches", match.id], exact: true });
      void queryClient.invalidateQueries({ queryKey: ["matches"], exact: true });
    }
  }, [job?.state, match.id, queryClient]);

  const fetchMutation = useMutation({
    mutationFn: (body: FetchFootageIn) => fetchMatchFootage(match.id, body),
    onSuccess: (next) => {
      setRequestError(null);
      queryClient.setQueryData<FootageJobOut>(["matches", match.id, "footage"], next);
      void queryClient.invalidateQueries({ queryKey: ["matches"] });
      if (!isActiveJob(next.state)) {
        void queryClient.invalidateQueries({ queryKey: ["matches", match.id] });
      }
    },
    onError: (err) => {
      setRequestError(err instanceof Error ? err.message : String(err));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelMatchFootage(match.id),
    onSuccess: (next) => {
      setRequestError(null);
      setUrlDraft(url);
      queryClient.setQueryData<FootageJobOut>(["matches", match.id, "footage"], next);
      void queryClient.invalidateQueries({ queryKey: ["matches"] });
      void queryClient.invalidateQueries({ queryKey: ["matches", match.id] });
    },
    onError: (err) => {
      setRequestError(err instanceof Error ? err.message : String(err));
    },
  });

  const remembered = parseCookiesSpec(job?.cookies_from_browser);
  const browser = cookiesDraft ? cookiesDraft.browser : remembered.browser;
  const profile = cookiesDraft ? cookiesDraft.profile : remembered.profile;
  const hasCustomBrowser =
    Boolean(browser) && !COOKIE_BROWSERS.some((option) => option.value === browser);

  const state = job?.state ?? "idle";
  const active = isActiveJob(state);
  const convertOnly = match.video_status === "not_converted" && match.original_present;

  const submitFetch = (event: FormEvent) => {
    event.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    fetchMutation.mutate({
      url: trimmedUrl,
      cookies_from_browser: formatCookiesSpec(browser, profile),
    });
  };

  const startConvert = () => {
    fetchMutation.mutate({});
  };

  const errorText = requestError ?? (state === "error" ? job?.error : null);
  const errorHint = requestError ? null : state === "error" ? job?.hint : null;
  const stderrTail = requestError ? null : state === "error" ? job?.stderr_tail : null;

  return (
    <div className="fix fetch-panel">
      <div className="fetch-card">
        <div className="fetch-head">
          <span className={`pill pill-${match.video_status}`}>
            {VIDEO_STATUS_LABELS[match.video_status]}
          </span>
          <span className="fetch-title">
            {convertOnly
              ? "Original footage is on disk. Convert it to constant 60 fps to open this Match."
              : "Fetch broadcast footage and convert it to constant 60 fps."}
          </span>
        </div>

        {active && job ? (
          <div className="fetch-progress">
            <div className="fetch-progress-head">
              <span className="fetch-phase">
                {state === "queued" && `Queued (${job.queue_position ?? 1})`}
                {state === "downloading" &&
                  (job.percent !== null
                    ? `Downloading ${Math.round(job.percent)}%`
                    : "Downloading…")}
                {state === "converting" &&
                  (job.percent !== null
                    ? `Converting to 60 fps ${Math.round(job.percent)}%`
                    : "Converting to 60 fps…")}
              </span>
              {state === "downloading" && (job.speed || job.eta) && (
                <span className="mono fetch-meta">
                  {[job.speed, job.eta ? `ETA ${job.eta}` : null].filter(Boolean).join(" · ")}
                </span>
              )}
            </div>
            <progress
              className="fetch-bar"
              max={100}
              value={job.percent !== null ? Math.min(100, Math.max(0, job.percent)) : undefined}
              aria-label={
                state === "queued"
                  ? "Queued"
                  : state === "downloading"
                    ? "Downloading footage"
                    : "Converting footage"
              }
            />
            <div className="fetch-actions">
              <button
                type="button"
                className="button"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate()}
              >
                {cancelMutation.isPending ? "Cancelling…" : "Cancel"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {errorText && (
              <div className="fetch-error" role="alert">
                <p className="fetch-error-message">{errorText}</p>
                {errorHint && <p className="fetch-hint">{renderHintWithLinks(errorHint)}</p>}
                {stderrTail && (
                  <details className="fetch-stderr">
                    <summary>Raw output (stderr)</summary>
                    <pre>{stderrTail}</pre>
                  </details>
                )}
              </div>
            )}

            {convertOnly ? (
              <div className="fetch-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={fetchMutation.isPending}
                  onClick={startConvert}
                >
                  {fetchMutation.isPending ? "Starting…" : "Convert"}
                </button>
              </div>
            ) : (
              <form className="fetch-form" onSubmit={submitFetch}>
                <label className="fetch-field">
                  <span>Video URL</span>
                  <input
                    type="url"
                    className="picker-path"
                    value={url}
                    onChange={(event) => setUrlDraft(event.target.value)}
                    placeholder="https://www.youtube.com/watch?v=…"
                    autoComplete="off"
                    required
                  />
                </label>

                <div className="fetch-cookies">
                  <label className="fetch-field">
                    <span>Cookies from</span>
                    <select
                      className="fetch-select"
                      value={browser}
                      onChange={(event) =>
                        setCookiesDraft({
                          browser: event.target.value,
                          profile: event.target.value ? profile : "",
                        })
                      }
                    >
                      {COOKIE_BROWSERS.map((option) => (
                        <option key={option.value || "none"} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      {hasCustomBrowser && <option value={browser}>{browser}</option>}
                    </select>
                  </label>
                  {browser && (
                    <label className="fetch-field">
                      <span>Profile (optional)</span>
                      <input
                        type="text"
                        className="picker-path"
                        value={profile}
                        onChange={(event) =>
                          setCookiesDraft({ browser, profile: event.target.value })
                        }
                        placeholder="e.g. Profile 1"
                        autoComplete="off"
                      />
                    </label>
                  )}
                </div>

                <div className="fetch-actions">
                  <button
                    type="submit"
                    className="button primary"
                    disabled={fetchMutation.isPending || !url.trim()}
                  >
                    {fetchMutation.isPending ? "Starting…" : "Fetch"}
                  </button>
                </div>
              </form>
            )}
          </>
        )}

        {match.fix_command && (
          <div className="fetch-terminal">
            <span className="fetch-terminal-label">or from the terminal</span>
            <pre>{match.fix_command}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
