// PROTOTYPE (throwaway, branch prototype/home-screen).
// Question: what should the Home (start) screen look like so the next job is one key away?
// Plan: three structurally different variants on the existing `/` route, switchable with
// `?variant=` (A is today's MatchList), plus `?data=sample` to dress the Matches in varied states.
// Read-only: the only side effects are the links each variant already had.
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { listMatches } from "../../api/client";
import { PrototypeSwitcher } from "../../shell/PrototypeSwitcher";
import { MatchList } from "../MatchList";
import {
  type Filter,
  type HomeMatch,
  filterItems,
  groupByTournament,
  pickContinue,
  sampleMatches,
  toHomeMatch,
} from "./homeModel";
import "./homePrototype.css";
import { VariantBoard, name as boardName } from "./VariantBoard";
import { VariantContinue, name as continueName } from "./VariantContinue";
import { VariantSplit, name as splitName } from "./VariantSplit";

const VARIANTS = [
  { key: "A", name: "Current table" },
  { key: "B", name: continueName },
  { key: "C", name: boardName },
  { key: "D", name: splitName },
];

export function HomePrototype() {
  const search = useSearch({ strict: false }) as {
    variant?: string;
    data?: string;
    select?: string;
    clean?: string;
  };
  const navigate = useNavigate();
  const variant = VARIANTS.some((v) => v.key === search.variant) ? search.variant! : "A";
  const sample = search.data === "sample";
  const setSearch = (next: { variant?: string; data?: string }) =>
    void navigate({ to: "/", search: { ...search, ...next }, replace: true });

  // `?clean=1` hides the bar for screenshots; `?select=<n>` preselects the nth row.
  const switcher =
    import.meta.env.DEV && search.clean !== "1" ? (
      <PrototypeSwitcher
        variants={VARIANTS}
        current={variant}
        onChange={(key) => setSearch({ variant: key })}
        extra={
          <label className="proto-data">
            <input
              type="checkbox"
              checked={sample}
              onChange={(e) => setSearch({ data: e.target.checked ? "sample" : undefined })}
            />
            sample data
          </label>
        }
      />
    ) : null;

  if (!import.meta.env.DEV || variant === "A") {
    return (
      <>
        <MatchList />
        {switcher}
      </>
    );
  }
  return (
    <>
      <Variants variant={variant} sample={sample} initialIndex={Number(search.select ?? -1)} />
      {switcher}
    </>
  );
}

function Variants({
  variant,
  sample,
  initialIndex,
}: {
  variant: string;
  sample: boolean;
  initialIndex: number;
}) {
  const matches = useQuery({ queryKey: ["matches"], queryFn: listMatches });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const all = useMemo<HomeMatch[]>(() => {
    const raw = matches.data ?? [];
    const list = sample ? sampleMatches(raw) : raw;
    return list.map((m, i) => toHomeMatch(m, `${m.id}-${i}`));
  }, [matches.data, sample]);
  const continueItem = useMemo(() => pickContinue(all), [all]);
  // Flatten the Tournament groups so J/K walk rows in the order they are drawn.
  const shown = useMemo(
    () => groupByTournament(filterItems(all, filter, query)).flatMap((g) => g.items),
    [all, filter, query],
  );
  const selected =
    shown.find((m) => m.key === selectedKey) ??
    shown[initialIndex] ??
    (continueItem && shown.includes(continueItem) ? continueItem : null) ??
    shown[0] ??
    null;

  if (matches.isPending) return <p className="notice">Loading Matches…</p>;
  if (matches.isError) return <p className="notice error">{matches.error.message}</p>;

  const props = {
    all,
    shown,
    continueItem,
    filter,
    onFilter: setFilter,
    query,
    onQuery: setQuery,
    selected,
    onSelect: (item: HomeMatch) => setSelectedKey(item.key),
    sample,
  };
  if (variant === "B") return <VariantContinue {...props} />;
  if (variant === "C") return <VariantBoard {...props} />;
  return <VariantSplit {...props} />;
}
