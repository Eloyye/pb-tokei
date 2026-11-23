/**
 * A top-down court in feet, 10 SVG units to the foot. The near end (negative `y`, the Main View
 * camera's end) is at the bottom so it lines up with the video. Zone bands are shaded:
 * Frontcourt 0–9 ft, Midcourt 9–18 ft, Backcourt 18 ft and beyond; ticks mark 12 ft, where an
 * Established Team stops being Established.
 */
/** Feet from the net to SVG `y`: the far end is up. */
function Y(feet: number): number {
  return -feet * 10;
}

export function CourtDiagram({ nearTeam, farTeam }: { nearTeam: string; farTeam: string }) {
  const sides = [-1, 1] as const;
  return (
    <svg className="court" viewBox="-140 -250 280 500" role="img" aria-label="Court diagram">
      <rect className="surround" x={-140} y={-250} width={280} height={500} />
      {sides.map((s) => (
        <g key={s}>
          <rect
            className="zone-bc"
            x={-100}
            y={Math.min(Y(s * 18), Y(s * 22))}
            width={200}
            height={40}
          />
          <rect
            className="zone-mc"
            x={-100}
            y={Math.min(Y(s * 9), Y(s * 18))}
            width={200}
            height={90}
          />
          <rect className="zone-fc" x={-100} y={Math.min(0, Y(s * 9))} width={200} height={90} />
          {[9, 18].map((d) => (
            <line key={d} className="band" x1={-100} y1={Y(s * d)} x2={100} y2={Y(s * d)} />
          ))}
          <line className="line" x1={-106} y1={Y(s * 12)} x2={-100} y2={Y(s * 12)} />
          <line className="line" x1={100} y1={Y(s * 12)} x2={106} y2={Y(s * 12)} />
          <text className="label" x={108} y={Y(s * 12) + 3}>
            12
          </text>
          <text className="label" x={-134} y={Y(s * 9) + 3}>
            9
          </text>
          <text className="label" x={-138} y={Y(s * 18) + 3}>
            18
          </text>
          <text className="zone-label" x={-94} y={Y(s * 4.5) + 3}>
            FC
          </text>
          <text className="zone-label" x={-94} y={Y(s * 13.5) + 3}>
            MC
          </text>
          <text className="zone-label" x={-94} y={Y(s * 20) + 3}>
            BC
          </text>
        </g>
      ))}
      <rect className="line" x={-100} y={-220} width={200} height={440} />
      <line className="line" x1={-100} y1={-70} x2={100} y2={-70} />
      <line className="line" x1={-100} y1={70} x2={100} y2={70} />
      <line className="line" x1={0} y1={-220} x2={0} y2={-70} />
      <line className="line" x1={0} y1={70} x2={0} y2={220} />
      <line className="net" x1={-110} y1={0} x2={110} y2={0} />
      <text className="label team-a" x={0} y={Y(-23.6) + 4} textAnchor="middle">
        {nearTeam}
      </text>
      <text className="label team-b" x={0} y={Y(23.6) + 4} textAnchor="middle">
        {farTeam}
      </text>
    </svg>
  );
}
