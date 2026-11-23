import { createContext, useContext } from "react";

/** Opens the keyboard shortcut sheet; provided by the app shell. */
export const OpenHelpContext = createContext<() => void>(() => {});

export function useOpenHelp(): () => void {
  return useContext(OpenHelpContext);
}
