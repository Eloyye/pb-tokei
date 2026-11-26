// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail, ShotPosition } from "../api/client";
import {
  type AnnotateContext,
  type AnnotateEdit,
  addShot,
  markRallyEnd,
  markRallyStart,
  NO_SELECTION,
  type Selection,
  setRallyDetails,
} from "../lib/annotate";
import { inferred, observed } from "../lib/rallyLog";
import { ROSTER } from "../lib/testRoster";
import { InspectorPanel, type InspectorTab } from "./Inspector";
import { RalliesPanel } from "./RalliesPanel";
import { CourtPanel } from "./SidePanels";
import { Timeline } from "./Timeline";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const MATCH: MatchDetail = {
  id: "match-1",
  tournament: "PPA Atlanta Open 2026",
  team_a: ["Anna Bright", "Ben Johns"],
  team_b: ["Cara Lee", "Dan Kim"],
  franchise_a: null,
  franchise_b: null,
  video_status: "ready",
  annotation_mode: "gold",
  assisted_ratio_budget: 0.25,
  broadcast_seconds: null,
  operator_time_ratio: null,
  operator_time: {
    active_seconds: 0,
    calibrate_seconds: 0,
    annotate_seconds: 0,
    review_seconds: 0,
  },
  footage_job: null,
  done_rallies: 0,
  total_rallies: 0,
  fix_command: null,
  source_url: null,
  original_present: true,
  team_a_id: "A",
  team_b_id: "B",
  players: [...ROSTER.players],
};

const at = (x: number, y: number): ShotPosition => ({
  position: observed({ x, y }),
  settled: inferred(false),
});

/** Game 1: Rally 1 (frames 100–400) with two Shots, and an open Rally 2 from 600. */
function annotated(): AnnotateEdit {
  let state: AnnotateEdit = { games: [], selection: NO_SELECTION, message: "" };
  const step = (frame: number, edit: (c: AnnotateContext) => AnnotateEdit) => {
    state = edit({ games: state.games, selection: state.selection, roster: ROSTER, frame });
  };
  const snapshot = { a1: at(-5, -21), a2: at(5, -20), b1: at(4, 21), b2: at(-3, 4) };
  step(100, markRallyStart);
  step(120, (c) => addShot(c, snapshot));
  step(170, (c) => addShot(c, snapshot));
  step(400, markRallyEnd);
  step(600, markRallyStart);
  return state;
}

describe("RalliesPanel", () => {
  it("lists Rallies by Game with status, score and Done count, and selects on click", () => {
    const { games } = annotated();
    const onSelectRally = vi.fn<(game: number, rally: number) => void>();
    render(
      <RalliesPanel
        focused={false}
        games={games}
        selection={{ game: 0, rally: 1, entry: null }}
        roster={ROSTER}
        onSelectRally={onSelectRally}
        onSelectGame={vi.fn<() => void>()}
        onAddUnseen={vi.fn<() => void>()}
        onAddGame={vi.fn<() => void>()}
        onDeleteGame={vi.fn<() => void>()}
      />,
    );
    expect(screen.getByText("0 / 2")).toBeTruthy();
    const rows = screen.getAllByRole("button", { pressed: false });
    const first = rows.find((r) => r.textContent?.includes("R1"))!;
    expect(first.textContent).toContain("0-0-2");
    expect(first.textContent).toContain("100–400");
    expect(screen.getByRole("button", { pressed: true }).textContent).toContain("600–…");
    fireEvent.click(first);
    expect(onSelectRally).toHaveBeenCalledWith(0, 0);
  });
});

function InspectorHarness({
  initial,
  tab: initialTab = "shot",
  onEditSpy,
}: {
  initial: AnnotateEdit;
  tab?: InspectorTab;
  onEditSpy?: (edit: AnnotateEdit) => void;
}) {
  const [state, setState] = useState(initial);
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const [form, setForm] = useState<"details" | "challenge" | null>(null);
  return (
    <InspectorPanel
      focused={false}
      tab={tab}
      onTabChange={setTab}
      games={state.games}
      selection={state.selection}
      roster={ROSTER}
      frame={150}
      cursor={{ shot: 1, rally: 0 }}
      onCursor={vi.fn<() => void>()}
      form={form}
      onOpenForm={setForm}
      onCloseForm={() => setForm(null)}
      onEdit={(edit) => {
        const next = edit({ ...state, roster: ROSTER, frame: 150 });
        onEditSpy?.(next);
        setState(next);
      }}
      onMoveContactHere={vi.fn<() => void>()}
      onSyncFromTracking={vi.fn<() => void>()}
      onDeleteRally={vi.fn<() => void>()}
    />
  );
}

function onFirstShot(): AnnotateEdit {
  const state = annotated();
  return { ...state, selection: { game: 0, rally: 0, entry: 0 } as Selection };
}

