# Key Camera Motion on the resolved Calibration fit

Extends [ADR 0006](0006-calibration-anchors-a-moving-camera.md) and [ADR 0012](0012-player-tracking-anchors-cache-and-settled.md).

Splitting a Play Segment changes its tracking bounds. It can also change off-reference Landmark registration. Chained registration requires the source and reference frames to belong to the same Play Segment. A split at a Calibration boundary can change the resolved fit while both tracked span bounds stay the same.

Camera Motion keys a span with off-reference Landmarks on the resolved `court_to_image` fit as well as the existing Calibration, span, video and method inputs. Existing entries for those Calibrations rebuild once. Spans that still match their keys remain reusable, including when an operator undoes a split.

Splitting uses the existing cache lookups to rebuild missing Camera Motion and mark missing Player Tracking as pending. Player Tracking samples each Play Segment from its own first frame and includes both endpoints, so an arbitrary split can require samples missing from the original cache. Its court solve also uses the new boundaries for trajectories and Settled. Running **Track Players** fills the missing detections and solves on the new Play Segments.
