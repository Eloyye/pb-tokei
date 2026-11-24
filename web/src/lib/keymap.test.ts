// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  calibrationKeyAction,
  changeSpeed,
  historyKeyAction,
  isTextEntry,
  keyAction,
  type KeyInput,
  SPEEDS,
  segmentKeyAction,
  zoomKeyAction,
} from "./keymap";

function press(key: string, modifiers: Partial<KeyInput> = {}): KeyInput {
  return { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...modifiers };
}

describe("keyAction", () => {
  it("toggles play with Space", () => {
    expect(keyAction(press(" "), 1)).toEqual({ type: "togglePlay" });
  });

  it("steps one frame with the arrows, pausing first", () => {
    expect(keyAction(press("ArrowLeft"), 1)).toEqual({ type: "step", frames: -1, pause: true });
    expect(keyAction(press("ArrowRight"), 1)).toEqual({ type: "step", frames: 1, pause: true });
  });

  it("jumps one second with Shift and ten with Alt", () => {
    expect(keyAction(press("ArrowLeft", { shiftKey: true }), 1)).toEqual({
      type: "step",
      frames: -60,
      pause: false,
    });
    expect(keyAction(press("ArrowRight", { shiftKey: true }), 1)).toEqual({
      type: "step",
      frames: 60,
      pause: false,
    });
    expect(keyAction(press("ArrowLeft", { altKey: true }), 1)).toEqual({
      type: "step",
      frames: -600,
      pause: false,
    });
    expect(keyAction(press("ArrowRight", { altKey: true }), 1)).toEqual({
      type: "step",
      frames: 600,
      pause: false,
    });
  });

  it("changes speed with [ and ], and resets it with \\", () => {
    expect(keyAction(press("["), 1)).toEqual({ type: "setSpeed", speed: 0.5 });
    expect(keyAction(press("]"), 1)).toEqual({ type: "setSpeed", speed: 2 });
    expect(keyAction(press("\\"), 4)).toEqual({ type: "setSpeed", speed: 1 });
  });

  it("stops the speed at either end of the list", () => {
    expect(keyAction(press("["), 0.25)).toEqual({ type: "setSpeed", speed: 0.25 });
    expect(keyAction(press("]"), 4)).toEqual({ type: "setSpeed", speed: 4 });
  });

  it("opens the go-to box with /", () => {
    expect(keyAction(press("/"), 1)).toEqual({ type: "openGoto" });
  });

  it("leaves letters and digits alone", () => {
    for (const key of ["a", "s", "V", "0", "9", "Enter", "Escape"]) {
      expect(keyAction(press(key), 1)).toBeNull();
    }
  });

  it("leaves browser shortcuts alone", () => {
    expect(keyAction(press("ArrowLeft", { metaKey: true }), 1)).toBeNull();
    expect(keyAction(press("[", { metaKey: true }), 1)).toBeNull();
    expect(keyAction(press(" ", { ctrlKey: true }), 1)).toBeNull();
    expect(keyAction(press("ArrowRight", { shiftKey: true, altKey: true }), 1)).toBeNull();
    expect(keyAction(press(" ", { shiftKey: true }), 1)).toBeNull();
  });
});

describe("changeSpeed", () => {
  it("walks the whole list in both directions", () => {
    let speed = changeSpeed(0.25, -1);
    const up = [speed];
    for (let i = 0; i < 6; i += 1) up.push((speed = changeSpeed(speed, 1)));
    expect(up).toEqual([0.25, 0.5, 1, 2, 4, 4, 4]);
    expect(SPEEDS.map((s) => changeSpeed(s, -1))).toEqual([0.25, 0.25, 0.5, 1, 2]);
  });
});

function element(html: string): Element {
  const container = document.createElement("div");
  container.innerHTML = html;
  const child = container.firstElementChild;
  if (!child) throw new Error(`no element in ${html}`);
  return child;
}

describe("isTextEntry", () => {
  it.each([
    '<input type="text">',
    "<input>",
    '<input type="search">',
    "<textarea></textarea>",
    "<select></select>",
    '<div contenteditable="true"></div>',
  ])("is true for %s", (html) => {
    expect(isTextEntry(element(html))).toBe(true);
  });

  it.each([
    '<input type="checkbox">',
    '<input type="range">',
    '<input type="button">',
    "<div></div>",
  ])("is false for %s", (html) => {
    expect(isTextEntry(element(html))).toBe(false);
  });

  it("is false without a target", () => {
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("zoomKeyAction", () => {
  it("zooms out with - and in with =", () => {
    expect(zoomKeyAction(press("-"))).toBe("out");
    expect(zoomKeyAction(press("="))).toBe("in");
  });

  it("leaves modified keys and other keys alone", () => {
    expect(zoomKeyAction(press("=", { metaKey: true }))).toBeNull();
    expect(zoomKeyAction(press("-", { ctrlKey: true }))).toBeNull();
    expect(zoomKeyAction(press("+", { shiftKey: true }))).toBeNull();
    expect(zoomKeyAction(press("m"))).toBeNull();
  });
});

describe("segmentKeyAction", () => {
  it("sets bounds with Shift+I and Shift+O, whatever the key's case", () => {
    expect(segmentKeyAction(press("I", { shiftKey: true }))).toEqual({ type: "markIn" });
    expect(segmentKeyAction(press("o", { shiftKey: true }))).toEqual({ type: "markOut" });
    expect(segmentKeyAction(press("i"))).toBeNull();
  });

  it("sets the view with 1 and 2, removes with Backspace, cancels with Esc", () => {
    expect(segmentKeyAction(press("1"))).toEqual({ type: "setView", view: "main" });
    expect(segmentKeyAction(press("2"))).toEqual({ type: "setView", view: "sideline" });
    expect(segmentKeyAction(press("Backspace"))).toEqual({ type: "remove" });
    expect(segmentKeyAction(press("Escape"))).toEqual({ type: "cancel" });
  });

  it("leaves modified keys to the browser", () => {
    expect(segmentKeyAction(press("i", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(segmentKeyAction(press("1", { altKey: true }))).toBeNull();
  });
});

describe("historyKeyAction", () => {
  it("undoes with Cmd+Z or Ctrl+Z and redoes with Shift", () => {
    expect(historyKeyAction(press("z", { metaKey: true }))).toBe("undo");
    expect(historyKeyAction(press("z", { ctrlKey: true }))).toBe("undo");
    expect(historyKeyAction(press("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(historyKeyAction(press("y", { ctrlKey: true }))).toBe("redo");
  });

  it("ignores plain Z", () => {
    expect(historyKeyAction(press("z"))).toBeNull();
  });
});

describe("calibrationKeyAction", () => {
  it("maps N, Tab and X", () => {
    expect(calibrationKeyAction(press("n"))).toBe("new");
    expect(calibrationKeyAction(press("Tab"))).toBe("skip");
    expect(calibrationKeyAction(press("x"))).toBe("clear");
  });

  it("leaves Shift+Tab and modified keys alone", () => {
    expect(calibrationKeyAction(press("Tab", { shiftKey: true }))).toBeNull();
    expect(calibrationKeyAction(press("n", { metaKey: true }))).toBeNull();
  });
});
