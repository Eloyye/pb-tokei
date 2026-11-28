// PROTOTYPE (throwaway, branch prototype/home-screen): small pieces the Home variants share.
// Each variant owns its own layout; only cells and the key handling live here.
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect } from "react";
import { isTextEntry } from "../../lib/keymap";
import { formatActiveTime, formatRatio, ratioClassName } from "../../lib/operatorTime";
import { franchisesLabel } from "../teams";
import {
  type Filter,
  type HomeMatch,
  STAGE_LABELS,
  STAGES,
  STEP_LABELS,
  fetchPercent,
} from "./homeModel";

export function Teams({ item, compact = false }: { item: HomeMatch; compact?: boolean }) {
  const { match } = item;
  return (
    <span className={`hp-teams${compact ? " compact" : ""}`}>
      <span className="hp-team">{match.team_a.join(" / ")}</span>
      <span className="hp-vs">vs</span>
      <span className="hp-team">{match.team_b.join(" / ")}</span>
    </span>
  );
}

export function Franchises({ item }: { item: HomeMatch }) {
  const label = franchisesLabel(item.match);
  return label ? <span className="hp-sub">{label}</span> : null;
}

/** A row of segments, one per step: done, current (accent), busy (fetch %) or todo. */
export function Pipeline({ item, labels = false }: { item: HomeMatch; labels?: boolean }) {
  const percent = fetchPercent(item.match);
  return (
    <span className={`hp-pipeline${labels ? " labelled" : ""}`} title={pipelineTitle(item)}>
      {item.steps.map((step) => (
        <span key={step.key} className={`hp-step ${step.state}`}>
          <span className="hp-step-bar">
            {step.state === "busy" && percent !== null && (
              <span className="hp-step-fill" style={{ width: `${percent}%` }} />
            )}
          </span>
          {labels && <span className="hp-step-label">{STEP_LABELS[step.key]}</span>}
        </span>
      ))}
    </span>
  );
}

function pipelineTitle(item: HomeMatch): string {
  return item.steps
    .map((s) => `${STEP_LABELS[s.key]}: ${s.state === "todo" ? "not yet" : s.state}`)
    .join("\n");
}

export function StageTag({ item }: { item: HomeMatch }) {
  return <span className={`hp-stage stage-${item.stage}`}>{STAGE_LABELS[item.stage]}</span>;
}

export function ProgressBar({ item }: { item: HomeMatch }) {
  const { done_rallies: done, total_rallies: total } = item.match;
  if (total === 0) return <span className="hp-faint">no Rallies</span>;
  return (
    <span className="hp-progress" title={`${done} of ${total} Rallies Done`}>
      <span className="hp-progress-bar">
        <span style={{ width: `${(done / total) * 100}%` }} />
      </span>
      <span className="mono">
        {done}/{total}
      </span>
    </span>
  );
}

export function Active({ item }: { item: HomeMatch }) {
  const seconds = item.match.operator_time.active_seconds;
  return <span className={`mono ${seconds ? "" : "hp-faint"}`}>{formatActiveTime(seconds)}</span>;
}

export function Ratio({ item }: { item: HomeMatch }) {
  const { match } = item;
  const budget = match.annotation_mode === "assisted" ? match.assisted_ratio_budget : null;
  if (match.operator_time_ratio === null) return <span className="mono hp-faint">—</span>;
  return (
    <span className={`mono ${ratioClassName(match.operator_time_ratio, budget)}`}>
      {formatRatio(match.operator_time_ratio)}
    </span>
  );
}

export function FilterChips({
  items,
  filter,
  onFilter,
}: {
  items: HomeMatch[];
  filter: Filter;
  onFilter: (filter: Filter) => void;
}) {
  const filters: Filter[] = ["all", ...STAGES];
  return (
    <div className="hp-chips" role="tablist" aria-label="Filter Matches">
      {filters.map((f, i) => {
        const count = f === "all" ? items.length : items.filter((m) => m.stage === f).length;
        return (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={`hp-chip${filter === f ? " on" : ""}${count === 0 ? " empty" : ""}`}
            onClick={() => onFilter(f)}
            title={`Show ${f === "all" ? "all Matches" : STAGE_LABELS[f]} (${i + 1})`}
          >
            {f === "all" ? "All" : STAGE_LABELS[f]}
            <span className="mono">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function useOpen() {
  const navigate = useNavigate();
  return {
    primary: (item: HomeMatch) =>
      void navigate({
        to: "/matches/$matchId/$workspace",
        params: { matchId: item.match.id, workspace: item.action.workspace },
      }),
    edit: (item: HomeMatch) =>
      void navigate({ to: "/matches/$matchId/edit", params: { matchId: item.match.id } }),
    report: (item: HomeMatch) =>
      void navigate({
        to: "/matches/$matchId/$workspace",
        params: { matchId: item.match.id, workspace: "report" },
      }),
    newMatch: () => void navigate({ to: "/matches/new" }),
  };
}

/**
 * Home keys: J/K (and ↑/↓) move, Enter opens the primary action, E edits, R reports,
 * N new Match, / focuses the filter, 1–6 pick a filter chip, Esc leaves the filter field.
 * `extra` lets a variant add its own keys (the board's H/L).
 */
export function useHomeKeys({
  items,
  selected,
  onSelect,
  onFilter,
  filterRef,
  extra,
}: {
  items: HomeMatch[];
  selected: HomeMatch | null;
  onSelect: (item: HomeMatch) => void;
  onFilter: (filter: Filter) => void;
  filterRef: RefObject<HTMLInputElement | null>;
  extra?: (event: KeyboardEvent) => boolean;
}) {
  const open = useOpen();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextEntry(event.target)) {
        if (event.key === "Escape" || event.key === "Enter" || event.key === "ArrowDown") {
          (event.target as HTMLElement).blur();
          event.preventDefault();
        }
        return;
      }
      if (extra?.(event)) {
        event.preventDefault();
        return;
      }
      const index = selected ? items.indexOf(selected) : -1;
      const move = (delta: number) => {
        const next = items[Math.min(items.length - 1, Math.max(0, index + delta))];
        if (next) onSelect(next);
      };
      const key = event.key;
      if (key === "j" || key === "ArrowDown") move(1);
      else if (key === "k" || key === "ArrowUp") move(-1);
      else if (key === "Enter" && selected && !selected.action.disabled) open.primary(selected);
      else if (key === "e" && selected) open.edit(selected);
      else if (key === "r" && selected) open.report(selected);
      else if (key === "n") open.newMatch();
      else if (key === "/") filterRef.current?.focus();
      else if (/^[1-6]$/.test(key)) onFilter((["all", ...STAGES] as Filter[])[Number(key) - 1]!);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [items, selected, onSelect, onFilter, filterRef, extra, open]);
}

export function KeyHints({ board = false }: { board?: boolean }) {
  return (
    <div className="hp-keyhints">
      <span>
        <kbd>J</kbd>
        <kbd>K</kbd> move
      </span>
      {board && (
        <span>
          <kbd>H</kbd>
          <kbd>L</kbd> lane
        </span>
      )}
      <span>
        <kbd>⏎</kbd> open
      </span>
      <span>
        <kbd>E</kbd> edit
      </span>
      <span>
        <kbd>R</kbd> report
      </span>
      <span>
        <kbd>N</kbd> new
      </span>
      <span>
        <kbd>/</kbd> filter
      </span>
      <span>
        <kbd>1</kbd>–<kbd>6</kbd> stage
      </span>
    </div>
  );
}
