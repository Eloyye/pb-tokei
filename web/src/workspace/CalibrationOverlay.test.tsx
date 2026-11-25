// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Calibration, CalibrationOut } from "../api/client";
import { CalibrationOverlay } from "./CalibrationOverlay";

afterEach(() => {
  cleanup();
});

// Maps court feet x in [-10, 10], y in [-22, 22] linearly into [0.1, 0.9] x [0.06, 0.94].
const COURT_MATRIX = [
  [0.04, 0, 0.5],
  [0, -0.02, 0.5],
  [0, 0, 1],
];

type OverlayProps = Parameters<typeof CalibrationOverlay>[0];

function makeVideoRef() {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    clientWidth: { value: 1000, configurable: true },
    clientHeight: { value: 500, configurable: true },
    videoWidth: { value: 1000, configurable: true },
    videoHeight: { value: 500, configurable: true },
    offsetLeft: { value: 0, configurable: true },
    offsetTop: { value: 0, configurable: true },
  });
  return { current: video };
}

function makeCalibration(overrides: Partial<Calibration> = {}): Calibration {
  return {
    camera_view: "main",
    effective_from_frame: 1000,
    reference_frame: 1005,
    landmarks: {
      near_kitchen_left: { x: 0.2, y: 0.6, frame: 1005 },
      near_kitchen_right: { x: 0.8, y: 0.6, frame: 1020 },
    },
    not_visible: ["far_kitchen_centre"],
    ...overrides,
  };
}

function makeFit(
  calibration: Calibration,
  overrides: Partial<CalibrationOut> = {},
): CalibrationOut {
  return {
    ...calibration,
    complete: true,
    image_to_court: COURT_MATRIX,
    court_to_image: COURT_MATRIX,
    errors: {
      near_kitchen_left: {
        residual_ft: 0.9,
        leave_one_out_ft: 0.9,
        off_court: false,
        needs_attention: true,
      },
    },
    resolved_landmarks: {
      near_kitchen_left: { x: 0.2, y: 0.6 },
      near_kitchen_right: { x: 0.78, y: 0.58 },
    },
    unmapped_landmarks: [],
    worst_error_ft: 0.9,
    needs_attention: true,
    ...overrides,
  };
}

function renderOverlay(props: Partial<OverlayProps> = {}) {
  const calibration = props.calibration ?? makeCalibration();
  const fit = "fit" in props ? props.fit : makeFit(calibration);
  const videoRef = makeVideoRef();
  const onPlace = vi.fn<OverlayProps["onPlace"]>();
  const onSelect = vi.fn<OverlayProps["onSelect"]>();
  const onBlocked = vi.fn<OverlayProps["onBlocked"]>();

  const utils = render(
    <CalibrationOverlay
      videoRef={videoRef}
      frame={1005}
      calibration={calibration}
      fit={fit}
      lastFit={fit}
      selected="far_kitchen_right"
      editable
      onPlace={onPlace}
      onSelect={onSelect}
      onBlocked={onBlocked}
      {...props}
    />,
  );

  return { ...utils, onPlace, onSelect, onBlocked };
}

