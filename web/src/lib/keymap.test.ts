// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  annotateKeyAction,
  calibrationKeyAction,
  changeSpeed,
  historyKeyAction,
  isPanelSwapKey,
  isSplitKey,
  isTextEntry,
  keyAction,
  type KeyInput,
  ruleIssueKeyAction,
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

describe("isPanelSwapKey", () => {
  it("accepts only unmodified backtick", () => {
    expect(isPanelSwapKey(press("`"))).toBe(true);
    expect(isPanelSwapKey(press("~"))).toBe(false);
    for (const modifier of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
      expect(isPanelSwapKey(press("`", { [modifier]: true }))).toBe(false);
    }
  });
});

describe("isSplitKey", () => {
  it("accepts Cmd+K or Ctrl+K regardless of case and rejects other combinations", () => {
    expect(isSplitKey(press("k", { metaKey: true }))).toBe(true);
    expect(isSplitKey(press("K", { metaKey: true }))).toBe(true);
    expect(isSplitKey(press("k", { ctrlKey: true }))).toBe(true);
    expect(isSplitKey(press("k"))).toBe(false);
    expect(isSplitKey(press("k", { metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isSplitKey(press("k", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSplitKey(press("k", { metaKey: true, altKey: true }))).toBe(false);
    expect(isSplitKey(press("z", { metaKey: true }))).toBe(false);
  });
});

describe("segmentKeyAction", () => {
  it("splits a Play Segment with Command+K or Ctrl+K", () => {
    expect(segmentKeyAction(press("k", { metaKey: true }))).toEqual({ type: "split" });
    expect(segmentKeyAction(press("k", { ctrlKey: true }))).toEqual({ type: "split" });
    expect(segmentKeyAction(press("k"))).toBeNull();
    expect(segmentKeyAction(press("k", { ctrlKey: true, metaKey: true }))).toBeNull();
    expect(segmentKeyAction(press("K", { metaKey: true, shiftKey: true }))).toBeNull();
  });

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
  it("maps N, Tab, X, V and C", () => {
    expect(calibrationKeyAction(press("n"))).toBe("new");
    expect(calibrationKeyAction(press("Tab"))).toBe("skip");
    expect(calibrationKeyAction(press("x"))).toBe("clear");
    expect(calibrationKeyAction(press("v"))).toBe("notVisible");
    expect(calibrationKeyAction(press("c"))).toBe("confirm");
  });

  it("leaves Shift+Tab and modified keys alone", () => {
    expect(calibrationKeyAction(press("Tab", { shiftKey: true }))).toBeNull();
    expect(calibrationKeyAction(press("n", { metaKey: true }))).toBeNull();
    expect(calibrationKeyAction(press("v", { ctrlKey: true }))).toBeNull();
    expect(calibrationKeyAction(press("c", { metaKey: true }))).toBeNull();
  });
});

function shift(code: string, key = ""): KeyInput {
  return press(key, { shiftKey: true, code });
}

describe("annotateKeyAction", () => {
  it("maps Shift Rally keys by physical key, whatever the layout prints", () => {
    expect(annotateKeyAction(shift("KeyI", "I"))).toEqual({ type: "rallyStart" });
    expect(annotateKeyAction(shift("KeyO", "O"))).toEqual({ type: "rallyEnd" });
    expect(annotateKeyAction(shift("KeyP", "P"))).toEqual({ type: "refereeCall", call: "point" });
    expect(annotateKeyAction(shift("Digit2", "@"))).toEqual({
      type: "refereeCall",
      call: "second_server",
    });
    expect(annotateKeyAction(shift("Digit2", '"'))).toEqual({
      type: "refereeCall",
      call: "second_server",
    });
    expect(annotateKeyAction(shift("KeyX", "X"))).toEqual({
      type: "refereeCall",
      call: "side_out",
    });
    expect(annotateKeyAction(shift("KeyS"))).toEqual({ type: "rallyForm" });
    expect(annotateKeyAction(shift("KeyC"))).toEqual({ type: "challengeForm" });
    expect(annotateKeyAction(shift("KeyU"))).toEqual({ type: "unseenRally" });
    expect(annotateKeyAction(shift("KeyH"))).toEqual({ type: "switchTeam" });
    expect(annotateKeyAction(shift("KeyG"))).toEqual({ type: "gap", parity: "even" });
    expect(annotateKeyAction(shift("Backspace"))).toEqual({ type: "deleteRally" });
    expect(annotateKeyAction(shift("Enter"))).toEqual({ type: "nextGame" });
    expect(annotateKeyAction(shift("Tab", "Tab"))).toEqual({ type: "cursor", direction: -1 });
  });

  it("maps plain Shot keys", () => {
    expect(annotateKeyAction(press("m"))).toEqual({ type: "addShot" });
    expect(annotateKeyAction(press("S"))).toEqual({ type: "shotClass", value: "soft" });
    expect(annotateKeyAction(press("h"))).toEqual({ type: "shotClass", value: "hard" });
    expect(annotateKeyAction(press("l"))).toEqual({ type: "shotClass", value: "lob" });
    expect(annotateKeyAction(press("o"))).toEqual({ type: "shotClass", value: "overhead" });
    expect(annotateKeyAction(press("v"))).toEqual({ type: "contactKind", value: "volley" });
    expect(annotateKeyAction(press("b"))).toEqual({ type: "contactKind", value: "bounce" });
    expect(annotateKeyAction(press("x"))).toEqual({ type: "swapPartner" });
    expect(annotateKeyAction(press("e"))).toEqual({ type: "flag", flag: "erne" });
    expect(annotateKeyAction(press("t"))).toEqual({ type: "flag", flag: "atp" });
    expect(annotateKeyAction(press("5"))).toEqual({ type: "error", kind: "body_hit" });
    expect(annotateKeyAction(press("0"))).toEqual({ type: "error", kind: null });
    expect(annotateKeyAction(press("g"))).toEqual({ type: "gap", parity: "odd" });
    expect(annotateKeyAction(press("c"))).toEqual({ type: "cycleCertainty" });
    expect(annotateKeyAction(press("Backspace"))).toEqual({ type: "deleteEntry" });
    expect(annotateKeyAction(press("Enter"))).toEqual({ type: "done" });
    expect(annotateKeyAction(press("ArrowDown"))).toEqual({ type: "shot", direction: 1 });
    expect(annotateKeyAction(press("PageUp"))).toEqual({ type: "rally", direction: -1 });
    expect(annotateKeyAction(press("Tab"))).toEqual({ type: "cursor", direction: 1 });
  });

  it("maps Cmd+K and Ctrl+K to Split Rally, leaving plain and Shift/Alt K alone", () => {
    expect(annotateKeyAction(press("k", { metaKey: true }))).toEqual({ type: "splitRally" });
    expect(annotateKeyAction(press("K", { metaKey: true }))).toEqual({ type: "splitRally" });
    expect(annotateKeyAction(press("k", { ctrlKey: true }))).toEqual({ type: "splitRally" });
    expect(annotateKeyAction(press("k"))).toBeNull();
    expect(annotateKeyAction(shift("KeyK", "K"))).toBeNull();
    expect(annotateKeyAction(press("k", { metaKey: true, shiftKey: true }))).toBeNull();
    expect(annotateKeyAction(press("k", { metaKey: true, ctrlKey: true }))).toBeNull();
    expect(annotateKeyAction(press("k", { metaKey: true, altKey: true }))).toBeNull();
  });

  it("leaves playback keys and browser shortcuts alone", () => {
    expect(annotateKeyAction(press(" "))).toBeNull();
    expect(annotateKeyAction(press("ArrowLeft"))).toBeNull();
    expect(annotateKeyAction(press("ArrowLeft", { shiftKey: true, code: "ArrowLeft" }))).toBeNull();
    expect(annotateKeyAction(press("z", { metaKey: true }))).toBeNull();
    expect(annotateKeyAction(press("m", { altKey: true }))).toBeNull();
    expect(annotateKeyAction(press("["))).toBeNull();
    expect(annotateKeyAction(press("F8"))).toBeNull();
    expect(annotateKeyAction(press("F8", { shiftKey: true, code: "F8" }))).toBeNull();
  });
});

describe("ruleIssueKeyAction", () => {
  it("maps F8 to next and Shift+F8 to previous", () => {
    expect(ruleIssueKeyAction(press("F8"))).toBe(1);
    expect(ruleIssueKeyAction(press("F8", { shiftKey: true }))).toBe(-1);
  });

  it("ignores other keys and Ctrl/Meta/Alt modifiers", () => {
    expect(ruleIssueKeyAction(press("F8", { ctrlKey: true }))).toBeNull();
    expect(ruleIssueKeyAction(press("F8", { metaKey: true }))).toBeNull();
    expect(ruleIssueKeyAction(press("F8", { altKey: true }))).toBeNull();
    expect(ruleIssueKeyAction(press("F7"))).toBeNull();
    expect(ruleIssueKeyAction(press("n"))).toBeNull();
  });
});
