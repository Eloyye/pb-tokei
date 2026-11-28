// PROTOTYPE variant D, "List + detail": a narrow Match list on the left (Premiere's Project panel),
// and a detail pane for the selected Match that fills the width: a frame from the video at the
// resume point, the Players, every Game as a strip of Rallies, then the numbers.
// Continue is the default selection, so Enter on arrival resumes.
/* oxlint-disable jsx-a11y/media-has-caption -- prototype: a muted still frame, never played. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { type Game, getGames, getMatch, matchVideoUrl } from "../../api/client";
import { FPS } from "../../lib/frames";
import { formatActiveTime, formatRatio } from "../../lib/operatorTime";
import { videoPill } from "../teams";
import {
  type HomeMatch,
  STEP_LABELS,
  fetchLabel,
  fetchPercent,
  groupByTournament,
} from "./homeModel";
import {
  FilterChips,
  Franchises,
  KeyHints,
  Pipeline,
  StageTag,
  Teams,
  useHomeKeys,
  useOpen,
} from "./shared";
import type { VariantProps } from "./VariantContinue";

export const name = "List + detail";

export function VariantSplit(props: VariantProps) {
  const { all, shown, continueItem, filter, onFilter, query, onQuery, selected, onSelect, sample } =
    props;
  const filterRef = useRef<HTMLInputElement>(null);
  useHomeKeys({ items: shown, selected, onSelect, onFilter, filterRef });

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (selected) rowRefs.current.get(selected.key)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <main className="hp hp-d">
      <aside className="hp-panel hp-list">
        <div className="hp-panel-head">
          <span>Matches</span>
          <span className="mono hp-faint">{shown.length}</span>
          <span className="hp-upnext-spacer" />
          <Link to="/matches/new" className="hp-ghost" title="New Match (N)">
            + New
          </Link>
        </div>
        <div className="hp-list-tools">
          <input
            ref={filterRef}
            className="hp-search"
            placeholder="Filter  /"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          <FilterChips items={all} filter={filter} onFilter={onFilter} />
        </div>
        <div className="hp-list-body">
          {groupByTournament(shown).map((group) => (
            <div key={group.tournament}>
              <div className="hp-list-group">
                {group.tournament}
                <span className="mono">{group.dateRange}</span>
              </div>
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  ref={(el) => {
                    if (el) rowRefs.current.set(item.key, el);
                    else rowRefs.current.delete(item.key);
                  }}
                  className={`hp-list-row${selected?.key === item.key ? " sel" : ""}`}
                  onClick={() => onSelect(item)}
                >
                  <span className={`hp-lane-dot stage-${item.stage}`} title={item.stage} />
                  <Teams item={item} compact />
                  {continueItem?.key === item.key && (
                    <span className="hp-cont-dot" title="Continue" />
                  )}
                  <span className="mono hp-faint">
                    {item.match.total_rallies
                      ? `${item.match.done_rallies}/${item.match.total_rallies}`
                      : ""}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {shown.length === 0 && <div className="hp-empty">No Matches match this filter.</div>}
        </div>
      </aside>
      <section className="hp-panel hp-detail">
        {selected ? (
          <Detail
            key={selected.key}
            item={selected}
            isContinue={continueItem?.key === selected.key}
            sample={sample}
          />
        ) : (
          <div className="hp-empty">Select a Match.</div>
        )}
        <KeyHints />
      </section>
    </main>
  );
}

interface PlayerRow {
  name: string;
  team: "a" | "b";
  handedness: "left" | "right" | null;
}

type RallyStatus = Game["rallies"][number]["status"];

interface GameRow {
  number: number;
  rallies: { number: number; status: RallyStatus; startFrame: number | null }[];
}

/** Real Games and Players from the API; in sample mode, made up to match the sample's totals. */
function useDetailData(item: HomeMatch, sample: boolean) {
  const { match } = item;
  const detail = useQuery({
    queryKey: ["matches", match.id],
    queryFn: () => getMatch(match.id),
    enabled: !sample,
  });
  const games = useQuery({
    queryKey: ["prototype-games", match.id],
    queryFn: () => getGames(match.id),
    enabled: !sample,
  });

  if (sample) {
    return {
      players: samplePlayers(item),
      games: sampleGames(match.done_rallies, match.total_rallies),
      fixCommand: null,
    };
  }
  const players: PlayerRow[] | null =
    detail.data?.players.map((p) => ({ name: p.name, team: p.team, handedness: p.handedness })) ??
    null;
  const gameRows: GameRow[] | null =
    games.data?.map((g) => ({
      number: g.number,
      rallies: g.rallies.map((r) => ({
        number: r.number,
        status: r.status,
        startFrame: r.start_frame,
      })),
    })) ?? null;
  return { players, games: gameRows, fixCommand: detail.data?.fix_command ?? null };
}

