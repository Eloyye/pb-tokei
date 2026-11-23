const PATHS = {
  play: "M4.5 2.5v11l9-5.5z",
  pause: "M4 3h3v10H4zM9 3h3v10H9z",
  stepBack: "M3 3h2v10H3zM13 3v10L6.5 8z",
  stepForward: "M11 3h2v10h-2zM3 3v10l6.5-5z",
  secondBack: "M2 3h2v10H2zM9 3v10L4.5 8zM14.5 3v10L10 8z",
  secondForward: "M12 3h2v10h-2zM7 3v10l4.5-5zM1.5 3v10L6 8z",
  minus: "M3 7h10v2H3z",
  plus: "M7 3h2v4h4v2H9v4H7V9H3V7h4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
