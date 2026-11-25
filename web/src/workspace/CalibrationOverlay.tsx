import {
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Calibration, CalibrationOut, Landmark, Lens } from "../api/client";
import {
  COURT_LINES,
  landmarkHighlight,
  landmarkLabel,
  type Point,
  projectLine,
  visibleLandmarkMarkers,
} from "../lib/calibrations";

/** How much the magnifier enlarges, and its size on screen in CSS pixels. */
const ZOOM = 4;
const LOUPE = 132;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Calibrate's layer over the Monitor: the fitted court template, the clicked Landmarks, and a 4×
 * magnifier while placing or dragging one. It covers exactly the picture inside the `<video>`
 * (which is letterboxed by `object-fit: contain`), so its fractions are image coordinates.
 */
export function CalibrationOverlay({
  videoRef,
  frame,
  calibration,
  fit,
  lastFit,
  frameMatrix,
  frameLens,
  unmapped,
  selected,
  editable,
  onPlace,
  onSelect,
  onBlocked,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The frame currently on screen. */
  frame: number;
  /** The Calibration in effect at the playhead, if any. */
  calibration: Calibration | undefined;
  /** Its fit, only when the server has fitted its current Landmarks. */
  fit: CalibrationOut | undefined;
  /**
   * The last fit returned for it, which lags an edit until it is saved. Its court template is
   * drawn dimmed meanwhile, so the lines don't flicker on every click; Landmark flags wait for
   * the current fit.
   */
  lastFit: CalibrationOut | undefined;
  /**
   * Per-frame Camera Motion `court_to_image` matrix when tracked: `number[][]` when mapped,
   * `null` when explicitly unmapped, `undefined` when not tracked yet (falls back to static fit).
   */
  frameMatrix?: number[][] | null;
  /**
   * The lens that bends `frameMatrix`'s image into the frame, so the template follows the bowed
   * painted lines (ADR 0011). Only used with `frameMatrix`; a static fit is drawn straight.
   */
  frameLens?: Lens | null;
  /** Whether Camera Motion failed to register this frame (positions are Unknown). */
  unmapped?: boolean;
  selected: Landmark | null;
  /** Whether the playhead is on a Play Segment, so clicks calibrate its Camera View. */
  editable: boolean;
  onPlace: (landmark: Landmark, point: Point, how: "click" | "drag") => void;
  onSelect: (landmark: Landmark) => void;
  /** A click that can't place anything, with the reason. */
  onBlocked: (reason: string) => void;
}) {
  const rect = usePictureRect(videoRef);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [drag, setDrag] = useState<{ landmark: Landmark; from: Point; at: Point } | null>(null);

  // The magnifier redraws from the video whenever the pointer moves.
  const showLoupe = editable && pointer !== null && (drag !== null || selected !== null);
  useEffect(() => {
    const canvas = loupeRef.current;
    const video = videoRef.current;
    if (!showLoupe || !canvas || !video || !pointer || video.videoWidth === 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = LOUPE * scale;
    canvas.height = LOUPE * scale;
    // The source square spans LOUPE / ZOOM CSS pixels of the picture, in video pixels.
    const span = (LOUPE / ZOOM) * (video.videoWidth / (rect?.width || video.videoWidth));
    const cx = pointer.x * video.videoWidth;
    const cy = pointer.y * video.videoHeight;
    context.imageSmoothingEnabled = false;
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      video,
      cx - span / 2,
      cy - span / 2,
      span,
      span,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }, [showLoupe, pointer, videoRef, rect]);

  if (!rect) return null;

  const offRef = Boolean(calibration && frame !== calibration.reference_frame);
  const markers = visibleLandmarkMarkers(calibration, frame, fit, drag);

  const tracked = !unmapped && frameMatrix !== undefined;
  const matrix = unmapped ? null : tracked ? frameMatrix : (fit ?? lastFit)?.court_to_image;
  const lens = tracked ? (frameLens ?? null) : null;
  const staticOffRef = offRef && frameMatrix === undefined && !unmapped;
  const templateStale = !fit || staticOffRef;
  const highlight = landmarkHighlight({
    selected,
    calibration,
    frame,
    resolvedLandmarks: fit?.resolved_landmarks,
    drag,
    matrix,
    lens,
  });

  return (
    <div
      className={`calibration-layer ${editable ? "editable" : ""} ${selected ? "placing" : ""}`}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      onPointerMove={(event) => {
        const at = fraction(event);
        setPointer(at);
        if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) {
          setDrag({ ...drag, at });
        }
      }}
      onPointerLeave={() => setPointer(null)}
      onPointerDown={(event) => {
        if (!editable)
          return onBlocked("Mark a Play Segment first: Calibration is per Camera View");
        if (!selected) return onBlocked("No remaining Landmarks: pick one in the list to move it");
        onPlace(selected, fraction(event), "click");
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        // A press without a move only selects the Landmark.
        if (drag.at.x !== drag.from.x || drag.at.y !== drag.from.y)
          onPlace(drag.landmark, drag.at, "drag");
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {matrix && (
        <svg
          className={`court-template ${templateStale ? "stale" : ""}`}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden
        >
          {COURT_LINES.flatMap((courtLine, i) =>
            projectLine(matrix, courtLine, lens).map((run, j) => (
              <polyline
                key={`${i}-${j}`}
                className={courtLine.dashed ? "zone" : "line"}
                points={run.map((p) => `${p.x},${p.y}`).join(" ")}
                vectorEffect="non-scaling-stroke"
              />
            )),
          )}
        </svg>
      )}
      {highlight.kind !== "none" && (
        <div
          className={`landmark-highlight ${highlight.kind === "ghost" && templateStale ? "stale" : ""}`}
          data-highlight={highlight.kind}
          style={{ left: `${highlight.at.x * 100}%`, top: `${highlight.at.y * 100}%` }}
          aria-hidden
        />
      )}
      {unmapped ? (
        <output className="unmapped-banner">
          UNMAPPED · Camera Motion lost (positions Unknown)
        </output>
      ) : (
        offRef &&
        calibration && (
          <output className="off-ref-banner">
            REF FRAME {calibration.reference_frame} ·{" "}
            {staticOffRef ? "static preview (not tracked yet)" : "clicks here map to ref"}
          </output>
        )
      )}
      {markers.map(({ landmark, index, at, otherFrame, clickedFrame, flagged }) => (
        <button
          key={landmark}
          type="button"
          className={`landmark-marker ${landmark === selected ? "selected" : ""} ${flagged ? "flagged" : ""} ${otherFrame ? "other-frame" : ""}`}
          style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
          title={
            otherFrame
              ? `${index + 1}. ${landmarkLabel(landmark)} (clicked on frame ${clickedFrame}): drag to place on frame ${frame}`
              : `${index + 1}. ${landmarkLabel(landmark)}: drag to move`
          }
          aria-label={landmarkLabel(landmark)}
          onPointerDown={(event) => {
            event.stopPropagation();
            if (!editable) return;
            onSelect(landmark);
            // Capture on the layer, which tracks the drag across the picture.
            event.currentTarget.parentElement?.setPointerCapture(event.pointerId);
            setDrag({ landmark, from: at, at });
          }}
        >
          <span>{index + 1}</span>
        </button>
      ))}
      {showLoupe && pointer && (
        <div
          className="loupe"
          style={{
            // Beside the pointer, flipped to stay inside the picture.
            left: pointer.x * rect.width + (pointer.x > 0.75 ? -LOUPE - 18 : 18),
            top: pointer.y * rect.height + (pointer.y > 0.7 ? -LOUPE - 18 : 18),
            width: LOUPE,
            height: LOUPE,
          }}
        >
          <canvas ref={loupeRef} />
          <span className="loupe-label">
            {drag ? landmarkLabel(drag.landmark) : selected && landmarkLabel(selected)}
          </span>
        </div>
      )}
    </div>
  );
}

/** Where a pointer is across the picture, as image coordinates from 0 to 1. */
function fraction(event: PointerEvent<HTMLElement>): Point {
  const box = event.currentTarget.closest(".calibration-layer")!.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
    y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
  };
}

/** Where the picture sits inside the `<video>` box once letterboxed, kept current on resize. */
function usePictureRect(videoRef: RefObject<HTMLVideoElement | null>): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () => {
      const { clientWidth: bw, clientHeight: bh, videoWidth: vw, videoHeight: vh } = video;
      if (!vw || !vh || !bw || !bh) return setRect(null);
      const scale = Math.min(bw / vw, bh / vh);
      const width = vw * scale;
      const height = vh * scale;
      setRect({
        left: video.offsetLeft + (bw - width) / 2,
        top: video.offsetTop + (bh - height) / 2,
        width,
        height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(video);
    video.addEventListener("loadedmetadata", measure);
    return () => {
      observer.disconnect();
      video.removeEventListener("loadedmetadata", measure);
    };
  }, [videoRef]);
  return rect;
}