describe("InspectorPanel", () => {
  it("shows the Shot's facts by certainty, the checklist, positions and a Derived preview", () => {
    render(<InspectorHarness initial={onFirstShot()} />);
    expect(screen.getByText("Shot 1")).toBeTruthy();
    // The playhead (150) is off the contact (120).
    expect(screen.getByText("+30 f")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move contact here" })).toBeTruthy();
    const hitter = screen.getByRole("button", { name: "Hitter" }).closest(".insp-row")!;
    expect(hitter.querySelector(".val.cert-inferred")?.textContent).toContain("Anna Bright");
    // The cursor row (index 1: Shot Class) is highlighted.
    expect(
      screen.getByRole("button", { name: "Shot Class" }).closest(".insp-row")!.className,
    ).toContain("cursor");
    expect(screen.getByText("Soft or Hard?")).toBeTruthy();
    expect(screen.getAllByText("Moving")).toHaveLength(4);
    expect(screen.getByText("Derived · computed, never stored")).toBeTruthy();
    expect(screen.getAllByText("Serve").length).toBeGreaterThan(0);
  });

  it("remembers the Soft/Hard checklist being collapsed", () => {
    const { container, unmount } = render(<InspectorHarness initial={onFirstShot()} />);
    const details = container.querySelector("details")!;
    details.open = false;
    fireEvent(details, new Event("toggle"));
    unmount();
    const again = render(<InspectorHarness initial={onFirstShot()} />);
    expect(again.container.querySelector("details")!.open).toBe(false);
  });

  it("toggles Erne and cycles Settled by clicking", () => {
    const edits: AnnotateEdit[] = [];
    render(<InspectorHarness initial={onFirstShot()} onEditSpy={(e) => edits.push(e)} />);
    fireEvent.click(screen.getByRole("button", { name: "Erne" }));
    expect(edits.at(-1)!.message).toBe("Erne on");
    fireEvent.click(screen.getAllByRole("button", { name: "Moving" })[0]!);
    expect(edits.at(-1)!.message).toMatch(/Settled Unknown/);
  });

  it("saves the Rally details form with Enter and keeps unchanged facts", () => {
    const edits: AnnotateEdit[] = [];
    const initial = { ...annotated(), selection: { game: 0, rally: 0, entry: null } };
    render(<InspectorHarness initial={initial} tab="rally" onEditSpy={(e) => edits.push(e)} />);
    fireEvent.click(screen.getByRole("button", { name: "Score called" }));
    const form = screen.getByRole("form", { name: "Rally details" });
    const serving = within(form).getByLabelText("Serving Team");
    fireEvent.change(serving, { target: { value: "B" } });
    fireEvent.keyDown(within(form).getByLabelText("Score called"), { key: "Enter" });
    const rally = edits.at(-1)!.games[0]!.rallies[0]!;
    expect(rally.serving_team_id).toEqual(observed("B"));
    // The score wasn't touched: it stays Inferred.
    expect(rally.score).toEqual(inferred({ serving: 0, receiving: 0, server_number: 2 }));
    expect(screen.queryByRole("form", { name: "Rally details" })).toBeNull();
  });

  it("records a Challenge from its form, and Esc cancels a form", () => {
    const edits: AnnotateEdit[] = [];
    const initial = { ...annotated(), selection: { game: 0, rally: 0, entry: null } };
    render(<InspectorHarness initial={initial} tab="rally" onEditSpy={(e) => edits.push(e)} />);
    fireEvent.click(screen.getByRole("button", { name: "Challenge" }));
    let form = screen.getByRole("form", { name: "Challenge" });
    fireEvent.keyDown(within(form).getByLabelText("Challenger"), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "Challenge" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Challenge" }));
    form = screen.getByRole("form", { name: "Challenge" });
    fireEvent.change(within(form).getByLabelText("Challenger"), { target: { value: "b1" } });
    fireEvent.change(within(form).getByLabelText("Original call"), { target: { value: "Out" } });
    fireEvent.change(within(form).getByLabelText("Ruling"), { target: { value: "upheld" } });
    fireEvent.click(within(form).getByRole("button", { name: /Save/ }));
    expect(edits.at(-1)!.games[0]!.rallies[0]!.challenge).toEqual({
      challenger_id: observed("b1"),
      original_call: observed("Out"),
      ruling: observed("upheld"),
    });
  });

  it("shows where the winner came from", () => {
    const state = annotated();
    const withWinner = setRallyDetails(
      { ...state, selection: { game: 0, rally: 0, entry: null }, roster: ROSTER, frame: 0 },
      {
        score: state.games[0]!.rallies[0]!.score,
        serving_team_id: observed("A"),
        server_id: observed("a1"),
        returner_id: observed("b1"),
        scoreboard_winner_id: observed("B"),
        manual_winner: null,
      },
    );
    render(<InspectorHarness initial={withWinner} tab="rally" />);
    const winner = screen.getByRole("button", { name: "Winner" }).closest(".insp-row")!;
    expect(winner.textContent).toContain("scoreboard");
  });
});

function renderTracks() {
  const { games } = annotated();
  const rallyLog = {
    games,
    selection: { game: 0, rally: 0, entry: 0 },
    roster: ROSTER,
    onSelectRally: vi.fn<(game: number, rally: number) => void>(),
    onSelectEntry: vi.fn<(game: number, rally: number, entry: number) => void>(),
    onMoveContact: vi.fn<(game: number, rally: number, entry: number, frame: number) => void>(),
    onFitRally: vi.fn<() => void>(),
  };
  const result = render(
    <Timeline
      view={{ start: 0, end: 1000 }}
      onViewChange={vi.fn<() => void>()}
      frame={0}
      totalFrames={3000}
      playing={false}
      onSeek={vi.fn<() => void>()}
      onZoom={vi.fn<() => void>()}
      focused={false}
      segments={[]}
      pending={null}
      editableSegments={false}
      onMoveEdge={vi.fn<() => void>()}
      rallyLog={rallyLog}
    />,
  );
  const ruler = result.container.querySelector<HTMLElement>(".ruler")!;
  vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ x: 0, width: 1000, height: 22 }),
  );
  return { ...result, rallyLog };
}

