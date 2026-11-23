/** The jobs a Match can be opened for; each is a tab in the top bar and its own route. */
export const WORKSPACES = ["calibrate", "annotate", "review"] as const;
export type Workspace = (typeof WORKSPACES)[number];

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  calibrate: "Calibrate",
  annotate: "Annotate",
  review: "Review",
};

export function isWorkspace(value: string): value is Workspace {
  return (WORKSPACES as readonly string[]).includes(value);
}
