/* oxlint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- prototype: rows are mouse shortcuts; the keyboard path is J/K + Enter. */
// PROTOTYPE variant B, "Continue + pipeline table": a Resume card on top, stage chips, and the
// table grouped by Tournament with a pipeline cell and one state-dependent action per row.
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { type Filter, type HomeMatch, groupByTournament } from "./homeModel";
import {
  Active,
  FilterChips,
  Franchises,
  KeyHints,
  Pipeline,
  ProgressBar,
  Ratio,
  StageTag,
  Teams,
  useHomeKeys,
  useOpen,
} from "./shared";

export const name = "Continue + pipeline table";

export interface VariantProps {
  all: HomeMatch[];
  shown: HomeMatch[];
  continueItem: HomeMatch | null;
  filter: Filter;
  onFilter: (filter: Filter) => void;
  query: string;
  onQuery: (query: string) => void;
  selected: HomeMatch | null;
  onSelect: (item: HomeMatch) => void;
  sample: boolean;
}

export function VariantContinue(props: VariantProps) {
  const { all, shown, continueItem, filter, onFilter, query, onQuery, selected, onSelect } = props;
  const filterRef = useRef<HTMLInputElement>(null);
  const open = useOpen();
  useHomeKeys({ items: shown, selected, onSelect, onFilter, filterRef });

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (selected) rowRefs.current.get(selected.key)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <main className="hp hp-b">
      {continueItem && (
        <section className="hp-continue" aria-label="Continue">
          <div className="hp-continue-label">Continue</div>
          <div className="hp-continue-body">
            <div className="hp-continue-teams">
              <Teams item={continueItem} />
            </div>
            <div className="hp-continue-meta">
              <span>{continueItem.match.tournament}</span>
              <span className="mono">{continueItem.match.date ?? "undated"}</span>
              <span
                className={`pill ${continueItem.match.annotation_mode === "assisted" ? "pill-active" : "pill-none"}`}
              >
                {continueItem.match.annotation_mode === "assisted" ? "Assisted" : "Gold"}
              </span>
              <span>
                Active <Active item={continueItem} />
              </span>
            </div>
          </div>
          <div className="hp-continue-progress">
            <Pipeline item={continueItem} labels />
            <ProgressBar item={continueItem} />
          </div>
          <button
            type="button"
            className="hp-resume"
            onClick={() => open.primary(continueItem)}
            onMouseEnter={() => onSelect(continueItem)}
          >
            <span>
              {continueItem.action.label}
              {continueItem.resumeAt && (
                <span className="hp-resume-at"> · {continueItem.resumeAt}</span>
              )}
            </span>
            <kbd>⏎</kbd>
          </button>
        </section>
      )}

      <div className="hp-toolbar">
        <FilterChips items={all} filter={filter} onFilter={onFilter} />
        <div className="hp-toolbar-right">
          <input
            ref={filterRef}
            className="hp-search"
            placeholder="Filter Teams, Players, Tournaments"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          <kbd className="hp-search-kbd">/</kbd>
          <Link to="/matches/new" className="button primary">
            New Match <kbd>N</kbd>
          </Link>
        </div>
      </div>

      <div className="hp-table">
        <div className="hp-tr hp-thead">
          <span>Date</span>
          <span>Match</span>
          <span>Stage</span>
          <span>Progress</span>
          <span className="num">Active</span>
          <span
            className="num"
            title="Operator minutes ÷ broadcast minutes. Assisted budget 0.25 (ADR 0004); Gold has none."
          >
            Ratio ⓘ
          </span>
          <span />
        </div>
        {shown.length === 0 && <div className="hp-empty">No Matches match this filter.</div>}
        {groupByTournament(shown).map((group) => (
          <div key={group.tournament} className="hp-group">
            <div className="hp-group-head">
              <span className="hp-group-name">{group.tournament}</span>
              <span className="hp-faint mono">{group.items.length}</span>
              <span className="hp-group-dates mono">{group.dateRange}</span>
            </div>
            {group.items.map((item) => {
              const isSel = selected?.key === item.key;
              const isCont = continueItem?.key === item.key;
              return (
                <div
                  key={item.key}
                  ref={(el) => {
                    if (el) rowRefs.current.set(item.key, el);
                    else rowRefs.current.delete(item.key);
                  }}
                  className={`hp-tr hp-row${isSel ? " sel" : ""}`}
                  onMouseDown={() => onSelect(item)}
                  onDoubleClick={() => !item.action.disabled && open.primary(item)}
                >
                  <span className={`mono ${item.match.date ? "" : "hp-faint"}`}>
                    {item.match.date ?? "—"}
                  </span>
                  <span className="hp-match-cell">
                    <Teams item={item} />
                    <Franchises item={item} />
                  </span>
                  <span className="hp-stage-cell">
                    <Pipeline item={item} />
                    <StageTag item={item} />
                    {isCont && <span className="hp-cont-dot" title="Continue" />}
                  </span>
                  <ProgressBar item={item} />
                  <span className="num">
                    <Active item={item} />
                  </span>
                  <span className="num">
                    <Ratio item={item} />
                  </span>
                  <span className="hp-actions">
                    <span className="hp-hover-actions">
                      <button type="button" className="hp-ghost" onClick={() => open.edit(item)}>
                        Edit <kbd>E</kbd>
                      </button>
                      <button type="button" className="hp-ghost" onClick={() => open.report(item)}>
                        Report <kbd>R</kbd>
                      </button>
                    </span>
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
              );
            })}
          </div>
        ))}
      </div>
      <KeyHints />
    </main>
  );
}
