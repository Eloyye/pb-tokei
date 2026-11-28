import { useId, useState, type FormEvent } from "react";
import type { PlayerMatchFilters } from "../api/client";
import type { components } from "../api/schema";
import {
  matchFilterDateError,
  matchFilters,
  playerMatchFilters,
  teamMatchFilters,
  TOURS,
} from "./matchFilters";

type SubjectFilterOptions = components["schemas"]["SubjectFilterOptions"];
type ReportPlayer = components["schemas"]["ReportPlayer"];

export function MatchFilterForm({
  filters,
  options,
  showPartner = false,
  onApply,
}: {
  filters: PlayerMatchFilters;
  options: Pick<SubjectFilterOptions, "tournaments"> &
    Partial<Pick<SubjectFilterOptions, "partners" | "opponents">>;
  showPartner?: boolean;
  onApply: (filters: PlayerMatchFilters) => void;
}) {
  const fieldsKey = JSON.stringify(filters);
  const dateErrorId = useId();
  const [dateError, setDateError] = useState<{ fieldsKey: string; message: string }>();
  if (dateError && dateError.fieldsKey !== fieldsKey) setDateError(undefined);

  const selectedTournaments = filters.tournament ?? [];
  const unavailableTournaments = selectedTournaments.filter(
    (id) => !options.tournaments.some((tournament) => tournament.id === id),
  );
  const availableTours = new Set<string>(options.tournaments.map(({ tour }) => tour));
  const tourOptions = Object.entries(TOURS).filter(
    ([tour]) => availableTours.has(tour) || tour === filters.tour,
  );
  const dateInputProps = {
    type: "date",
    min: "1000-01-01",
    max: "9999-12-31",
    "aria-invalid": Boolean(dateError),
    "aria-describedby": dateError ? dateErrorId : undefined,
    onChange: () => setDateError(undefined),
  };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = { ...Object.fromEntries(data), tournament: data.getAll("tournament") };
    const parseSubjectFilters = showPartner ? playerMatchFilters : teamMatchFilters;
    const nextFilters = options.opponents ? parseSubjectFilters(values) : matchFilters(values);
    const error = matchFilterDateError(nextFilters);
    setDateError(error ? { fieldsKey, message: error } : undefined);
    if (!error) onApply(nextFilters);
  }

  function clear() {
    setDateError(undefined);
    onApply({});
  }

  return (
    <form className="match-filters" onSubmit={submit} onReset={clear}>
      <fieldset className="match-filter-panel">
        <legend>Filter Matches</legend>
        <div className="match-filter-fields" key={fieldsKey}>
          <fieldset className="match-filter-tournaments">
            <legend>Tournament</legend>
            <div className="match-filter-choices">
              {options.tournaments.map(({ id, name, tour }) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    name="tournament"
                    value={id}
                    defaultChecked={selectedTournaments.includes(id)}
                  />
                  {name} ({TOURS[tour]})
                </label>
              ))}
              {unavailableTournaments.map((id) => (
                <label key={id}>
                  <input type="checkbox" name="tournament" value={id} defaultChecked />
                  Unavailable Tournament
                </label>
              ))}
              {options.tournaments.length === 0 && unavailableTournaments.length === 0 && (
                <span>No Tournaments</span>
              )}
            </div>
          </fieldset>
          <label className="match-filter-field">
            Tour
            <select name="tour" defaultValue={filters.tour ?? ""}>
              <option value="">All Tours</option>
              {tourOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {availableTours.has(value) ? label : `${label} (unavailable)`}
                </option>
              ))}
            </select>
          </label>
          <label className="match-filter-field">
            Date from
            <input {...dateInputProps} name="date_from" defaultValue={filters.date_from ?? ""} />
          </label>
          <label className="match-filter-field">
            Date to
            <input {...dateInputProps} name="date_to" defaultValue={filters.date_to ?? ""} />
          </label>
          {showPartner && options.partners && (
            <PlayerFilter
              name="partner"
              label="Partner"
              value={filters.partner}
              players={options.partners}
            />
          )}
          {options.opponents && (
            <PlayerFilter
              name="opponent"
              label="Opponent"
              value={filters.opponent}
              players={options.opponents}
            />
          )}
        </div>
        {dateError && (
          <p className="match-filter-error" id={dateErrorId} role="alert">
            {dateError.message}
          </p>
        )}
        <div className="match-filter-actions">
          <button className="button primary" type="submit">
            Apply filters
          </button>
          <button className="button" type="reset">
            Clear filters
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function PlayerFilter({
  name,
  label,
  value,
  players,
}: {
  name: "partner" | "opponent";
  label: string;
  value?: string | null;
  players: ReportPlayer[];
}) {
  return (
    <label className="match-filter-field">
      {label}
      <select name={name} defaultValue={value ?? ""}>
        <option value="">Any {label.toLowerCase()}</option>
        {players.map(({ id, name: playerName }) => (
          <option key={id} value={id}>
            {playerName}
          </option>
        ))}
        {value && !players.some((player) => player.id === value) && (
          <option value={value}>Unavailable Player</option>
        )}
      </select>
    </label>
  );
}
