import type { Roster } from "./rallyLog";

/** A Match roster for tests: Team A (a1, a2) and Team B (b1, b2), in name order. */
export const ROSTER: Roster = {
  teamA: "A",
  teamB: "B",
  players: [
    {
      id: "a1",
      name: "Anna Bright",
      handedness: "right",
      gender: "female",
      team_id: "A",
      team: "a",
    },
    { id: "a2", name: "Ben Johns", handedness: "right", gender: "male", team_id: "A", team: "a" },
    { id: "b1", name: "Cara Lee", handedness: "left", gender: "female", team_id: "B", team: "b" },
    { id: "b2", name: "Dan Kim", handedness: "right", gender: "male", team_id: "B", team: "b" },
  ],
};
