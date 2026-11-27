const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether `value` is a real YYYY-MM-DD calendar date with a 4-digit year (>= 1000).
 *
 * Chrome's `<input type="date">` emits partial-year values such as `0002-04-12` while a user is
 * typing a 4-digit year, so both the UI and backend (`MIN_MATCH_YEAR = 1000`) reject years < 1000.
 */
export function isValidMatchDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1000) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
