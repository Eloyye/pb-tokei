import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useMatch, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  getMatch,
  getRallyLog,
  getTabRallyLog,
  type RallyLogInfo,
  subscribeTabRallyLog,
} from "../api/client";
import { isTextEntry } from "../lib/keymap";
import { WORKSPACE_LABELS, WORKSPACES } from "../lib/workspaces";
import { teamsLabel } from "../routes/teams";
import { OpenHelpContext } from "./help";
import { listenForRallyLogSwitch, OpenRallyLogPickerContext, rallyLogFileName } from "./rallyLog";
import { RallyLogPicker } from "./RallyLogPicker";
import { ShortcutSheet } from "./ShortcutSheet";

/**
 * The frame around every page: top bar, the page, the shortcut sheet on `?`, and the Rally Log
 * picker (opened from the top bar, and at once when no Rally Log is open).
 */
export function AppShell() {
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  // Null until the operator opens or closes the picker: it starts open when no Rally Log is.
  const [pickerChoice, setPickerChoice] = useState<boolean | null>(null);
  const openPicker = useCallback(() => setPickerChoice(true), []);
  const queryClient = useQueryClient();
  // Refetched on every focus so a tab notices another tab's switch (ADR 0008).
  const rallyLog = useQuery({
    queryKey: ["rally-log"],
    queryFn: getRallyLog,
    refetchOnWindowFocus: "always",
  });
  const noRallyLog = rallyLog.data !== undefined && rallyLog.data.path === null;
  const pickerOpen = pickerChoice ?? noRallyLog;

  // Another tab switched Rally Log: look again, so this tab can tell it is now stale.
  useEffect(
    () =>
      listenForRallyLogSwitch(
        () => void queryClient.invalidateQueries({ queryKey: ["rally-log"] }),
      ),
    [queryClient],
  );

  useEffect(() => {
    // Capture phase, so while the sheet or picker is open no other shortcut sees the key.
    const onKeyDown = (event: KeyboardEvent) => {
      if (pickerOpen) {
        // Typing, Enter and Esc are left to the picker's own field, form and dialog.
        if (event.key !== "Tab") event.stopPropagation();
        return;
      }
      if (helpOpen) {
        if (event.key === "Tab") return;
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "?") {
          event.preventDefault();
          setHelpOpen(false);
        }
        return;
      }
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !isTextEntry(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [helpOpen, pickerOpen]);

  return (
    <OpenHelpContext.Provider value={openHelp}>
      <OpenRallyLogPickerContext.Provider value={openPicker}>
        <div className="app">
          <TopBar onHelp={openHelp} onPicker={openPicker} rallyLog={rallyLog} />
          <Outlet />
        </div>
        {helpOpen && <ShortcutSheet onClose={() => setHelpOpen(false)} />}
        {pickerOpen && (
          <RallyLogPicker rallyLog={rallyLog.data} onClose={() => setPickerChoice(false)} />
        )}
      </OpenRallyLogPickerContext.Provider>
    </OpenHelpContext.Provider>
  );
}

interface RallyLogQuery {
  data: RallyLogInfo | undefined;
  error: Error | null;
}

function TopBar({
  onHelp,
  onPicker,
  rallyLog,
}: {
  onHelp: () => void;
  onPicker: () => void;
  rallyLog: RallyLogQuery;
}) {
  const { matchId, workspace } = useParams({ strict: false });
  const isNewMatch = useMatch({ from: "/matches/new", shouldThrow: false, select: () => true });
  const match = useQuery({
    queryKey: ["matches", matchId],
    queryFn: () => getMatch(matchId ?? ""),
    enabled: matchId !== undefined,
  });

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link to="/" className="brand">
          pb-tokei
        </Link>
        {matchId !== undefined && (
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link to="/">Home</Link>
            {match.data && (
              <>
                <span className="sep">›</span>
                <span>{match.data.tournament}</span>
                <span className="sep">›</span>
                <span className="here">{teamsLabel(match.data)}</span>
              </>
            )}
          </nav>
        )}
      </div>
      {matchId === undefined ? (
        <nav className="workspace-tabs dashboard-tabs" aria-label="Dashboard">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            inactiveProps={isNewMatch ? { "aria-current": "page" } : undefined}
          >
            Matches
          </Link>
          <Link to="/players">Players</Link>
          <Link to="/teams">Teams</Link>
        </nav>
      ) : (
        <nav className="workspace-tabs" aria-label="Workspaces">
          {WORKSPACES.map((w) => (
            <Link
              key={w}
              to="/matches/$matchId/$workspace"
              params={{ matchId, workspace: w }}
              aria-current={w === workspace ? "page" : undefined}
            >
              {WORKSPACE_LABELS[w]}
            </Link>
          ))}
        </nav>
      )}
      <div className="topbar-right">
        <RallyLogButton rallyLog={rallyLog} onPicker={onPicker} />
        <button
          type="button"
          className="help-button"
          onClick={onHelp}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
      </div>
    </header>
  );
}

/**
 * The open Rally Log's name (full path on hover), which opens the picker. When the app has
 * switched to another Rally Log since this tab loaded (in another tab), it offers a reload
 * instead, since this tab's requests are now refused.
 */
function RallyLogButton({ rallyLog, onPicker }: { rallyLog: RallyLogQuery; onPicker: () => void }) {
  const tabPath = useSyncExternalStore(subscribeTabRallyLog, getTabRallyLog);
  const serverPath = rallyLog.data?.path;

  if (tabPath !== null && serverPath !== undefined && serverPath !== tabPath) {
    return (
      <button
        type="button"
        className="rally-log-button stale"
        title={`This tab shows ${tabPath}; the app has since switched to ${serverPath ?? "no Rally Log"}`}
        onClick={() => window.location.assign("/")}
      >
        Rally Log switched elsewhere: reload
      </button>
    );
  }
  if (serverPath === null) {
    return (
      <button type="button" className="rally-log-button missing" onClick={onPicker}>
        No Rally Log
      </button>
    );
  }
  if (serverPath !== undefined) {
    return (
      <button
        type="button"
        className="rally-log-button mono"
        title={serverPath}
        aria-label={`Rally Log ${rallyLogFileName(serverPath)}: switch`}
        onClick={onPicker}
      >
        {rallyLogFileName(serverPath)}
      </button>
    );
  }
  if (rallyLog.error) {
    return (
      <button
        type="button"
        className="rally-log-button"
        title={rallyLog.error.message}
        onClick={onPicker}
      >
        unknown Rally Log
      </button>
    );
  }
  return null;
}
