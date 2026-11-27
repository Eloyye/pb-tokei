import { type KeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { MenuCommand, MenuItem } from "./contextMenuItems";

interface Position {
  x: number;
  y: number;
}

function navigate(event: KeyboardEvent<HTMLDivElement>) {
  const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
  const index = buttons.findIndex((button) => button === document.activeElement);
  const last = buttons.length - 1;
  let next: number;
  switch (event.key) {
    case "ArrowDown":
      next = index === last ? 0 : index + 1;
      break;
    case "ArrowUp":
      next = index <= 0 ? last : index - 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = last;
      break;
    default:
      return;
  }
  event.preventDefault();
  buttons[next]?.focus();
}

/** A single workspace menu, positioned in the viewport so lanes and panels can't clip it. */
export function ContextMenu({
  label,
  position,
  items,
  onRun,
  onClose,
}: {
  label: string;
  position: Position;
  items: readonly MenuItem[];
  onRun: (command: MenuCommand) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 4;
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(margin, Math.min(position.x, window.innerWidth - width - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(position.y, window.innerHeight - height - margin))}px`;
    menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("click", closeOutside, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("click", closeOutside, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={navigate}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map(({ label: name, command, shortcut, disabledReason }) => (
        <button
          key={name}
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-disabled={disabledReason ? true : undefined}
          aria-keyshortcuts={shortcut}
          title={disabledReason}
          onClick={() => {
            if (!disabledReason) onRun(command);
          }}
        >
          {name}
          {shortcut && <kbd aria-hidden="true">{shortcut}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
