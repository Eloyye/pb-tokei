import { type KeyboardEvent, useId, useMemo, useState } from "react";

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- The editable combobox manages its own listbox. */

function normalize(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return Infinity;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1];
    for (let j = 0; j < b.length; j++) {
      row.push(Math.min(row[j]! + 1, previous[j + 1]! + 1, previous[j]! + Number(a[i] !== b[j])));
    }
    previous = row;
  }
  return previous[b.length]!;
}

function wordsContained(a: string, b: string): boolean {
  const left = a.split(" ");
  const right = b.split(" ");
  return left.every((word) => right.includes(word)) || right.every((word) => left.includes(word));
}

function suggestName<T>(name: string, options: { choice: T; normalized: string }[]): T | undefined {
  if (!name) return undefined;
  let suggestion: T | undefined;
  let bestScore = Infinity;
  for (const { choice, normalized } of options) {
    const distance = editDistance(name, normalized);
    const score = distance <= 2 ? distance : wordsContained(name, normalized) ? 3 : Infinity;
    if (score < bestScore) {
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
  const search = normalize(name);
  const indexed = useMemo(
    () => choices.map((choice) => ({ choice, normalized: normalize(choice.name) })),
    [choices],
  );
  const options = indexed
    .filter(({ normalized }) => normalized.includes(search))
    .slice(0, 6)
    .map(({ choice }) => choice);
  const visible = open && options.length > 0;
  const suggestion = useMemo(
    () =>
      choices.some((choice) => choice.name === name) ? undefined : suggestName(search, indexed),
    [choices, name, search, indexed],
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
