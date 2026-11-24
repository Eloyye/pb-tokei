import type {
  Calibration,
  CalibrationOut,
  CameraMotionOut,
  CameraView,
  Landmark,
  LandmarkErrorOut,
  PlaySegment,
  UnmappedRangeOut,
} from "../api/client";
import {
  courtPoint,
  currentFit,
  LANDMARKS,
  landmarkLabel,
  reuseBlocker,
} from "../lib/calibrations";
import { VIEW_LABELS } from "../lib/segments";
import { Panel, PanelTitle } from "./Panel";

/**
 * Calibrate's right column: the Landmarks of the Calibration in effect at the playhead, each
 * with its error in feet, then every Calibration of each Camera View.
 */
export function CalibrationPanel({
  focused,
  frame,
  segment,
  calibration,
  calibrations,
  fits,
  motion,
  unmappedRange,
  selected,
  onSelect,
  onSeek,
  onDelete,
  onReuse,
  onReanchor,
  onRetrack,
}: {
  focused: boolean;
  frame: number;
  /** The Play Segment under the playhead. */
  segment: PlaySegment | undefined;
  /** The Calibration in effect there. */
  calibration: Calibration | undefined;
  calibrations: Calibration[];
  fits: Map<string, CalibrationOut>;
  motion: CameraMotionOut | null;
  /** The unmapped Camera Motion range at the playhead, if any. */
  unmappedRange: UnmappedRangeOut | undefined;
  selected: Landmark | null;
  onSelect: (landmark: Landmark) => void;
  onSeek: (frame: number) => void;
  onDelete: (view: CameraView, effectiveFrom: number) => void;
  /** Puts an earlier Calibration's points in effect from the current Play Segment's start. */
  onReuse: (source: Calibration) => void;
  /** Creates a new Calibration starting at the playhead frame to re-anchor Camera Motion. */
  onReanchor: () => void;
  /** Retries Camera Motion tracking after an error. */
  onRetrack: () => void;
}) {
  const fit = calibration && currentFit(fits, calibration);
  const placed = calibration ? Object.keys(calibration.landmarks).length : 0;
  return (
    <Panel id="calibration" focused={focused} tabs={<PanelTitle>Calibration</PanelTitle>}>
      <div className="panel-body calibration-panel">
        {segment ? (
          <section className="cal-current">
            <h3>
              {VIEW_LABELS[segment.camera_view]}
              <span>
                {calibration
                  ? `from frame ${calibration.effective_from_frame}`
                  : "not calibrated yet"}
              </span>
            </h3>
            <div className="cal-body">
              <LandmarkCourt
                points={calibration?.landmarks ?? {}}
                errors={fit?.errors ?? {}}
                selected={selected}
                onSelect={onSelect}
              />
              <ol className="landmarks">
                {LANDMARKS.map((landmark) => (
                  <li key={landmark}>
                    <button
                      type="button"
                      className={landmark === selected ? "selected" : ""}
                      aria-pressed={landmark === selected}
                      onClick={() => onSelect(landmark)}
                    >
                      <span>{landmarkLabel(landmark)}</span>
                      <ErrorCell
                        placed={Boolean(calibration?.landmarks[landmark])}
                        error={fit?.errors[landmark]}
                      />
                    </button>
                  </li>
                ))}
              </ol>
            </div>
            <p className={`fit-summary ${fit?.needs_attention ? "flagged" : ""}`}>
              {fitSummary(placed, fit)}
            </p>
            {unmappedRange && (
              <div className="motion-unmapped-callout">
                <span>
                  Tracking lost on frames {unmappedRange.start_frame}–{unmappedRange.end_frame}.
                  Positions here are Unknown.
                </span>
                <button type="button" className="button" onClick={onReanchor}>
                  New Calibration at frame {frame}
                </button>
              </div>
            )}
          </section>
        ) : (
          <p className="empty">
            Go to a Play Segment to calibrate its Camera View. Mark one with Shift+I and Shift+O.
          </p>
        )}
        <CameraMotionSection motion={motion} onSeek={onSeek} onRetrack={onRetrack} />
        {(["main", "sideline"] as const).map((view) => (
          <CalibrationList
            key={view}
            view={view}
            calibrations={calibrations.filter((c) => c.camera_view === view)}
            all={calibrations}
            fits={fits}
            current={calibration}
            segment={segment}
            onSeek={onSeek}
            onDelete={onDelete}
            onReuse={onReuse}
          />
        ))}
        <p className="cal-keys">
          <kbd>Click</kbd> place · <kbd>Tab</kbd> skip · <kbd>X</kbd> clear · <kbd>N</kbd> new
          Calibration from this Play Segment
        </p>
      </div>
    </Panel>
  );
}

