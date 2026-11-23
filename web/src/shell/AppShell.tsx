import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { getMatch } from "../api/client";
import { isTextEntry } from "../lib/keymap";
import { WORKSPACE_LABELS, WORKSPACES } from "../lib/workspaces";
import { teamsLabel } from "../routes/teams";
import { OpenHelpContext } from "./help";
import { ShortcutSheet } from "./ShortcutSheet";

/** The frame around every page: top bar, the page, and the shortcut sheet on `?`. */
export function AppShell() {
  const [helpOpen, setHelpOpen] = useState(false);
  const openHelp = useCallback(() => setHelpOpen(true), []);

  useEffect(() => {
    // Capture phase, so while the sheet is open no other shortcut sees the key.
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [helpOpen]);

  return (
    <OpenHelpContext.Provider value={openHelp}>
      <div className="app">
        <TopBar onHelp={openHelp} />
        <Outlet />
      </div>
      {helpOpen && <ShortcutSheet onClose={() => setHelpOpen(false)} />}
    </OpenHelpContext.Provider>
  );
}

function TopBar({ onHelp }: { onHelp: () => void }) {
  const { matchId, workspace } = useParams({ strict: false });
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
        <nav className="crumbs" aria-label="Breadcrumb">
          {matchId === undefined ? (
            <span className="here">Home</span>
          ) : (
            <>
              <Link to="/">Home</Link>
              {match.data && (
                <>
                  <span className="sep">›</span>
                  <span>{match.data.tournament}</span>
                  <span className="sep">›</span>
                  <span className="here">{teamsLabel(match.data)}</span>
                </>
              )}
            </>
          )}
        </nav>
      </div>
      <nav className="workspace-tabs" aria-label="Workspaces">
        {matchId !== undefined &&
          WORKSPACES.map((w) => (
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
      <div className="topbar-right">
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
