import { describe, expect, it } from "vitest";
import {
  buildPlayerDropdown,
  checkNewPlayerDraft,
  fuzzyNearMatchScore,
  normalizeFuzzy,
  normalizeName,
  type OtherSlotUsage,
  type RosterPlayerOption,
} from "./playerMatching";

const PLAYERS: RosterPlayerOption[] = [
  { id: "p-ab", name: "Anna Bright", handedness: "right" },
  { id: "p-alw", name: "Anna-Leigh Waters", handedness: "right" },
  { id: "p-bj", name: "Ben Johns", handedness: "right" },
  { id: "p-jw", name: "J.W. Johnson", handedness: "right" },
  { id: "p-jk", name: "Jade Kawamoto", handedness: "right" },
  { id: "p-ob", name: "Liam O'Brien", handedness: "left" },
];

const NO_OTHERS: OtherSlotUsage = { existingIds: new Map(), stagedNew: [] };

describe("playerMatching", () => {
  it("normalizes punctuation, whitespace, and case for fuzzy comparison", () => {
    expect(normalizeName("  Anna   Bright ")).toBe("anna bright");
    expect(normalizeFuzzy("Anna-Leigh Waters")).toBe("anna leigh waters");
    expect(normalizeFuzzy("J.W. Johnson")).toBe("jw johnson");
    expect(normalizeFuzzy("Liam O’Brien")).toBe("liam obrien");
    expect(normalizeFuzzy("Liam O'Brien")).toBe("liam obrien");
  });

  it("matches punctuation/hyphen variants and typos while scaling edit-distance tolerance", () => {
    expect(
      fuzzyNearMatchScore(normalizeFuzzy("Anna Leigh Waters"), normalizeFuzzy("Anna-Leigh Waters")),
    ).toBe(0);
    expect(fuzzyNearMatchScore(normalizeFuzzy("JW Johnson"), normalizeFuzzy("J.W. Johnson"))).toBe(
      0,
    );
    expect(fuzzyNearMatchScore(normalizeFuzzy("Anan Bright"), normalizeFuzzy("Anna Bright"))).toBe(
      1,
    );
    expect(fuzzyNearMatchScore("jhon", "john")).toBe(1);
    expect(fuzzyNearMatchScore("bem", "ben")).toBe(1);
    // 3-char names do not allow distance 2; 2-char names do not allow distance 1.
    expect(fuzzyNearMatchScore("dan", "ben")).toBeNull();
    expect(fuzzyNearMatchScore("al", "am")).toBeNull();
    // Word containment works for >= 2-char queries but not 1-char queries.
    expect(
      fuzzyNearMatchScore(normalizeFuzzy("Anna Waters"), normalizeFuzzy("Anna-Leigh Waters")),
    ).toBe(3);
    expect(fuzzyNearMatchScore("a", "a b")).toBeNull();
  });

  it("avoids surname-only false positives on sibling pairs", () => {
    expect(checkNewPlayerDraft("Collin Johns", PLAYERS, NO_OTHERS)).toEqual({ kind: "ok" });
    expect(checkNewPlayerDraft("Jorja Johnson", PLAYERS, NO_OTHERS)).toEqual({ kind: "ok" });
    expect(checkNewPlayerDraft("Jackie Kawamoto", PLAYERS, NO_OTHERS)).toEqual({ kind: "ok" });
  });

  it("ranks exact/prefix before substring before fuzzy and places + Create last", () => {
    const res = buildPlayerDropdown("Anna Leigh Waters", PLAYERS, NO_OTHERS);
    expect(res.hasPlayerMatches).toBe(true);
    expect(res.canCreate).toBe(true);
    expect(res.options.map((o) => (o.kind === "existing" ? o.player.name : o.kind))).toEqual([
      "Anna-Leigh Waters",
      "create",
    ]);

    const prefixVsSub = buildPlayerDropdown(
      "ann",
      [
        { id: "sub", name: "Hannah Lee", handedness: "left" },
        { id: "pre", name: "Anna Bright", handedness: "right" },
      ],
      NO_OTHERS,
    );
    expect(prefixVsSub.options.map((o) => (o.kind === "existing" ? o.player.id : o.kind))).toEqual([
      "pre",
      "sub",
      "create",
    ]);
  });

  it("hides + Create on normalized collisions with existing or staged-new Players", () => {
    const existingHit = buildPlayerDropdown("  anna   bright ", PLAYERS, NO_OTHERS);
    expect(existingHit.canCreate).toBe(false);
    expect(existingHit.options.some((o) => o.kind === "create")).toBe(false);

    const withStaged: OtherSlotUsage = {
      existingIds: new Map([["p-ab", "Team A"]]),
      stagedNew: [
        { name: "Eve Park", normalizedName: "eve park", handedness: "left", slotLabel: "Team A" },
      ],
    };
    const stagedHit = buildPlayerDropdown("eve  park", PLAYERS, withStaged);
    expect(stagedHit.canCreate).toBe(false);
    expect(stagedHit.options).toEqual([
      {
        kind: "staged-new",
        staged: withStaged.stagedNew[0],
        disabled: true,
        disabledReason: "Team A",
      },
    ]);
  });

  it("prefers an unused Player when legacy duplicate names collide", () => {
    const legacy: RosterPlayerOption[] = [
      { id: "p-1", name: "Anna Bright", handedness: "right" },
      { id: "p-2", name: "Anna Bright", handedness: "left" },
    ];
    const used: OtherSlotUsage = { existingIds: new Map([["p-1", "Team A"]]), stagedNew: [] };
    expect(checkNewPlayerDraft("Anna Bright", legacy, used)).toEqual({
      kind: "existing-collision",
      player: legacy[1],
      usedInSlot: undefined,
    });
  });
});
