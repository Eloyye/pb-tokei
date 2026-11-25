# Camera Motion trusts the painted lines over the clicks

_Extends [ADR 0006](0006-calibration-anchors-a-moving-camera.md). Extended by [ADR 0011](0011-camera-motion-carries-the-lens.md): the lens is part of each tracked frame's court mapping._

Measured against hand-labelled ground truth on the demo Match's Sideline View Play Segment (frames 3389–4612), Camera Motion put the far kitchen line up to 6.7 ft off and the far baseline 1.6–4.7 ft off while reporting median line errors under 0.05 ft (#59). Three things caused it:

- **The clicks.** Camera Motion took the clicked Landmark fit as exact on the reference frame and seeded every other frame from it. Those clicks were 1–3.5 ft off (two pinned to the frame edge), so every frame started feet away from the lines.
- **Snapping to the nearest ridge.** Line refinement snapped each line to its nearest bright ridge. From a start that far off, the far kitchen line locked onto the sponsor logo's edge, and lines out of reach dropped out of the fit.
- **Lens distortion.** The lens bows long lines past what a homography can follow (ADR 0011), so lines near the frame edges sat outside a narrow search around a fit to the middle of the frame.

So Camera Motion now:

- **Registers jointly.** It keeps several ridge candidates per line sample and finds straight-line hypotheses for each court line. It then scores homographies built from two lines across the court and two along it by how many samples on all eight lines they explain. A logo edge can pass for one line but not consistently with the court's geometry.
- **Registers the reference frame too.** The clicked Landmarks seed that search instead of being taken as exact. They are kept only when the registration does not verify.
- **Verifies both directions.** A frame is accepted only when at least two lines across the court and two along it are matched, so it cannot slide along the court unnoticed.

## Considered Options

- **Keep clicks exact and tighten the refinement window.** Rejected: an operator cannot click a far corner to the inch, and off-screen corners invite clicks pinned to the frame edge, so the error starts in the clicks themselves.

## Consequences

- At the reference frame the stored `frame_to_ref` matrix is a correction, not the identity, whenever registration succeeds. A Calibration's reported Landmark errors still describe the clicks.
- Tracking costs about twice as long, roughly 20 s per minute of 60 fps footage; results stay cached per Calibration (ADR 0006).
