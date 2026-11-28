import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { fuzzyNearMatchScore, normalizeFuzzy, normalizeName } from "./nameMatching";

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The editable combobox manages its own listbox. */

function suggestName<T>(
  fuzzyQuery: string,
  options: { choice: T; fuzzy: string }[],
): T | undefined {
  if (!fuzzyQuery) return undefined;
  let suggestion: T | undefined;
  let bestScore = Infinity;
  for (const { choice, fuzzy } of options) {
    const score = fuzzyNearMatchScore(fuzzyQuery, fuzzy);
    if (score !== null && score < bestScore) {
      suggestion = choice;
      bestScore = score;
    }
    if (score === 0) break;
  }
  return suggestion;
}

export function NameField<T extends { name: string }>({
  label,
  name,
  choices,
  onChange,
  onPick,
  choiceLabel = (choice) => choice.name,
}: {
  label: string;
  name: string;
  choices: T[];
  onChange: (name: string) => void;
  onPick: (choice: T) => void;
  choiceLabel?: (choice: T) => string;
}) {
  const id = useId();
  const listId = `${id}-options`;
  const hintId = `${id}-hint`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const search = normalizeName(name);
  const fuzzySearch = normalizeFuzzy(name);
  const indexed = useMemo(
    () =>
      choices.map((choice) => ({
        choice,
        normalized: normalizeName(choice.name),
        fuzzy: normalizeFuzzy(choice.name),
      })),
    [choices],
  );
  const options = indexed
    .filter(
      ({ normalized, fuzzy }) =>
        normalized.includes(search) || (fuzzySearch !== "" && fuzzy.includes(fuzzySearch)),
    )
    .slice(0, 6)
    .map(({ choice }) => choice);
  const visible = open && options.length > 0;
  const suggestion = useMemo(
    () =>
      choices.some((choice) => choice.name === name.trim())
        ? undefined
        : suggestName(fuzzySearch, indexed),
    [choices, name, fuzzySearch, indexed],
  );

  function pick(choice: T) {
    onPick(choice);
    setOpen(false);
    setActive(-1);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && visible) {
      event.preventDefault();
      setOpen(false);
      setActive(-1);
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive(
        event.key === "ArrowDown"
          ? (active + 1) % options.length
          : active <= 0
            ? options.length - 1
            : active - 1,
      );
    }
    const selected = options[active];
    if (event.key === "Enter" && visible && selected) {
      event.preventDefault();
      pick(selected);
    }
  }

  return (
    <div className="new-match-field">
      <label htmlFor={id}>{label}</label>
      <div className="name-field">
        <input
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={visible && options[active] ? `${listId}-${active}` : undefined}
          aria-describedby={suggestion ? hintId : undefined}
          value={name}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
          }}
          onKeyDown={handleKey}
          autoComplete="off"
          spellCheck={false}
          required
        />
        {suggestion && (
          <p className="name-hint" id={hintId}>
            Did you mean{" "}
            <button type="button" onClick={() => pick(suggestion)}>
              {choiceLabel(suggestion)}
            </button>
            ?
          </p>
        )}
        {visible && (
          <div className="name-options" id={listId} role="listbox" aria-label={label}>
            {options.map((choice, index) => (
              <button
                type="button"
                key={index}
                id={`${listId}-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(choice)}
              >
                {choiceLabel(choice)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