function sampleHand(player: string): PlayerRow["handedness"] {
  return [...player].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4 === 0 ? "left" : "right";
}

function samplePlayers(item: HomeMatch): PlayerRow[] {
  const row =
    (team: "a" | "b") =>
    (player: string): PlayerRow => ({ name: player, team, handedness: sampleHand(player) });
  return [...item.match.team_a.map(row("a")), ...item.match.team_b.map(row("b"))];
}

function sampleGames(done: number, total: number): GameRow[] {
  if (total === 0) return [];
  const count = total > 80 ? 3 : 2;
  const per = Math.ceil(total / count);
  const games: GameRow[] = [];
  let n = 0;
  for (let g = 1; g <= count; g++) {
    const rallies: GameRow["rallies"] = [];
    for (let r = 1; r <= per && n < total; r++, n++) {
      const status: RallyStatus = n < done ? "done" : n === done ? "in_progress" : "empty";
      rallies.push({ number: r, status, startFrame: 600 + n * 1500 });
    }
    games.push({ number: g, rallies });
  }
  return games;
}

/** The first Rally not Done, as "G3 R2", with a frame to show; null when every Rally is Done. */
function resumePoint(games: GameRow[] | null) {
  if (!games) return null;
  let lastFrame: number | null = null;
  for (const game of games) {
    for (const rally of game.rallies) {
      if (rally.status !== "done") {
        return { label: `G${game.number} R${rally.number}`, frame: rally.startFrame ?? lastFrame };
      }
      lastFrame = rally.startFrame ?? lastFrame;
    }
  }
  return null;
}

