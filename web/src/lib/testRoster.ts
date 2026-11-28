import type { Roster } from "./rallyLog";

/** A Match roster for tests: Team A (a1, a2) and Team B (b1, b2), in name order. */
export const ROSTER: Roster = {
  teamA: "A",
  teamB: "B",
  players: [
    { id: "a1", name: "Anna Bright", handedness: "right", team_id: "A", team: "a" },
    { id: "a2", name: "Ben Johns", handedness: "right", team_id: "A", team: "a" },
    { id: "b1", name: "Cara Lee", handedness: "left", team_id: "B", team: "b" },
    { id: "b2", name: "Dan Kim", handedness: "right", team_id: "B", team: "b" },
  ],
};
