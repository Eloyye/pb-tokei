import { describe, expect, it } from "vitest";
import type { Game, RallyEntry } from "../api/client";
import { annotateKeyAction, segmentKeyAction } from "../lib/keymap";
import { newRally } from "../lib/rallyLog";
import { contextMenuItems, type ContextMenuTarget } from "./contextMenuItems";

const targets: ContextMenuTarget[] = [
  { kind: "rally", game: 0, rally: 0 },
  { kind: "shot", game: 0, rally: 0, entry: 0 },
  { kind: "gap", game: 0, rally: 0, entry: 1 },
  { kind: "segment", segment: { start_frame: 10, end_frame: 40, camera_view: "main" } },
  { kind: "lane" },
];

it.each(targets)("matches the displayed $kind shortcuts to the keymap", (target) => {
  const entries: (RallyEntry | undefined)[] =
    target.kind === "gap"
      ? [
          { type: "gap", missing: "odd" },
          { type: "gap", missing: "even" },
        ]
      : [undefined];
  for (const entry of entries) {
    const items = contextMenuItems(target, {
      workspace: target.kind === "segment" ? "calibrate" : "annotate",
      hasVideo: true,
      frame: 20,
      rally: newRally(1, 10),
      entry,
    });
    for (const { command, shortcut } of items) {
      if (command.kind !== "annotate" && command.kind !== "segment") continue;
      expect(shortcut).toBeDefined();
      const metaKey = shortcut!.startsWith("⌘");
      const rest = metaKey ? shortcut!.slice(1) : shortcut!;
      const shiftKey = rest.startsWith("Shift+");
      const key = shiftKey ? rest.slice("Shift+".length) : rest;
      const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : key;
      const event = { key, code, shiftKey, altKey: false, ctrlKey: false, metaKey };
      const parseKey = command.kind === "annotate" ? annotateKeyAction : segmentKeyAction;
      expect(parseKey(event)).toEqual(command.action);
    }
  }
});

describe("Split Rally menu item availability", () => {
  const target: ContextMenuTarget = { kind: "rally", game: 0, rally: 0 };
  const splitItem = (options: Parameters<typeof contextMenuItems>[1]) =>
    contextMenuItems(target, options).find((item) => item.label === "Split Rally at playhead")!;

  it("enables Split Rally in Annotate when start < frame <= end and explains why otherwise", () => {
    const rally = { ...newRally(1, 100), end_frame: 300 };
    const games: Game[] = [{ number: 1, rallies: [rally] }];
    const at = (frame: number, overrides: Partial<Parameters<typeof contextMenuItems>[1]> = {}) =>
      splitItem({
        workspace: "annotate",
        hasVideo: true,
        frame,
        games,
        rally,
        entry: undefined,
        ...overrides,
      });

    expect(at(101).disabledReason).toBeUndefined();
    expect(at(300).disabledReason).toBeUndefined();
    expect(at(100).disabledReason).toBe("Move the playhead past this Rally’s start (frame 100)");
    expect(at(301).disabledReason).toBe(
      "Move the playhead to or before this Rally’s end (frame 300)",
    );
    expect(at(200, { hasVideo: false }).disabledReason).toBe("Load the video first");
    expect(at(200, { workspace: "review" }).disabledReason).toBe("Available in Annotate");
    expect(at(200, { workspace: "calibrate" }).disabledReason).toBe("Available in Annotate");

    const unseen = newRally(1);
    expect(
      at(200, { games: [{ number: 1, rallies: [unseen] }], rally: unseen }).disabledReason,
    ).toBe("An Unseen Rally has no frames");
  });

  it("checks later Rallies when splitting an open-ended Rally", () => {
    const open = newRally(1, 100);
    const next = { ...newRally(2, 500), end_frame: 700 };
    const games: Game[] = [{ number: 1, rallies: [open, next] }];
    expect(
      splitItem({
        workspace: "annotate",
        hasVideo: true,
        frame: 499,
        games,
        rally: open,
        entry: undefined,
      }).disabledReason,
    ).toBeUndefined();
    expect(
      splitItem({
        workspace: "annotate",
        hasVideo: true,
        frame: 500,
        games,
        rally: open,
        entry: undefined,
      }).disabledReason,
    ).toBe("Rallies can't overlap: G1 R2 starts at frame 500");
  });
});
