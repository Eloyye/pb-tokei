/** The jobs a Match can be opened for; each is a tab in the top bar and its own route. */
export const OPERATOR_WORKSPACES = ["calibrate", "annotate", "review"] as const;
export type OperatorWorkspace = (typeof OPERATOR_WORKSPACES)[number];

export const WORKSPACES = [...OPERATOR_WORKSPACES, "report"] as const;
export type Workspace = (typeof WORKSPACES)[number];

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  calibrate: "Calibrate",
  annotate: "Annotate",
  review: "Review",
  report: "Report",
};

export function isWorkspace(value: string): value is Workspace {
  return (WORKSPACES as readonly string[]).includes(value);
}
