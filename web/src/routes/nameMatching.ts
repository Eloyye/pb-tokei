/**
 * Approximates backend `" ".join(name.split()).casefold()` (folding outer/internal whitespace,
 * case, and `ß`/`ẞ` -> `ss`). Any rare remaining Unicode casefold difference is still handled
 * safely by the server's 422 recovery path.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ").replace(/[ßẞ]/g, "ss").toLowerCase();
}

/**
 * Normalizes punctuation, whitespace, and case for fuzzy name comparison so hyphen and
 * punctuation variants ("Anna-Leigh Waters" <-> "Anna Leigh Waters", "J.W. Johnson" <->
 * "JW Johnson", "O'Brien" <-> "OBrien") match reliably.
 */
export function normalizeFuzzy(name: string): string {
  return name
    .replace(/[-–—]/g, " ")
    .replace(/[.'’‘]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[ßẞ]/g, "ss")
    .toLowerCase();
}

function maxEditDistance(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  if (minLen < 3) return 0;
  if (minLen < 5) return 1;
  return 2;
}

/** Optimal string alignment (Damerau-Levenshtein) distance, capped at `limit`. */
export function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return Infinity;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prevPrev[j - 2]! + 1);
      }
      curr.push(best);
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > limit) return Infinity;
    prevPrev = prev;
    prev = curr;
  }
  return prev[b.length]!;
}

/**
 * All words of one name appear in the other. Requires at least 2 characters on both sides so
 * single-character queries don't fuzzy-match, and requires full-word containment rather than
 * single-word overlap so sibling pairs ("Ben Johns" / "Collin Johns", "JW Johnson" /
 * "Jorja Johnson", "Jade Kawamoto" / "Jackie Kawamoto") never false-positive.
 */
export function wordsContained(a: string, b: string): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const left = a.split(" ");
  const right = b.split(" ");
  return left.every((word) => right.includes(word)) || right.every((word) => left.includes(word));
}

/** Lower score means a closer near-match; null means not a near-match. */
export function fuzzyNearMatchScore(queryFuzzy: string, targetFuzzy: string): number | null {
  if (!queryFuzzy || !targetFuzzy) return null;
  if (queryFuzzy === targetFuzzy) return 0;
  const limit = maxEditDistance(queryFuzzy, targetFuzzy);
  const distance = editDistance(queryFuzzy, targetFuzzy, limit);
  if (distance <= limit) return distance;
  if (wordsContained(queryFuzzy, targetFuzzy)) return 3;
  return null;
}
