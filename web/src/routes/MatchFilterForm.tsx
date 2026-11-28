import type { FormEvent } from "react";
import type { PlayerMatchFilters } from "../api/client";
import type { components } from "../api/schema";
import { playerMatchFilters, teamMatchFilters, TOURS } from "./matchFilters";

type SubjectFilterOptions = components["schemas"]["SubjectFilterOptions"];
type ReportPlayer = components["schemas"]["ReportPlayer"];

export function MatchFilterForm({
  filters,
  options,
  showPartner,
  onApply,
}: {
  filters: PlayerMatchFilters;
  options: SubjectFilterOptions;
  showPartner: boolean;
  onApply: (filters: PlayerMatchFilters) => void;
}) {
  const selectedTournaments = filters.tournament ?? [];
  const unavailableTournaments = selectedTournaments.filter(
    (id) => !options.tournaments.some((tournament) => tournament.id === id),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = { ...Object.fromEntries(data), tournament: data.getAll("tournament") };
    onApply(showPartner ? playerMatchFilters(values) : teamMatchFilters(values));
  }

  return (
    <form className="match-filters" onSubmit={submit} onReset={() => onApply({})}>
      <fieldset className="match-filter-panel">
        <legend>Filter Matches</legend>
        <div className="match-filter-fields" key={JSON.stringify(filters)}>
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
                  Unavailable Tournament ({id})
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
              {Object.entries(TOURS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="match-filter-field">
            Date from
            <input
              type="date"
              name="date_from"
              min="1000-01-01"
              max="9999-12-31"
              defaultValue={filters.date_from ?? ""}
            />
          </label>
          <label className="match-filter-field">
            Date to
            <input
              type="date"
              name="date_to"
              min="1000-01-01"
              max="9999-12-31"
              defaultValue={filters.date_to ?? ""}
            />
          </label>
          {showPartner && (
            <PlayerFilter
              name="partner"
              label="Partner"
              value={filters.partner}
              players={options.partners}
            />
          )}
          <PlayerFilter
            name="opponent"
            label="Opponent"
            value={filters.opponent}
            players={options.opponents}
          />
        </div>
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
