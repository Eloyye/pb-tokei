import type {
  Calibration,
  CalibrationOut,
  CameraView,
  Landmark,
  LandmarkErrorOut,
  PlaySegment,
} from "../api/client";
import { courtPoint, currentFit, LANDMARKS, landmarkLabel } from "../lib/calibrations";
import { VIEW_LABELS } from "../lib/segments";
import { Panel, PanelTitle } from "./Panel";

/**
 * Calibrate's right column: the Landmarks of the Calibration in effect at the playhead, each
 * with its error in feet, then every Calibration of each Camera View.
 */
export function CalibrationPanel({
  focused,
  segment,
  calibration,
  calibrations,
  fits,
  selected,
  onSelect,
  onSeek,
  onDelete,
}: {
  focused: boolean;
  /** The Play Segment under the playhead. */
  segment: PlaySegment | undefined;
  /** The Calibration in effect there. */
  calibration: Calibration | undefined;
  calibrations: Calibration[];
  fits: Map<string, CalibrationOut>;
  selected: Landmark | null;
  onSelect: (landmark: Landmark) => void;
  onSeek: (frame: number) => void;
  onDelete: (view: CameraView, effectiveFrom: number) => void;
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
          </section>
        ) : (
          <p className="empty">
            Go to a Play Segment to calibrate its Camera View. Mark one with Shift+I and Shift+O.
          </p>
        )}
        {(["main", "sideline"] as const).map((view) => (
          <CalibrationList
            key={view}
            view={view}
            calibrations={calibrations.filter((c) => c.camera_view === view)}
            fits={fits}
            current={calibration}
            onSeek={onSeek}
            onDelete={onDelete}
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
  fits,
  current,
  onSeek,
  onDelete,
}: {
  view: CameraView;
  calibrations: Calibration[];
  fits: Map<string, CalibrationOut>;
  current: Calibration | undefined;
  onSeek: (frame: number) => void;
  onDelete: (view: CameraView, effectiveFrom: number) => void;
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