function fitSummary(placed: number, fit: CalibrationOut | undefined): string {
  if (placed === 0) return "Click the highlighted Landmark on the video.";
  if (!fit) return "Fitting…";
  if (!fit.complete) return "Incomplete: place at least 4 Landmarks, not all on one line.";
  if (fit.worst_error_ft === null) return "A Landmark is off the court: move it onto its line.";
  return `Worst error ${fit.worst_error_ft.toFixed(2)} ft${fit.needs_attention ? ": check the flagged Landmarks" : ""}`;
}

function ErrorCell({ placed, error }: { placed: boolean; error: LandmarkErrorOut | undefined }) {
  if (!placed) return <span className="error-cell unplaced">—</span>;
  if (!error) return <span className="error-cell">placed</span>;
  const feet = error.leave_one_out_ft ?? error.residual_ft;
  return (
    <span
      className={`error-cell ${error.needs_attention ? "flagged" : ""}`}
      title={
        error.leave_one_out_ft !== null
          ? "Leave-one-out error: how far off the fit without this Landmark puts it"
          : "Error of the fit including this Landmark"
      }
    >
      {error.off_court ? "off court" : `${feet?.toFixed(2)} ft`}
    </span>
  );
}

function CalibrationList({
  view,
  calibrations,
  all,
  fits,
  current,
  segment,
  onSeek,
  onDelete,
  onReuse,
}: {
  view: CameraView;
  calibrations: Calibration[];
  /** Every Calibration, both views: what "Use here" checks against. */
  all: Calibration[];
  fits: Map<string, CalibrationOut>;
  current: Calibration | undefined;
  segment: PlaySegment | undefined;
  onSeek: (frame: number) => void;
  onDelete: (view: CameraView, effectiveFrom: number) => void;
  onReuse: (source: Calibration) => void;
}) {
  return (
    <section className="cal-view">
      <h3>
        {VIEW_LABELS[view]} Calibrations <span>{calibrations.length}</span>
      </h3>
      {calibrations.length === 0 ? (
        <p className="empty">None yet: click Landmarks on a {VIEW_LABELS[view]} Play Segment.</p>
      ) : (
        <ul>
          {calibrations
            .toSorted((a, b) => a.effective_from_frame - b.effective_from_frame)
            .map((c) => {
              const fit = currentFit(fits, c);
              // The Play Segment under the playhead, if "Use here" can put these points on it.
              const reuseOn =
                segment && reuseBlocker(all, c, segment) === null ? segment : undefined;
              const worst = fit ? fitWorst(fit) : "…";
              return (
                <li key={c.effective_from_frame} className={c === current ? "current" : ""}>
                  <button
                    type="button"
                    title={`Go to frame ${c.reference_frame}, where it was clicked`}
                    onClick={() => onSeek(c.reference_frame)}
                  >
                    from frame {c.effective_from_frame}
                    <span className={fit?.needs_attention ? "flagged" : ""}>{worst}</span>
                  </button>
                  {reuseOn && (
                    <button
                      type="button"
                      className="icon-button reuse"
                      title={`The camera is back at this angle: use these points from frame ${reuseOn.start_frame}`}
                      onClick={() => onReuse(c)}
                    >
                      Use here
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete the ${VIEW_LABELS[view]} Calibration from frame ${c.effective_from_frame}`}
                    title="Delete this Calibration"
                    onClick={() => onDelete(view, c.effective_from_frame)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
        </ul>
      )}
    </section>
  );
}

function CameraMotionSection({
  motion,
  onSeek,
  onRetrack,
}: {
  motion: CameraMotionOut | null;
  onSeek: (frame: number) => void;
  onRetrack: () => void;
}) {
  if (!motion || motion.status === "no_video" || motion.total_spans === 0) return null;
  const unmappedCount = motion.unmapped_ranges.reduce(
    (sum, r) => sum + (r.end_frame - r.start_frame + 1),
    0,
  );
  return (
    <section className="cal-view cal-motion">
      <h3>
        Camera Motion
        <span className={unmappedCount > 0 || motion.status === "error" ? "flagged" : ""}>
          {motion.status === "tracking"
            ? `tracking ${motion.tracked_spans}/${motion.total_spans}…`
            : motion.status === "error"
              ? "failed"
              : unmappedCount > 0
                ? `${unmappedCount} unmapped`
                : "all mapped"}
        </span>
      </h3>
      {motion.status === "error" && (
        <p className="fit-summary flagged">
          {motion.error ?? "Camera Motion tracking failed."}{" "}
          <button type="button" className="icon-button" onClick={onRetrack}>
            Retry
          </button>
        </p>
      )}
      {motion.unmapped_ranges.length > 0 && (
        <ul>
          {motion.unmapped_ranges.map((range) => {
            const count = range.end_frame - range.start_frame + 1;
            return (
              <li key={`${range.camera_view}:${range.start_frame}-${range.end_frame}`}>
                <button
                  type="button"
                  title={`Go to unmapped ${VIEW_LABELS[range.camera_view]} frames ${range.start_frame}–${range.end_frame}`}
                  onClick={() => onSeek(range.start_frame)}
                >
                  <span>
                    {VIEW_LABELS[range.camera_view]} · {range.start_frame}–{range.end_frame}
                  </span>
                  <span className="flagged">{count}f</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function fitWorst(fit: CalibrationOut): string {
  if (!fit.complete) return "incomplete";
  return fit.worst_error_ft === null ? "off court" : `${fit.worst_error_ft.toFixed(2)} ft`;
}

/** Feet to the mini court's SVG units: 4 to the foot, the near (Main View camera's) end down. */
const X = (feet: number) => feet * 4;
const Y = (feet: number) => -feet * 4;

/** A small top-down court with the 12 Landmarks: placed ones filled, the selected one ringed. */
function LandmarkCourt({
  points,
  errors,
  selected,
  onSelect,
}: {
  points: Calibration["landmarks"];
  errors: CalibrationOut["errors"];
  selected: Landmark | null;
  onSelect: (landmark: Landmark) => void;
}) {
  return (
    <svg className="landmark-court" viewBox="-52 -100 104 200" role="img" aria-label="Landmarks">
      <rect className="line" x={X(-10)} y={Y(22)} width={X(20)} height={X(44)} />
      {[-7, 7].map((y) => (
        <line key={y} className="line" x1={X(-10)} y1={Y(y)} x2={X(10)} y2={Y(y)} />
      ))}
      <line className="line" x1={0} y1={Y(-22)} x2={0} y2={Y(-7)} />
      <line className="line" x1={0} y1={Y(7)} x2={0} y2={Y(22)} />
      <line className="net" x1={X(-11)} y1={0} x2={X(11)} y2={0} />
      {LANDMARKS.map((landmark) => {
        const at = courtPoint(landmark);
        const classes = [
          "dot",
          points[landmark] ? "placed" : "",
          landmark === selected ? "selected" : "",
          errors[landmark]?.needs_attention ? "flagged" : "",
        ];
        return (
          <circle
            key={landmark}
            className={classes.join(" ")}
            cx={X(at.x)}
            cy={Y(at.y)}
            r={4}
            onClick={() => onSelect(landmark)}
          >
            <title>{landmarkLabel(landmark)}</title>
          </circle>
        );
      })}
    </svg>
  );
}
