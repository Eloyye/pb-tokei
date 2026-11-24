// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Calibration, CalibrationOut, PlaySegment } from "../api/client";
import { fitKey } from "../lib/calibrations";
import { CalibrationPanel } from "./CalibrationPanel";

afterEach(() => {
  cleanup();
});

const SEGMENT: PlaySegment = { start_frame: 1000, end_frame: 1999, camera_view: "sideline" };

type PanelProps = Parameters<typeof CalibrationPanel>[0];

function renderPanel(props: Partial<PanelProps> = {}) {
  const onSelect = vi.fn<PanelProps["onSelect"]>();
  const onSeek = vi.fn<PanelProps["onSeek"]>();
  const onDelete = vi.fn<PanelProps["onDelete"]>();
  const onReuse = vi.fn<PanelProps["onReuse"]>();
  const onReanchor = vi.fn<PanelProps["onReanchor"]>();
  const onMarkNotVisible = vi.fn<PanelProps["onMarkNotVisible"]>();
  const onClearLandmark = vi.fn<PanelProps["onClearLandmark"]>();
  const onConfirmLandmark = vi.fn<PanelProps["onConfirmLandmark"]>();
  const onConfirmAll = vi.fn<PanelProps["onConfirmAll"]>();
  const onRetrack = vi.fn<PanelProps["onRetrack"]>();

  const calibration: Calibration = {
    camera_view: "sideline",
    effective_from_frame: 1000,
    reference_frame: 1500,
    landmarks: {
      near_kitchen_left: { x: 0.2, y: 0.6, frame: 1500 },
      near_kitchen_right: { x: 0.8, y: 0.6, frame: 120 }, // carried over from outside segment
      far_kitchen_right: { x: 0.7, y: 0.3, frame: 1520 }, // clicked on another frame in segment
    },
    not_visible: ["near_baseline_left", "near_baseline_centre"],
  };

  const fit: CalibrationOut = {
    ...calibration,
    complete: false,
    image_to_court: null,
    court_to_image: null,
    errors: {},
    resolved_landmarks: {
      near_kitchen_left: { x: 0.2, y: 0.6 },
      far_kitchen_right: { x: 0.7, y: 0.3 },
    },
    unmapped_landmarks: ["near_kitchen_right"],
    worst_error_ft: null,
    needs_attention: true,
  };

  const utils = render(
    <CalibrationPanel
      focused
      frame={1500}
      segment={SEGMENT}
      calibration={calibration}
      calibrations={[calibration]}
      fits={new Map([[fitKey(calibration), fit]])}
      motion={null}
      unmappedRange={undefined}
      selected="near_kitchen_right"
      onSelect={onSelect}
      onSeek={onSeek}
      onDelete={onDelete}
      onReuse={onReuse}
      onReanchor={onReanchor}
      onMarkNotVisible={onMarkNotVisible}
      onClearLandmark={onClearLandmark}
      onConfirmLandmark={onConfirmLandmark}
      onConfirmAll={onConfirmAll}
      onRetrack={onRetrack}
      {...props}
    />,
  );

  return {
    ...utils,
    onSelect,
    onSeek,
    onMarkNotVisible,
    onClearLandmark,
    onConfirmLandmark,
    onConfirmAll,
  };
}

describe("CalibrationPanel", () => {
  it("shows placed, not visible, and remaining counts separately", () => {
    renderPanel();

    expect(screen.getByText("3 placed")).toBeTruthy();
    expect(screen.getByText("2 not visible")).toBeTruthy();
    expect(screen.getByText("7 remaining")).toBeTruthy();
  });

  it("distinguishes confirmed, carried-over, and other-frame Landmarks and wires actions", () => {
    const { onMarkNotVisible, onClearLandmark, onConfirmLandmark, onConfirmAll } = renderPanel();

    expect(screen.getByText("1 confirmed on ref 1500 · 1 carried over")).toBeTruthy();
    expect(screen.getByText("carried f120")).toBeTruthy();
    expect(screen.getByText("f1520")).toBeTruthy();
    expect(screen.getByText("unmapped")).toBeTruthy();
    expect(screen.getAllByText("not visible")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Confirm all on f1500/i }));
    expect(onConfirmAll).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Confirm on f1500/i }));
    expect(onConfirmLandmark).toHaveBeenCalledWith("near_kitchen_right");

    fireEvent.click(screen.getByRole("button", { name: /^Not visible V$/i }));
    expect(onMarkNotVisible).toHaveBeenCalledWith("near_kitchen_right");

    fireEvent.click(screen.getByRole("button", { name: /^Clear X$/i }));
    expect(onClearLandmark).toHaveBeenCalledWith("near_kitchen_right");
  });

  it("offers a Go to ref button when viewing a frame other than reference_frame", () => {
    const { onSeek } = renderPanel({ frame: 1520 });

    fireEvent.click(screen.getByRole("button", { name: /Go to ref 1500/i }));
    expect(onSeek).toHaveBeenCalledWith(1500);
  });
});
