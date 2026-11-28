// PROTOTYPE (throwaway, branch prototype/home-screen): floating bar for flipping between UI variants.
// Only rendered in `vite dev`; ← / → cycle unless a text field has focus.
import { useEffect } from "react";
import { isTextEntry } from "../lib/keymap";

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
  extra,
}: {
  variants: { key: string; name: string }[];
  current: string;
  onChange: (key: string) => void;
  extra?: React.ReactNode;
}) {
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current),
  );
  const step = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length];
    if (next) onChange(next.key);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!import.meta.env.DEV) return null;
  const v = variants[index];
  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype variants">
      <span className="proto-tag">PROTOTYPE</span>
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        ←
      </button>
      <span className="proto-label">
        <b>{v?.key}</b> {v?.name}
        <span className="proto-count">
          {index + 1}/{variants.length}
        </span>
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        →
      </button>
      {extra}
    </div>
  );
}
