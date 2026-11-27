import { expect, it } from "vitest";
import type { RallyEntry } from "../api/client";
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
      for (const alias of shortcut!.split(" ")) {
        const keys = alias.split("+");
        const key = keys.at(-1)!;
        const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : key;
        const event = {
          key,
          code,
          shiftKey: keys.includes("Shift"),
          altKey: false,
          ctrlKey: keys.includes("Control"),
          metaKey: keys.includes("Meta"),
        };
        const parseKey = command.kind === "annotate" ? annotateKeyAction : segmentKeyAction;
        expect(parseKey(event)).toEqual(command.action);
      }
    }
  }
});
