import { type KeyboardEvent, type PointerEvent, useState } from "react";

/**
 * A draggable gutter between panels. `onDrag` gets the pointer position; when focused, the
 * arrow keys along its axis nudge the size by 10 px through `onNudge`.
 */
export function Splitter({
  className,
  orientation,
  label,
  value,
  onDrag,
  onNudge,
}: {
  className: string;
  /** "vertical" for a gutter between columns, "horizontal" between rows. */
  orientation: "vertical" | "horizontal";
  label: string;
  value: number;
  onDrag: (clientX: number, clientY: number) => void;
  onNudge: (delta: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const keys =
    orientation === "vertical"
      ? { less: "ArrowLeft", more: "ArrowRight" }
      : { less: "ArrowUp", more: "ArrowDown" };

  return (
    <button
      type="button"
      className={`splitter ${className} ${dragging ? "dragging" : ""}`}
      aria-label={`${label} (${value} px)`}
      title={label}
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          onDrag(event.clientX, event.clientY);
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== keys.less && event.key !== keys.more) return;
        // Keep the arrows from also stepping the video.
        event.preventDefault();
        event.stopPropagation();
        onNudge(event.key === keys.more ? 10 : -10);
      }}
    />
  );
}