function Detail({
  item,
  isContinue,
  sample,
}: {
  item: HomeMatch;
  isContinue: boolean;
  sample: boolean;
}) {
  const open = useOpen();
  const { match } = item;
  const { players, games, fixCommand } = useDetailData(item, sample);
  const resume = resumePoint(games);
  const assisted = match.annotation_mode === "assisted";
  const pill = videoPill(match);
  const resumeLabel = item.stage === "annotate" && resume ? resume.label : item.resumeAt;

  return (
    <div className="hp-detail-body">
      <div className="hp-detail-head">
        <div>
          {isContinue && <div className="hp-continue-label">Continue where you left off</div>}
          <div className="hp-detail-crumb">
            {match.tournament} · <span className="mono">{match.date ?? "undated"}</span>
          </div>
          <h2 className="hp-detail-title">
            <span className="hp-team">
              <span className="swatch team-a" /> {match.team_a.join(" / ")}
            </span>
            <span className="hp-vs">vs</span>
            <span className="hp-team">
              <span className="swatch team-b" /> {match.team_b.join(" / ")}
            </span>
          </h2>
          <Franchises item={item} />
        </div>
        <div className="hp-detail-tags">
          <StageTag item={item} />
          <span className={`pill ${assisted ? "pill-active" : "pill-none"}`}>
            {assisted ? "Assisted" : "Gold"}
          </span>
          <span className={pill.className}>{pill.label}</span>
        </div>
      </div>

      <div className="hp-hero">
        <div className="hp-hero-left">
          <Thumbnail
            item={item}
            sample={sample}
            frame={resume?.frame ?? null}
            resumeLabel={resumeLabel}
            fixCommand={fixCommand}
          />
          <div className="hp-detail-cta">
            <button
              type="button"
              className="hp-resume big"
              disabled={item.action.disabled}
              onClick={() => open.primary(item)}
            >
              <span>
                {item.action.label}
                {resumeLabel && <span className="hp-resume-at"> · {resumeLabel}</span>}
              </span>
              <kbd>⏎</kbd>
            </button>
            <button type="button" className="button" onClick={() => open.edit(item)}>
              Edit <kbd>E</kbd>
            </button>
            <button type="button" className="button" onClick={() => open.report(item)}>
              Report <kbd>R</kbd>
            </button>
          </div>
        </div>

        <div className="hp-hero-right">
          <div className="hp-card-block">
            <div className="hp-block-title">Players</div>
            {players ? (
              <ul className="hp-players">
                {players.map((p) => (
                  <li key={`${p.team}-${p.name}`}>
                    <span className={`swatch team-${p.team}`} />
                    <span className="hp-player-name">{p.name}</span>
                    {p.handedness && (
                      <span className="hp-hand" title={`${p.handedness}-handed`}>
                        {p.handedness === "left" ? "L" : "R"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="hp-faint">Loading…</span>
            )}
          </div>
          <div className="hp-card-block">
            <div className="hp-block-title">Pipeline</div>
            <Pipeline item={item} labels />
            <ol className="hp-steps">
              {item.steps.map((s) => (
                <li key={s.key} className={s.state}>
                  <span className="hp-step-mark" />
                  {STEP_LABELS[s.key]}
                  <span className="hp-faint">{STEP_STATE_LABELS[s.state]}</span>
                </li>
              ))}
            </ol>
          </div>
          <div className="hp-detail-grid">
            <div className="hp-card-block">
              <div className="hp-block-title">Operator time</div>
              <div className="hp-big mono">
                {formatActiveTime(match.operator_time.active_seconds)}
              </div>
              <TimeSplit
                c={match.operator_time.calibrate_seconds}
                a={match.operator_time.annotate_seconds}
                r={match.operator_time.review_seconds}
              />
            </div>
            <RatioBlock item={item} />
          </div>
        </div>
      </div>

      <div className="hp-card-block">
        <div className="hp-block-title hp-games-title">
          Games
          <span className="hp-faint mono">
            {match.done_rallies} / {match.total_rallies} Rallies Done
          </span>
          <span className="hp-games-legend">
            <span className="hp-tick s-done" /> Done
            <span className="hp-tick s-in_progress" /> In progress
            <span className="hp-tick s-empty" /> Not started
          </span>
        </div>
        <Games games={games} resumeLabel={resume?.label ?? null} />
      </div>
    </div>
  );
}

const STEP_STATE_LABELS = {
  done: "done",
  todo: "not yet",
  busy: "fetching",
  error: "failed",
  current: "next",
} as const;

/**
 * A still from the video at the resume point (a muted `<video>` seeked with `#t=`), or a drawn
 * broadcast-angle court when there is no playable video yet, with what to do about it.
 */
function Thumbnail({
  item,
  sample,
  frame,
  resumeLabel,
  fixCommand,
}: {
  item: HomeMatch;
  sample: boolean;
  frame: number | null;
  resumeLabel: string | null;
  fixCommand: string | null;
}) {
  const open = useOpen();
  const { match } = item;
  const playable = match.video_status === "ready" && !sample;
  const seconds = Math.max(5, (frame ?? 0) / FPS);
  const percent = fetchPercent(match);
  const fetching = fetchLabel(match);
  return (
    <button
      type="button"
      className={`hp-thumb${playable ? "" : " placeholder"}`}
      disabled={item.action.disabled}
      onClick={() => open.primary(item)}
      title={`${item.action.label} (Enter)`}
    >
      {playable ? (
        <video
          src={`${matchVideoUrl(match.id)}#t=${seconds.toFixed(2)}`}
          preload="metadata"
          muted
          playsInline
        />
      ) : (
        <CourtSketch />
      )}
      <span className="hp-thumb-shade" />
      <span className="hp-thumb-tag">
        {match.video_status === "ready" ? "MAIN VIEW" : pillText(match.video_status)}
      </span>
      {resumeLabel && (
        <span className="hp-thumb-frame mono">
          {resumeLabel}
          {frame !== null && <span> · frame {frame}</span>}
        </span>
      )}
      <span className="hp-thumb-center">
        {fetching ? (
          <span className="hp-thumb-fetch">
            <span>{fetching}</span>
            <span className="hp-progress-bar wide">
              <span style={{ width: `${percent ?? 0}%` }} />
            </span>
          </span>
        ) : (
          <span className="hp-thumb-play">
            <PlayIcon />
            {item.action.label}
          </span>
        )}
      </span>
      {!playable && fixCommand && match.video_status === "none" && !fetching && (
        <code className="hp-thumb-cmd" title="Or run this in a terminal">
          {fixCommand}
        </code>
      )}
    </button>
  );
}

function pillText(status: HomeMatch["match"]["video_status"]): string {
  return status === "not_converted" ? "NOT CONVERTED" : "NO VIDEO";
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M3 1.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

/** A broadcast-angle court in the app's court colors, standing in for a missing video frame. */
function CourtSketch() {
  // Court corners in a 160×90 frame, near baseline wider than far baseline.
  const far = { y: 24, l: 52, r: 108 };
  const near = { y: 80, l: 18, r: 142 };
  const at = (t: number) => ({
    y: far.y + (near.y - far.y) * t,
    l: far.l + (near.l - far.l) * t,
    r: far.r + (near.r - far.r) * t,
  });
  const line = (t: number) => {
    const p = at(t);
    return `M${p.l} ${p.y}H${p.r}`;
  };
  const net = at(0.5);
  const kitchenFar = 0.5 - 7 / 44;
  const kitchenNear = 0.5 + 7 / 44;
  const cFar = at(0);
  const cNear = at(1);
  const midFar = at(kitchenFar);
  const midNear = at(kitchenNear);
  return (
    <svg className="hp-court-sketch" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice">
      <rect width="160" height="90" fill="var(--surround)" />
      <path
        d={`M${far.l} ${far.y}H${far.r}L${near.r} ${near.y}H${near.l}Z`}
        fill="var(--court)"
        stroke="var(--court-line)"
        strokeWidth="0.6"
      />
      <path
        d={`M${at(kitchenFar).l} ${at(kitchenFar).y}L${at(kitchenNear).l} ${at(kitchenNear).y}H${at(kitchenNear).r}L${at(kitchenFar).r} ${at(kitchenFar).y}Z`}
        fill="var(--court-fc)"
      />
      <path
        d={`${line(kitchenFar)}${line(kitchenNear)}M${(cFar.l + cFar.r) / 2} ${cFar.y}L${(midFar.l + midFar.r) / 2} ${midFar.y}M${(midNear.l + midNear.r) / 2} ${midNear.y}L${(cNear.l + cNear.r) / 2} ${cNear.y}`}
        stroke="var(--court-line)"
        strokeWidth="0.5"
        fill="none"
      />
      <path
        d={`M${net.l - 3} ${net.y}H${net.r + 3}`}
        stroke="var(--court-line)"
        strokeWidth="1.4"
        opacity="0.8"
      />
    </svg>
  );
}

function Games({ games, resumeLabel }: { games: GameRow[] | null; resumeLabel: string | null }) {
  if (!games) return <span className="hp-faint">Loading…</span>;
  if (games.length === 0) return <span className="hp-faint">No Games entered yet.</span>;
  return (
    <div className="hp-games">
      {games.map((game) => {
        const done = game.rallies.filter((r) => r.status === "done").length;
        return (
          <div key={game.number} className="hp-game">
            <span className="hp-game-name mono">G{game.number}</span>
            <span className="hp-ticks">
              {game.rallies.map((r) => {
                const here = resumeLabel === `G${game.number} R${r.number}`;
                return (
                  <span
                    key={r.number}
                    className={`hp-tick s-${r.status}${here ? " here" : ""}`}
                    title={`G${game.number} R${r.number}: ${r.status.replace("_", " ")}`}
                  />
                );
              })}
            </span>
            <span className="mono hp-faint">
              {done}/{game.rallies.length}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RatioBlock({ item }: { item: HomeMatch }) {
  const { match } = item;
  const assisted = match.annotation_mode === "assisted";
  const ratio = match.operator_time_ratio;
  const budget = match.assisted_ratio_budget;
  let ratioClass = "";
  if (ratio === null) ratioClass = "hp-faint";
  else if (assisted) ratioClass = ratio > budget ? "ratio over-budget" : "ratio within-budget";
  return (
    <div className="hp-card-block">
      <div className="hp-block-title">
        Ratio {assisted ? `· budget ${formatRatio(budget)}` : "· no budget (Gold)"}
      </div>
      <div className={`hp-big mono ${ratioClass}`}>{formatRatio(ratio)}</div>
      {assisted && ratio !== null && (
        <span className="hp-budget">
          <span
            style={{ width: `${Math.min(100, (ratio / budget) * 100)}%` }}
            className={ratio > budget ? "over" : ""}
          />
        </span>
      )}
      <span className="hp-faint">
        {match.broadcast_seconds
          ? `Broadcast ${formatActiveTime(match.broadcast_seconds)}`
          : "Broadcast length unknown"}
      </span>
    </div>
  );
}

function TimeSplit({ c, a, r }: { c: number; a: number; r: number }) {
  const total = c + a + r;
  if (total === 0) return <span className="hp-faint">No time yet</span>;
  const parts = [
    ["Calibrate", c, "c"],
    ["Annotate", a, "a"],
    ["Review", r, "r"],
  ] as const;
  return (
    <div>
      <span className="hp-split">
        {parts.map(([label, s, cls]) => (
          <span
            key={cls}
            className={cls}
            style={{ width: `${(s / total) * 100}%` }}
            title={`${label} ${formatActiveTime(s)}`}
          />
        ))}
      </span>
      <div className="hp-split-legend">
        {parts.map(([label, s, cls]) => (
          <span key={cls}>
            <span className={`hp-split-key ${cls}`} />
            {label} <span className="mono">{formatActiveTime(s)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
