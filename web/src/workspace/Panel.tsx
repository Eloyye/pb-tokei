import type { ReactNode } from "react";

export type PanelId = "monitor" | "court" | "inspector" | "calibration" | "rallies" | "timeline";

/**
 * One workspace panel: a 28 px header (tabs on the left, tools on the right) over its body.
 * The workspace outlines the panel last clicked, as Premiere does.
 */
export function Panel({
  id,
  focused,
  className = "",
  tabs,
  tools,
  children,
}: {
  id: PanelId;
  focused: boolean;
  className?: string;
  tabs: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${className} ${focused ? "focused" : ""}`} data-panel={id}>
      <div className="panel-head">
        {tabs}
        {tools !== undefined && <div className="panel-tools">{tools}</div>}
      </div>
      {children}
    </section>
  );
}

/** A panel header label that isn't a switchable tab. */
export function PanelTitle({ children }: { children: ReactNode }) {
  return <span className="panel-tab active">{children}</span>;
}
