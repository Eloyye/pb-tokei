import { useState } from "react";
import type { MatchDetail } from "../api/client";
import { CourtDiagram } from "./CourtDiagram";
import { Panel, PanelTitle } from "./Panel";

/** Court diagram. Player dots, the hitter ring and landing spots come with Shot entry. */
export function CourtPanel({ match, focused }: { match: MatchDetail; focused: boolean }) {
  return (
    <Panel
      id="court"
      focused={focused}
      tabs={<PanelTitle>Court</PanelTitle>}
      tools={<span>near end = Main View camera</span>}
    >
      <div className="court-wrap">
        {/* Which Team starts at the near end isn't recorded yet; Team A is drawn there. */}
        <CourtDiagram nearTeam={match.team_a.join(" / ")} farTeam={match.team_b.join(" / ")} />
        <div className="court-note">Players and landing spots appear once Shots are entered</div>
      </div>
    </Panel>
  );
}

type InspectorTab = "shot" | "rally";

/** Properties of the current Shot or Rally. Empty until Rally and Shot entry exists. */
export function InspectorPanel({ focused }: { focused: boolean }) {
  const [tab, setTab] = useState<InspectorTab>("shot");
  return (
    <Panel
      id="inspector"
      focused={focused}
      tabs={
        <div role="tablist" aria-label="Inspector" style={{ display: "flex" }}>
          {(["shot", "rally"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`panel-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "shot" ? "Shot" : "Rally"}
            </button>
          ))}
        </div>
      }
    >
      <div className="panel-body" role="tabpanel">
        {tab === "shot" ? (
          <p className="empty">
            <strong>No Shot selected.</strong> The current Shot's Hitter, Shot Class, Contact Kind,
            Zone, Erne, ATP, landing and Error will show here, each marked Observed, Inferred or
            Unknown.
          </p>
        ) : (
          <p className="empty">
            <strong>No Rally selected.</strong> The current Rally's frames, score, Serving Team,
            Server, Returner, Referee Call, Challenge and winner will show here.
          </p>
        )}
      </div>
    </Panel>
  );
}

export function RalliesPanel({ focused }: { focused: boolean }) {
  return (
    <Panel
      id="rallies"
      focused={focused}
      className="area-rallies"
      tabs={<PanelTitle>Rallies</PanelTitle>}
      tools={<span className="mono">0</span>}
    >
      <div className="panel-body">
        <p className="empty">
          No Rallies yet. They will be listed here by Game, with status, score and issues.
        </p>
      </div>
    </Panel>
  );
}
