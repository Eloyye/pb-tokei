// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { StatusBar } from "./StatusBar";

type StatusMatch = ComponentProps<typeof StatusBar>["match"];
const match: StatusMatch = {
  id: "match",
  video_status: "not_converted",
  annotation_mode: "gold",
  broadcast_seconds: 3600,
  operator_time: {
    active_seconds: 900,
    calibrate_seconds: 240,
    annotate_seconds: 600,
    review_seconds: 60,
  },
};

function renderBar(
  overrides: Partial<StatusMatch> = {},
  workspace: ComponentProps<typeof StatusBar>["workspace"] = "annotate",
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StatusBar
        match={{ ...match, ...overrides }}
        workspace={workspace}
        message="Calibrate"
        saveStatus={{ state: "saved" }}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("operator time in the StatusBar", () => {
  it("shows persisted time and broadcast length while footage is offline", () => {
    renderBar();
    const active = screen.getByText("Active 15:00");
    expect(active.classList.contains("idle")).toBe(true);
    expect(active.title).toBe("Calibrate 4:00 · Annotate 10:00 · Review 1:00 (paused — idle)");
    const ratio = screen.getByText("Ratio 0.25");
    expect(ratio.title).toContain("broadcast minutes (1:00:00)");
    expect(ratio.classList.contains("within-budget")).toBe(false);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("shows the budget in Review at the limit", () => {
    renderBar({}, "review");
    const ratio = screen.getByText("Ratio 0.25 / 0.25");
    expect(ratio.classList.contains("within-budget")).toBe(true);
    expect(ratio.title).toContain("Assisted budget 0.25");
  });

  it("shows amber above the Assisted budget in Calibrate", () => {
    renderBar({ annotation_mode: "assisted", broadcast_seconds: 3000 }, "calibrate");
    expect(screen.getByText("Ratio 0.30 / 0.25").classList.contains("over-budget")).toBe(true);
  });

  it("shows a neutral unknown ratio when broadcast length is absent", () => {
    renderBar({ broadcast_seconds: null, annotation_mode: "assisted" });
    const ratio = screen.getByText("Ratio —");
    expect(ratio.classList.contains("within-budget")).toBe(false);
    expect(ratio.classList.contains("over-budget")).toBe(false);
  });

  it("shows a known zero ratio", () => {
    renderBar({
      operator_time: {
        active_seconds: 0,
        calibrate_seconds: 0,
        annotate_seconds: 0,
        review_seconds: 0,
      },
    });
    expect(screen.getByText("Active 0:00")).toBeTruthy();
    expect(screen.getByText("Ratio 0.00")).toBeTruthy();
  });
});
