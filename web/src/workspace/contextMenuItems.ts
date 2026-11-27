import type { MouseEvent } from "react";
import type { PlaySegment, Rally, RallyEntry } from "../api/client";
import { rallyStartTarget } from "../lib/annotate";
import type { AnnotateAction, SegmentAction } from "../lib/keymap";
import { segmentSplitBlocker } from "../lib/segments";
import type { Workspace } from "../lib/workspaces";

export type ContextMenuTarget =
  | { kind: "rally"; game: number; rally: number }
  | { kind: "shot" | "gap"; game: number; rally: number; entry: number }
  | { kind: "segment"; segment: PlaySegment }
  | { kind: "lane" };

export type OpenContextMenu = (event: MouseEvent<HTMLElement>, target: ContextMenuTarget) => void;

export type MenuCommand =
  | { kind: "annotate"; action: AnnotateAction }
  | { kind: "segment"; action: SegmentAction }
  | { kind: "fitRally" }
  | { kind: "fitVideo" };

export interface MenuItem {
  label: string;
  command: MenuCommand;
  shortcut?: string;
  disabledReason?: string;
}

export const CONTEXT_MENU_LABELS: Record<ContextMenuTarget["kind"], string> = {
  rally: "Rally actions",
  shot: "Shot actions",
  gap: "Observation Gap actions",
  segment: "Play Segment actions",
  lane: "Timeline actions",
};

export function contextMenuItems(
  target: ContextMenuTarget,
  {
    workspace,
    hasVideo,
    frame,
    rally,
    entry,
  }: {
    workspace: Workspace;
    hasVideo: boolean;
    frame: number;
    rally: Rally | undefined;
    entry: RallyEntry | undefined;
  },
): MenuItem[] {
  const noVideo = hasVideo ? undefined : "Load the video first";
  const annotateOnly = workspace === "annotate" ? undefined : "Available in Annotate";
  const segmentOnly = workspace === "calibrate" ? noVideo : "Available in Calibrate";
  const unframed = rally?.start_frame == null ? "Select a framed Rally first" : undefined;
  const fitRally: MenuItem = {
    label: "Fit Rally",
    command: { kind: "fitRally" },
    disabledReason:
      workspace === "calibrate" ? "Available in Annotate and Review" : (noVideo ?? unframed),
  };
  const annotate = (
    label: string,
    shortcut: string,
    action: AnnotateAction,
    reason?: string,
  ): MenuItem => ({
    label,
    shortcut,
    command: { kind: "annotate", action },
    disabledReason: annotateOnly ?? reason,
  });
  const segment = (
    label: string,
    shortcut: string,
    action: SegmentAction,
    reason?: string,
  ): MenuItem => ({
    label,
    shortcut,
    command: { kind: "segment", action },
    disabledReason: segmentOnly ?? reason,
  });

  switch (target.kind) {
    case "rally":
      return [
        annotate(
          "Rally start at playhead",
          "Shift+I",
          { type: "rallyStart" },
          noVideo ?? (rally && rallyStartTarget(rally, frame).disabledReason),
        ),
        annotate("Rally end at playhead", "Shift+O", { type: "rallyEnd" }, noVideo ?? unframed),
        annotate("Insert Unseen Rally after", "Shift+U", { type: "unseenRally" }),
        annotate("Delete Rally", "Shift+Backspace", { type: "deleteRally" }),
        annotate("Mark Done", "Enter", { type: "done" }),
        fitRally,
        annotate("Rally details", "Shift+S", { type: "rallyForm" }),
      ];
    case "shot":
      return [
        annotate("Delete Shot", "Backspace", { type: "deleteEntry" }),
        annotate("Odd Observation Gap after", "G", { type: "gap", parity: "odd" }),
        annotate("Even Observation Gap after", "Shift+G", { type: "gap", parity: "even" }),
        annotate("Swap hitter to partner", "X", { type: "swapPartner" }),
        annotate("Switch hitter’s Team", "Shift+H", { type: "switchTeam" }),
      ];
    case "gap": {
      const parity = entry?.type === "gap" && entry.missing === "odd" ? "even" : "odd";
      return [
        annotate("Delete Observation Gap", "Backspace", { type: "deleteEntry" }),
        annotate(`Change to ${parity}`, parity === "odd" ? "G" : "Shift+G", {
          type: "gap",
          parity,
        }),
      ];
    }
    case "segment":
      return [
        segment("Set Main View", "1", { type: "setView", view: "main" }),
        segment("Set Sideline View", "2", { type: "setView", view: "sideline" }),
        segment("Delete Play Segment", "Backspace", { type: "remove" }),
        segment(
          "Play Segment start at playhead",
          "Shift+I",
          { type: "markIn" },
          frame > target.segment.end_frame
            ? "Move the playhead to or before this Play Segment’s end"
            : undefined,
        ),
        segment(
          "Play Segment end at playhead",
          "Shift+O",
          { type: "markOut" },
          frame < target.segment.start_frame
            ? "Move the playhead to or after this Play Segment’s start"
            : undefined,
        ),
        segment(
          "Split Play Segment at playhead",
          "Meta+K",
          { type: "split" },
          segmentSplitBlocker(target.segment, frame),
        ),
      ];
    case "lane":
      return [
        fitRally,
        { label: "Fit video", command: { kind: "fitVideo" }, disabledReason: noVideo },
        annotate("Rally start at playhead", "Shift+I", { type: "rallyStart" }, noVideo),
      ];
  }
}
