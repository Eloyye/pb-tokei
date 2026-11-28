/* oxlint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- prototype: rows are mouse shortcuts; the keyboard path is J/K + Enter. */
// PROTOTYPE variant C, "Stage board": the pipeline *is* the layout. One lane per stage, Matches as
// compact cards, an "Up next" bar on top. No table at all.
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { type HomeMatch, STAGE_LABELS, STAGES } from "./homeModel";
import {
  Active,
  KeyHints,
  Pipeline,
  ProgressBar,
  Ratio,
  Teams,
  useHomeKeys,
  useOpen,
} from "./shared";
import type { VariantProps } from "./VariantContinue";

export const name = "Stage board";

const HINTS: Record<(typeof STAGES)[number], string> = {
  video: "Fetch or convert the broadcast",
  calibrate: "Place Landmarks, track Players",
  annotate: "Enter Rallies and Shots",
  review: "Check low-confidence fields",
  done: "Ready for Reports",
};

export function VariantBoard(props: VariantProps) {
  const { all, shown, continueItem, onFilter, query, onQuery, selected, onSelect } = props;
  const filterRef = useRef<HTMLInputElement>(null);
  const open = useOpen();
  // The board always shows every lane, so it ignores the stage filter but keeps the text filter.
  const lanes = STAGES.map((stage) => ({ stage, items: shown.filter((m) => m.stage === stage) }));
  const ordered = lanes.flatMap((lane) => lane.items);

  const laneKeys = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "h" && event.key !== "l") return false;
      const from = selected ? STAGES.indexOf(selected.stage) : 0;
      const delta = event.key === "l" ? 1 : -1;
      for (let i = from + delta; i >= 0 && i < STAGES.length; i += delta) {
        const lane = lanes[i];
        if (lane && lane.items[0]) {
          const pos = selected ? lanes[from]!.items.indexOf(selected) : 0;
          onSelect(lane.items[Math.min(Math.max(pos, 0), lane.items.length - 1)]!);
          break;
        }
      }
      return true;
    },
    [lanes, selected, onSelect],
  );
  useHomeKeys({ items: ordered, selected, onSelect, onFilter, filterRef, extra: laneKeys });

  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (selected) cardRefs.current.get(selected.key)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <main className="hp hp-c">
      <div className="hp-upnext">
        {continueItem ? (
          <>
            <span className="hp-upnext-label">Up next</span>
            <Teams item={continueItem} />
            <span className="hp-faint">{continueItem.match.tournament}</span>
            {continueItem.resumeAt && <span className="hp-faint">· {continueItem.resumeAt}</span>}
            <button
              type="button"
              className="hp-resume small"
              onClick={() => open.primary(continueItem)}
            >
              {continueItem.action.label} <kbd>⏎</kbd>
            </button>
          </>
        ) : (
          <span className="hp-faint">Nothing in progress.</span>
        )}
        <span className="hp-upnext-spacer" />
        <input
          ref={filterRef}
          className="hp-search"
          placeholder="Filter  /"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <Link to="/matches/new" className="button primary">
          New Match <kbd>N</kbd>
        </Link>
      </div>

      <div className="hp-board">
        {lanes.map((lane) => (
          <section key={lane.stage} className={`hp-lane lane-${lane.stage}`}>
            <header className="hp-lane-head">
              <span className={`hp-lane-dot stage-${lane.stage}`} />
              <span className="hp-lane-name">{STAGE_LABELS[lane.stage]}</span>
              <span className="mono hp-faint">
                {lane.items.length}/{all.filter((m) => m.stage === lane.stage).length}
              </span>
            </header>
            <div className="hp-lane-hint">{HINTS[lane.stage]}</div>
            <div className="hp-lane-cards">
              {lane.items.map((item) => (
                <Card
                  key={item.key}
                  item={item}
                  selected={selected?.key === item.key}
                  isContinue={continueItem?.key === item.key}
                  onSelect={onSelect}
                  refCb={(el) => {
                    if (el) cardRefs.current.set(item.key, el);
                    else cardRefs.current.delete(item.key);
                  }}
                />
              ))}
              {lane.items.length === 0 && <div className="hp-lane-empty">—</div>}
            </div>
          </section>
        ))}
      </div>
      <KeyHints board />
    </main>
  );
}

function Card({
  item,
  selected,
  isContinue,
  onSelect,
  refCb,
}: {
  item: HomeMatch;
  selected: boolean;
  isContinue: boolean;
  onSelect: (item: HomeMatch) => void;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  const open = useOpen();
  return (
    <div
      ref={refCb}
      className={`hp-card${selected ? " sel" : ""}${isContinue ? " cont" : ""}`}
      onMouseDown={() => onSelect(item)}
      onDoubleClick={() => !item.action.disabled && open.primary(item)}
    >
      <div className="hp-card-top">
        <span className="mono hp-faint">{item.match.date ?? "undated"}</span>
        <span className="hp-card-tournament">{item.match.tournament}</span>
        <span className={`hp-mode ${item.match.annotation_mode}`}>
          {item.match.annotation_mode === "assisted" ? "A" : "G"}
        </span>
      </div>
      <Teams item={item} compact />
      <div className="hp-card-mid">
        <Pipeline item={item} />
        {item.match.total_rallies > 0 && <ProgressBar item={item} />}
      </div>
      <div className="hp-card-foot">
        <span className="hp-faint">
          <Active item={item} /> · <Ratio item={item} />
        </span>
        <span className="hp-card-actions">
          <button
            type="button"
            className="hp-ghost"
            onClick={() => open.edit(item)}
            title="Edit (E)"
          >
            Edit
          </button>
          <button
            type="button"
            className="hp-ghost"
            onClick={() => open.report(item)}
            title="Report (R)"
          >
            Report
          </button>
          <button
            type="button"
            className={`button hp-primary-action stage-${item.stage}`}
            disabled={item.action.disabled}
            onClick={() => open.primary(item)}
          >
            {item.action.label}
          </button>
        </span>
      </div>
    </div>
  );
}
