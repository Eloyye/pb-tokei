import type { Roster } from "./rallyLog";

/** A Match roster for tests: Team A (a1, a2) and Team B (b1, b2), in name order. */
export const ROSTER: Roster = {
  teamA: "A",
  teamB: "B",
  players: [
    { id: "a1", name: "Anna Bright", team_id: "A", team: "a" },
    { id: "a2", name: "Ben Johns", team_id: "A", team: "a" },
    { id: "b1", name: "Cara Lee", team_id: "B", team: "b" },
    { id: "b2", name: "Dan Kim", team_id: "B", team: "b" },
  ],
};