describe("Timeline Rallies and Shots tracks", () => {
  it("draws Rally clips and Shot pins, and selects them on click", () => {
    const { container, rallyLog } = renderTracks();
    const clips = container.querySelectorAll<HTMLElement>(".clip");
    expect(clips).toHaveLength(2);
    expect(clips[0]!.className).toContain("on");
    fireEvent.click(clips[1]!);
    expect(rallyLog.onSelectRally).toHaveBeenCalledWith(0, 1);

    const pins = screen.getAllByRole("button", { name: /^Shot \d at frame/ });
    expect(pins.map((p) => p.textContent)).toEqual(["1", "2"]);
    fireEvent.pointerDown(pins[1]!, { pointerId: 1, clientX: 170 });
    fireEvent.pointerUp(pins[1]!, { pointerId: 1, clientX: 170 });
    expect(rallyLog.onSelectEntry).toHaveBeenCalledWith(0, 0, 1);
    expect(container.querySelectorAll(".ov-block")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Fit Rally" }));
    expect(rallyLog.onFitRally).toHaveBeenCalled();
  });

  it("drags a Shot pin to move its contact", () => {
    const { rallyLog } = renderTracks();
    const pin = screen.getByRole("button", { name: "Shot 2 at frame 170" });
    fireEvent.pointerDown(pin, { pointerId: 1, clientX: 170 });
    fireEvent.pointerMove(pin, { pointerId: 1, clientX: 210 });
    fireEvent.pointerUp(pin, { pointerId: 1, clientX: 210 });
    expect(rallyLog.onMoveContact).toHaveBeenCalledWith(0, 0, 1, 210);
  });
});

describe("CourtPanel with a Shot selected", () => {
  it("shows the Shot's positions with the hitter ringed, ghosts and the landing", () => {
    const { games } = annotated();
    const rally = games[0]!.rallies[0]!;
    const [serve, ret] = rally.entries;
    if (serve?.type !== "shot" || ret?.type !== "shot") throw new Error("expected Shots");
    const shot = { ...ret, landing: observed({ x: 2, y: -12 }) };
    const onSetLanding = vi.fn<(point: { x: number; y: number }) => void>();
    const { container } = render(
      <CourtPanel
        match={MATCH}
        focused={false}
        roster={ROSTER}
        shot={shot}
        previousShot={serve}
        onSetLanding={onSetLanding}
        onMoveShotPlayer={vi.fn<() => void>()}
      />,
    );
    expect(container.querySelector(".court-player.hitter")?.getAttribute("data-player-id")).toBe(
      "b1",
    );
    expect(container.querySelectorAll(".ghost")).toHaveLength(4);
    expect(container.querySelector(".landing.team-b")).toBeTruthy();
    expect(container.querySelector(".traj")).toBeTruthy();

    const svg = container.querySelector<SVGSVGElement>("svg.court")!;
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 280, height: 500 }),
    );
    // The centre of the SVG is the centre of the net.
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 140, clientY: 250 });
    expect(onSetLanding).toHaveBeenCalledWith({ x: 0, y: -0 });
  });

  it("pins a Player standing beyond the drawn area to its edge, keeping the real position", () => {
    const { games } = annotated();
    const serve = games[0]!.rallies[0]!.entries[0];
    if (serve?.type !== "shot") throw new Error("expected a Shot");
    const behind = { ...serve, positions: { ...serve.positions, a1: at(8, -28) } };
    const { container } = render(
      <CourtPanel match={MATCH} focused={false} roster={ROSTER} shot={behind} />,
    );
    const dot = container.querySelector<SVGGElement>('[data-player-id="a1"]')!;
    // 28 ft back is drawn at the bottom edge (23.8 ft, a dot's radius in), not off the diagram.
    expect(dot.getAttribute("transform")).toBe("translate(80, 238)");
    expect(dot.querySelector("title")!.textContent).toContain("(8.0, -28.0 ft");
  });
});
