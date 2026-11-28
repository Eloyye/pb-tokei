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
  isChoiceDisabled,
  disabledChoiceLabel,
}: {
  label: string;
  name: string;
  choices: T[];
  onChange: (name: string) => void;
  onPick: (choice: T) => void;
  choiceLabel?: (choice: T) => string;
  isChoiceDisabled?: (choice: T) => boolean;
  disabledChoiceLabel?: (choice: T) => string;
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
        disabled: isChoiceDisabled ? isChoiceDisabled(choice) : false,
      })),
    [choices, isChoiceDisabled],
  );
  const matched = indexed.filter(
    ({ normalized, fuzzy }) =>
      normalized.includes(search) || (fuzzySearch !== "" && fuzzy.includes(fuzzySearch)),
  );
  const eligible = matched.filter(({ disabled }) => !disabled);
  const ineligible = matched.filter(({ disabled }) => disabled);
  const options =
    search || eligible.length < 6
      ? [...eligible.slice(0, 6), ...ineligible].slice(0, 8)
      : eligible.slice(0, 6);
  const visible = open && options.length > 0;
  const eligibleIndexed = useMemo(() => indexed.filter(({ disabled }) => !disabled), [indexed]);
  const suggestion = useMemo(
    () =>
      choices.some((choice) => choice.name === name.trim())
        ? undefined
        : suggestName(fuzzySearch, eligibleIndexed),
    [choices, name, fuzzySearch, eligibleIndexed],
  );

  function pick(choice: T) {
    if (isChoiceDisabled?.(choice)) return;
    onPick(choice);
    setOpen(false);
    setActive(-1);
  }

  function nextEnabledIndex(direction: 1 | -1): number {
    for (let step = 1; step <= options.length; step++) {
      const candidate =
        active < 0
          ? direction === 1
            ? (step - 1) % options.length
            : (options.length - step) % options.length
          : (active + direction * step + options.length) % options.length;
      if (!options[candidate]?.disabled) return candidate;
    }
    return -1;
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
      setActive(nextEnabledIndex(event.key === "ArrowDown" ? 1 : -1));
    }
    const selected = options[active];
    if (event.key === "Enter" && visible && selected && !selected.disabled) {
      event.preventDefault();
      pick(selected.choice);
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
            {options.map(({ choice, disabled }, index) => (
              <button
                type="button"
                key={index}
                id={`${listId}-${index}`}
                role="option"
                className={disabled ? "name-option-disabled" : undefined}
                tabIndex={-1}
                disabled={disabled}
                aria-disabled={disabled || undefined}
                aria-selected={!disabled && index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(choice)}
              >
                {disabled && disabledChoiceLabel
                  ? disabledChoiceLabel(choice)
                  : choiceLabel(choice)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
