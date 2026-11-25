import { createContext, useContext } from "react";

/** Opens the Rally Log picker in the top bar. */
export const OpenRallyLogPickerContext = createContext<() => void>(() => {});

export function useOpenRallyLogPicker(): () => void {
  return useContext(OpenRallyLogPickerContext);
}

export function rallyLogFileName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** The folder holding a Rally Log, with its trailing separator: where a new one goes by default. */
export function rallyLogFolder(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

const CHANNEL = "pb-tokei-rally-log";

/** Tells this browser's other tabs of the app that the open Rally Log has changed. */
export function announceRallyLogSwitch(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel, not a window
  channel.postMessage("switched");
  channel.close();
}

/** Calls `onSwitch` when another tab switches the open Rally Log. Returns the unsubscribe. */
export function listenForRallyLogSwitch(onSwitch: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener("message", onSwitch);
  return () => channel.close();
}
