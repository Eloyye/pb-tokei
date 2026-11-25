# Camera Motion carries the lens into the court mapping

_Extends [ADR 0010](0010-painted-lines-outrank-clicks-in-camera-motion.md)._

A broadcast lens bows straight court lines near the frame edges: on the demo Match's Sideline View the bottom sideline bends 16–18 px across a 1080p frame. No homography can follow that. Fitted to the whole frame, a homography is about 0.65 ft off at the baselines. Fitted to the middle, it is 1.5 ft off there.

Camera Motion therefore models the lens with one radial coefficient about the frame centre. It estimates it on each Calibration's reference frame by straightening the court lines it registers (k1 ≈ 0.09 on the demo footage, in half-diagonals, steady across the span). It then matches lines in the undistorted image, where they are straight.

The lens is carried through, not flattened away:

- **Camera Motion.** Each `SpanMotion` stores its `Lens` (cached with it). Its per-frame matrices map the frame's undistorted image to the reference frame.
- **Court mapping.** `CourtMapping.at` returns a `Homography` that carries the lens: `to_court` undistorts an image point first, and `to_image` distorts a mapped point back into the frame.
- **API and overlay.** The Camera Motion frames API sends each frame's lens beside its `court_to_image` matrix. The Calibrate overlay bends the projected court lines through it, so the template follows the bowed paint.

Measured against hand-labelled ground truth on 9 frames of the demo Sideline View, every court line is within 0.29 ft, the far kitchen line within 0.09 ft and the far baseline within 0.26 ft. Storing the closest plain homography instead left the far baseline up to 0.52 ft off.

## Considered Options

- **Store the plain homography closest to the lens-corrected mapping.** This keeps the matrix-only contract and needs no API or overlay change. Rejected: the remaining error lands at the frame corners, which is the far side, exactly where feet matter most.
- **Fit the Calibration's own Landmark fit through the lens.** Rejected for now. The lens is only known once Camera Motion has tracked the span, while a Calibration is assessed (and its Landmark errors shown) as soon as it is clicked. Undistorting the clicks would make the clicked fit, and its reported errors, depend on cached tracking. The clicked fit only seeds registration and stands in before tracking (ADR 0010), so it stays lens-free and describes the clicks as placed.
- **A richer lens model (two radial coefficients, a free centre).** Not needed yet. One coefficient fits the demo footage to about 1 px RMS at 1080p, against 0.75 px with two.

## Consequences

- A tracked frame's court mapping is no longer a single matrix. Anything that maps points must go through `Homography.to_court` / `to_image`, or apply the lens itself, as the overlay does.
- A Calibration's static fit (`CalibrationOut.court_to_image`) has no lens and is drawn straight. It only shows before a span is tracked, or when tracking fails.
- The lens is estimated per Calibration span, so a zoom that changes the lens noticeably calls for a re-anchor (a new Calibration), as a lost track does.
- `METHOD_VERSION` is 3, so cached Camera Motion rebuilds.
