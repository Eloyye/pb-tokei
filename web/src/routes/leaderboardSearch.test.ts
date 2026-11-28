import { expect, it } from "vitest";
import { leaderboardSearch } from "./leaderboardSearch";

it.each([0, 1.5, "5", Number.MAX_SAFE_INTEGER + 1])(
  "drops an invalid kind and minimum %s from a shared URL",
  (minimum) => {
    expect(leaderboardSearch({ kind: "players", minimum })).toMatchObject({
      kind: undefined,
      minimum: undefined,
    });
  },
);

it.each([undefined, "shot_type"])("drops a bucket without a valid breakdown (%s)", (by) => {
  expect(leaderboardSearch({ by, bucket: 3 })).toMatchObject({
    by: undefined,
    bucket: undefined,
  });
});

it("preserves a numeric Shot Number bucket and a valid kind, minimum, and discipline", () => {
  const settings = {
    kind: "team",
    minimum: 5,
    by: "shot_number",
    bucket: 3,
    discipline: "mixed_doubles",
  };
  expect(leaderboardSearch(settings)).toMatchObject(settings);
});

it.each(["singles", 42, ""])("drops an invalid discipline %s from a shared URL", (discipline) => {
  expect(leaderboardSearch({ discipline })).toMatchObject({ discipline: undefined });
});
