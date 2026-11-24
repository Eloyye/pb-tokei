# Operators edit Calibration and Play Segments too; Event Processing never reads them

_Extended by [ADR 0006](0006-calibration-anchors-a-moving-camera.md): Tracking follows Camera Motion from each Calibration and caches per-frame motion outside the Rally Log as derived, rebuildable data._

ADR 0001 says operators edit nothing but the Rally Log, and that Broadcast Segmentation and Tracking produce Play Segments and court calibration. Until those layers are automated (#25 for Play Segments), an operator marks Play Segments and clicks each Camera View's Landmarks by hand (#10), and even afterwards an operator corrects them. So these two records are operator-edited as well. They are stored in the same DuckDB file as the Rally Log, under the Match, because they describe the same footage and are saved alongside it.

They stay out of Event Processing: stats are still computed from the Rally Log alone. Calibration only feeds Tracking, which turns clicked or detected image points into the court positions that the Rally Log then records as facts.

## Consequences

- A Calibration stores only its clicked Landmarks (normalised image points), never a fitted matrix: the court mapping is refitted from them whenever it is needed, so a better fitting method applies to every Match ever calibrated.
- Several Calibrations of one Camera View can exist, each in effect from a frame, because broadcast cameras zoom and pan. The one in effect at a frame is the latest of that view starting at or before it, or else the view's earliest.
- Fit quality is reported in feet on the court, with a leave-one-out error per Landmark, because what matters is placing Players in the right Zone (boundaries at 9, 12 and 18 ft), not matching the clicked pixels.
- ADR 0001 is partly superseded: its "operators edit nothing else" now reads "operators edit nothing else that Event Processing reads".
