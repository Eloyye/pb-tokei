import type { ReactNode } from "react";
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
  isCarriedOver,
  isInFramePoint,
  landmarkCounts,
  LANDMARKS,
  landmarkLabel,
  reuseBlocker,
} from "../lib/calibrations";
import { VIEW_LABELS } from "../lib/segments";
import { Panel, PanelTitle } from "./Panel";

export type CalibrateTab = "landmarks" | "players";

/**
 * Calibrate's right column: `Landmarks | Players` tab switch. Under `Landmarks`, shows the
 * Calibration in effect at the playhead and all Calibrations of each Camera View; under
 * `Players`, renders the Player Tracking panel.
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
  onMarkNotVisible,
  onClearLandmark,
  onConfirmLandmark,
  onConfirmAll,
  onRetrack,
  activeTab = "landmarks",
  onTabChange,
  playersPanel,
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
  /** Marks a Landmark as not visible in the active Calibration. */
  onMarkNotVisible: (landmark: Landmark) => void;
  /** Clears a placed or not-visible Landmark back to remaining. */
  onClearLandmark: (landmark: Landmark) => void;
  /** Confirms a placed Landmark from another frame onto the playhead frame. */
  onConfirmLandmark: (landmark: Landmark) => void;
  /** Confirms all off-frame Landmarks onto the playhead frame. */
  onConfirmAll: () => void;
  /** Retries Camera Motion tracking after an error. */
  onRetrack: () => void;
  /** Active tab in the Calibrate right panel (`Landmarks` or `Players`). */
  activeTab?: CalibrateTab;
  onTabChange?: (tab: CalibrateTab) => void;
  /** Content rendered when the `Players` tab is active. */
  playersPanel?: ReactNode;
}) {
  const fit = calibration && currentFit(fits, calibration);
  const counts = landmarkCounts(calibration);
  const notVisibleSet = new Set(calibration?.not_visible ?? []);
  const unmappedSet = new Set(fit?.unmapped_landmarks ?? []);
  const onRef = !calibration || frame === calibration.reference_frame;
  const carriedOverCount =
    calibration && segment
      ? Object.values(calibration.landmarks).filter(
          (p) => p && isCarriedOver(p.frame, calibration.reference_frame, segment),
        ).length
      : 0;
  const selectedPlaced = selected ? calibration?.landmarks[selected] : undefined;
  const selectedNotVisible = selected ? notVisibleSet.has(selected) : false;
  const confirmableCount =
    calibration && onRef
      ? LANDMARKS.filter((lm) => {
          const placed = calibration.landmarks[lm];
          return (
            placed &&
            placed.frame !== calibration.reference_frame &&
            isInFramePoint(fit?.resolved_landmarks[lm])
          );
        }).length
      : 0;
  const canConfirmSelected = Boolean(
    onRef &&
    selected &&
    selectedPlaced &&
    selectedPlaced.frame !== frame &&
    isInFramePoint(fit?.resolved_landmarks[selected]),
  );

  const tabs = onTabChange ? (
    <div role="tablist" aria-label="Calibrate" style={{ display: "flex" }}>
      {(["landmarks", "players"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={activeTab === t}
          className={`panel-tab ${activeTab === t ? "active" : ""}`}
          onClick={() => onTabChange(t)}
        >
          {t === "landmarks" ? "Landmarks" : "Players"}
        </button>
      ))}
    </div>
  ) : (
    <PanelTitle>Calibration</PanelTitle>
  );

  if (activeTab === "players" && playersPanel) {
    return (
      <Panel id="calibration" focused={focused} tabs={tabs}>
        {playersPanel}
      </Panel>
    );
  }

  return (
    <Panel id="calibration" focused={focused} tabs={tabs}>
      <div className="panel-body calibration-panel">
        {segment ? (
          <section className="cal-current">
            <h3>
              {VIEW_LABELS[segment.camera_view]}
              <span>
                {calibration
                  ? `from frame ${calibration.effective_from_frame} · ref ${calibration.reference_frame}`
                  : "not calibrated yet"}
              </span>
            </h3>
            <p className="cal-counts">
              <span>{counts.placed} placed</span>
              <span aria-hidden>·</span>
              <span>{counts.notVisible} not visible</span>
              <span aria-hidden>·</span>
              <span>{counts.remaining} remaining</span>
            </p>
            {calibration && (counts.otherFrame > 0 || !onRef) && (
              <div className="cal-frame-bar">
                <span>
                  {carriedOverCount > 0
                    ? `${counts.confirmedOnRef} confirmed on ref ${calibration.reference_frame} · ${carriedOverCount} carried over`
                    : counts.otherFrame > 0
                      ? `${counts.confirmedOnRef} on ref ${calibration.reference_frame} · ${counts.otherFrame} from other ${counts.otherFrame === 1 ? "frame" : "frames"}`
                      : `Viewing frame ${frame} · clicks map to ref ${calibration.reference_frame}`}
                </span>
                <div className="cal-frame-actions">
                  {!onRef && (
                    <button
                      type="button"
                      className="icon-button"
                      title={`Seek to reference frame ${calibration.reference_frame}`}
                      onClick={() => onSeek(calibration.reference_frame)}
                    >
                      Go to ref {calibration.reference_frame}
                    </button>
                  )}
                  {onRef && confirmableCount > 0 && (
                    <button
                      type="button"
                      className="icon-button"
                      title={`Confirm ${confirmableCount} mapped off-reference ${confirmableCount === 1 ? "Landmark" : "Landmarks"} on frame ${frame}`}
                      onClick={onConfirmAll}
                    >
                      Confirm all on f{frame}
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="cal-body">
              <LandmarkCourt
                calibration={calibration}
                errors={fit?.errors ?? {}}
                unmapped={unmappedSet}
                selected={selected}
                onSelect={onSelect}
              />
              <ol className="landmarks">
                {LANDMARKS.map((landmark) => {
                  const placed = calibration?.landmarks[landmark];
                  const isNotVisible = notVisibleSet.has(landmark);
                  const isOffRef = Boolean(
                    placed && calibration && placed.frame !== calibration.reference_frame,
                  );
                  const carried = Boolean(
                    placed &&
                    calibration &&
                    isCarriedOver(placed.frame, calibration.reference_frame, segment),
                  );
                  const isUnmapped = unmappedSet.has(landmark);
                  return (
                    <li key={landmark}>
                      <button
                        type="button"
                        className={`${landmark === selected ? "selected" : ""} ${isNotVisible ? "not-visible" : ""}`}
                        aria-pressed={landmark === selected}
                        onClick={() => onSelect(landmark)}
                      >
                        <span className="landmark-name">
                          {landmarkLabel(landmark)}
                          {isOffRef && placed && (
                            <span
                              className={`frame-tag ${carried ? "carried" : ""}`}
                              title={
                                carried
                                  ? `Carried over from frame ${placed.frame} (reference frame is ${calibration?.reference_frame})`
                                  : `Clicked on frame ${placed.frame} (mapped to reference frame ${calibration?.reference_frame})`
                              }
                            >
                              {carried ? `carried f${placed.frame}` : `f${placed.frame}`}
                            </span>
                          )}
                        </span>
                        <ErrorCell
                          placed={Boolean(placed)}
                          notVisible={isNotVisible}
                          unmapped={isUnmapped}
                          clickedFrame={placed?.frame}
                          referenceFrame={calibration?.reference_frame}
                          error={fit?.errors[landmark]}
                        />
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
            {selected && (
              <div className="cal-selected-actions">
                <button
                  type="button"
                  className="button"
                  disabled={selectedNotVisible}
                  title="Mark the selected Landmark as not visible (V)"
                  onClick={() => onMarkNotVisible(selected)}
                >
                  Not visible <kbd>V</kbd>
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={!selectedPlaced && !selectedNotVisible}
                  title="Clear the selected Landmark back to remaining (X)"
                  onClick={() => onClearLandmark(selected)}
                >
                  Clear <kbd>X</kbd>
                </button>
                {canConfirmSelected && (
                  <button
                    type="button"
                    className="button"
                    title={`Confirm ${landmarkLabel(selected)} on frame ${frame} (C)`}
                    onClick={() => onConfirmLandmark(selected)}
                  >
                    Confirm on f{frame} <kbd>C</kbd>
                  </button>
                )}
              </div>
            )}
            <p className={`fit-summary ${fit?.needs_attention ? "flagged" : ""}`}>
              {fitSummary(counts.placed, fit)}
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
          <kbd>Click</kbd> place · <kbd>V</kbd> not visible · <kbd>C</kbd> confirm · <kbd>Tab</kbd>{" "}
          skip · <kbd>X</kbd> clear · <kbd>N</kbd> new Calibration
        </p>
      </div>
    </Panel>
  );
}

function fitSummary(placed: number, fit: CalibrationOut | undefined): string {
  if (placed === 0)
    return "Click the highlighted Landmark on the video, or press V if not visible.";
  if (!fit) return "Fitting…";
  const unmappedCount = fit.unmapped_landmarks.length;
  if (!fit.complete) {
    if (unmappedCount > 0) {
      return `Incomplete: ${unmappedCount} off-reference ${unmappedCount === 1 ? "Landmark" : "Landmarks"} couldn't be mapped to the reference frame.`;
    }
    return "Incomplete: place at least 4 Landmarks, not all on one line.";
  }
  if (fit.worst_error_ft === null) return "A Landmark is off the court: move it onto its line.";
  const base = `Worst error ${fit.worst_error_ft.toFixed(2)} ft`;
  if (unmappedCount > 0) {
    return `${base} · ${unmappedCount} unmapped from other ${unmappedCount === 1 ? "frame" : "frames"}`;
  }
  return `${base}${fit.needs_attention ? ": check the flagged Landmarks" : ""}`;
}

function ErrorCell({
  placed,
  notVisible,
  unmapped,
  clickedFrame,
  referenceFrame,
  error,
}: {
  placed: boolean;
  notVisible: boolean;
  unmapped: boolean;
  clickedFrame: number | undefined;
  referenceFrame: number | undefined;
  error: LandmarkErrorOut | undefined;
}) {
  if (notVisible) return <span className="error-cell not-visible">not visible</span>;
  if (!placed) return <span className="error-cell unplaced">—</span>;
  if (unmapped) {
    return (
      <span
        className="error-cell flagged"
        title={`Could not register frame ${clickedFrame} to reference frame ${referenceFrame}: re-click or confirm on the reference frame`}
      >
        unmapped
      </span>
    );
  }
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
              : motion.status === "idle"
                ? "needs tracking"
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

/** A small top-down court with the 12 Landmarks: placed ones filled, not visible dimmed, selected ringed. */
function LandmarkCourt({
  calibration,
  errors,
  unmapped,
  selected,
  onSelect,
}: {
  calibration: Calibration | undefined;
  errors: CalibrationOut["errors"];
  unmapped: ReadonlySet<Landmark>;
  selected: Landmark | null;
  onSelect: (landmark: Landmark) => void;
}) {
  const points = calibration?.landmarks ?? {};
  const notVisible = new Set(calibration?.not_visible ?? []);
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
        const placed = points[landmark];
        const otherFrame = Boolean(
          placed && calibration && placed.frame !== calibration.reference_frame,
        );
        const isNotVisible = notVisible.has(landmark);
        const classes = [
          "dot",
          placed ? "placed" : "",
          otherFrame ? "other-frame" : "",
          isNotVisible ? "not-visible" : "",
          landmark === selected ? "selected" : "",
          errors[landmark]?.needs_attention || unmapped.has(landmark) ? "flagged" : "",
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
            <title>
              {landmarkLabel(landmark)}
              {isNotVisible
                ? " (not visible)"
                : otherFrame && placed
                  ? ` (frame ${placed.frame})`
                  : ""}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}
