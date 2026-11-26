import { FIT_COURT } from "../lib/courtView";
import type { CourtNavigation } from "./CourtDiagram";

export function CourtViewControls({ navigation }: { navigation: CourtNavigation }) {
  const horizontal = navigation.orientation === "horizontal";
  return (
    <span className="court-view-tools">
      <button
        type="button"
        className="icon-button"
        data-court-control
        title={horizontal ? "Switch to vertical Court" : "Switch to horizontal Court"}
        onClick={navigation.toggleOrientation}
      >
        {horizontal ? "Horizontal" : "Vertical"}
      </button>
      <button
        type="button"
        className="icon-button"
        data-court-control
        title="Fit the whole playing area"
        onClick={() => navigation.setView(FIT_COURT)}
      >
        Fit
      </button>
    </span>
  );
}