describe("CalibrationOverlay", () => {
  it("renders a ghost glow at the projected court intersection for remaining and not-visible Landmarks", () => {
    const { container, rerender, onPlace, onSelect, onBlocked } = renderOverlay({
      selected: "far_kitchen_right",
    });

    const ghost = container.querySelector<HTMLElement>(".landmark-highlight");
    expect(ghost).not.toBeNull();
    expect(ghost?.dataset.highlight).toBe("ghost");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(ghost?.classList.contains("stale")).toBe(false);
    // courtPoint("far_kitchen_right") = (10, 7) -> (0.9, 0.36).
    expect(ghost?.style.left).toBe("90%");
    expect(ghost?.style.top).toBe("36%");

    // Not-visible Landmark still gets a ghost when it projects inside the picture.
    const calibration = makeCalibration();
    const fit = makeFit(calibration);
    rerender(
      <CalibrationOverlay
        videoRef={makeVideoRef()}
        frame={1005}
        calibration={calibration}
        fit={fit}
        lastFit={fit}
        selected="far_kitchen_centre"
        editable
        onPlace={onPlace}
        onSelect={onSelect}
        onBlocked={onBlocked}
      />,
    );
    const notVisibleGhost = container.querySelector<HTMLElement>(".landmark-highlight");
    expect(notVisibleGhost?.dataset.highlight).toBe("ghost");
    expect(notVisibleGhost?.style.left).toBe("50%");
    expect(notVisibleGhost?.style.top).toBe("36%");
  });

  it("renders a marker glow behind the selected marker (including flagged and other-frame markers) and follows drag", () => {
    const { container } = renderOverlay({ selected: "near_kitchen_left" });

    const layer = container.querySelector<HTMLElement>(".calibration-layer")!;
    const highlight = container.querySelector<HTMLElement>(".landmark-highlight")!;
    const marker = container.querySelector<HTMLButtonElement>(".landmark-marker.selected")!;

    expect(highlight.dataset.highlight).toBe("marker");
    expect(highlight.classList.contains("stale")).toBe(false);
    expect(highlight.style.left).toBe("20%");
    expect(highlight.style.top).toBe("60%");
    expect(marker.classList.contains("flagged")).toBe(true);
    // Highlight precedes markers in DOM order so it paints behind `.landmark-marker`.
    const children = Array.from(layer.children);
    expect(children.indexOf(highlight)).toBeLessThan(children.indexOf(marker));

    // Dragging moves the glow along with the marker.
    layer.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 1000,
        height: 500,
        right: 1000,
        bottom: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    layer.setPointerCapture = vi.fn<(pointerId: number) => void>();
    layer.hasPointerCapture = () => true;
    layer.releasePointerCapture = vi.fn<(pointerId: number) => void>();

    fireEvent.pointerDown(marker, { pointerId: 1, clientX: 200, clientY: 300 });
    fireEvent.pointerMove(layer, { pointerId: 1, clientX: 400, clientY: 250 });

    const draggedHighlight = container.querySelector<HTMLElement>(".landmark-highlight")!;
    expect(draggedHighlight.style.left).toBe("40%");
    expect(draggedHighlight.style.top).toBe("50%");
    // Loupe paints above the highlight in DOM order (and z-index).
    const loupe = container.querySelector<HTMLElement>(".loupe");
    expect(loupe).not.toBeNull();
    const updatedChildren = Array.from(layer.children);
    expect(updatedChildren.indexOf(draggedHighlight)).toBeLessThan(updatedChildren.indexOf(loupe!));
    cleanup();

    // Other-frame marker on reference_frame glows at its resolved position.
    const otherFrame = renderOverlay({ selected: "near_kitchen_right" });
    const otherHighlight = otherFrame.container.querySelector<HTMLElement>(".landmark-highlight")!;
    expect(otherHighlight.dataset.highlight).toBe("marker");
    expect(Number.parseFloat(otherHighlight.style.left)).toBeCloseTo(78);
    expect(Number.parseFloat(otherHighlight.style.top)).toBeCloseTo(58);
  });

  it("dims the ghost when the court template is stale, and hides ghosts on unmapped frames or when nothing is selected", () => {
    const calibration = makeCalibration();
    const fit = makeFit(calibration);

    // Off-ref with no Camera Motion frameMatrix -> static preview (stale) + other-frame Landmark has no marker here -> stale ghost.
    const offRef = renderOverlay({
      frame: 1030,
      calibration,
      fit,
      lastFit: fit,
      frameMatrix: undefined,
      selected: "near_kitchen_left",
    });
    const staleGhost = offRef.container.querySelector<HTMLElement>(".landmark-highlight");
    expect(staleGhost?.dataset.highlight).toBe("ghost");
    expect(staleGhost?.classList.contains("stale")).toBe(true);
    cleanup();

    // Unmapped frame: no ghost for unplaced Landmark, but marker glow still shows for one placed on this frame.
    const unmappedGhost = renderOverlay({
      frame: 1005,
      calibration,
      fit,
      lastFit: fit,
      unmapped: true,
      selected: "far_kitchen_right",
    });
    expect(unmappedGhost.container.querySelector(".landmark-highlight")).toBeNull();
    cleanup();

    const unmappedMarker = renderOverlay({
      frame: 1005,
      calibration,
      fit,
      lastFit: fit,
      unmapped: true,
      selected: "near_kitchen_left",
    });
    expect(
      unmappedMarker.container.querySelector<HTMLElement>(".landmark-highlight")?.dataset.highlight,
    ).toBe("marker");
    cleanup();

    // No Landmark selected -> nothing.
    const noneSelected = renderOverlay({ selected: null });
    expect(noneSelected.container.querySelector(".landmark-highlight")).toBeNull();
  });

  it("dims a ghost during !fit (using lastFit), keeps marker glows undimmed, and falls back to ghost when a resolved marker is out of frame", () => {
    const calibration = makeCalibration();
    const fit = makeFit(calibration);

    // `!fit` with `lastFit` present -> template is stale -> ghost dims with `.stale`.
    const savingGhost = renderOverlay({
      frame: 1005,
      calibration,
      fit: undefined,
      lastFit: fit,
      selected: "far_kitchen_right",
    });
    const staleGhost = savingGhost.container.querySelector<HTMLElement>(".landmark-highlight");
    expect(staleGhost?.dataset.highlight).toBe("ghost");
    expect(staleGhost?.classList.contains("stale")).toBe(true);
    cleanup();

    // `!fit` with a marker on this frame -> marker glow is never dimmed.
    const savingMarker = renderOverlay({
      frame: 1005,
      calibration,
      fit: undefined,
      lastFit: fit,
      selected: "near_kitchen_left",
    });
    const undimmedMarker = savingMarker.container.querySelector<HTMLElement>(".landmark-highlight");
    expect(undimmedMarker?.dataset.highlight).toBe("marker");
    expect(undimmedMarker?.classList.contains("stale")).toBe(false);
    cleanup();

    // On reference_frame, an other-frame Landmark whose resolved position is outside [0, 1]^2
    // has its marker filtered out and falls back to a ghost (never a phantom marker glow).
    const outOfFrameFit = makeFit(calibration, {
      resolved_landmarks: {
        near_kitchen_left: { x: 0.2, y: 0.6 },
        near_kitchen_right: { x: 1.5, y: 0.5 },
      },
    });
    const filteredOut = renderOverlay({
      frame: 1005,
      calibration,
      fit: outOfFrameFit,
      lastFit: outOfFrameFit,
      selected: "near_kitchen_right",
    });
    expect(filteredOut.container.querySelector(".landmark-marker.selected")).toBeNull();
    const fallbackHighlight =
      filteredOut.container.querySelector<HTMLElement>(".landmark-highlight");
    expect(fallbackHighlight?.dataset.highlight).toBe("ghost");
    // courtPoint("near_kitchen_right") = (10, -7) -> (0.9, 0.64).
    expect(Number.parseFloat(fallbackHighlight!.style.left)).toBeCloseTo(90);
    expect(Number.parseFloat(fallbackHighlight!.style.top)).toBeCloseTo(64);
  });
});
