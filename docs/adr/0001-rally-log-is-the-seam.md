# The Rally Log is the only hand-edited record; stats are derived from it

_Partly superseded by [ADR 0005](0005-operators-edit-calibration-and-play-segments.md): operators also edit Calibration and Play Segments, which Event Processing never reads._

The system is four layers, each with one output: Broadcast Segmentation produces Play Segments, Tracking produces per-frame player and ball positions plus court calibration, Annotation (human, model, or both) produces the Rally Log, and Event Processing produces stats. The Rally Log is the contract in the middle: operators and models both write it, operators edit nothing else, and Event Processing reads only the Rally Log, never Tracking. That lets stats be recomputed across all history whenever a rule changes, and lets annotation shift from human to model without touching stats.

## Consequences

- Each Shot in the Rally Log carries a snapshot of all four Players' positions at contact, so Event Processing can work out Rally Phases without reading Tracking.
- Movement and ball-flight analyses (court coverage, footwork, ball speed, projected landing) read Tracking directly; they are not Event Processing.
- Stats are never stored as hand-edited values; a wrong stat is fixed by fixing the Rally Log or the rule.
