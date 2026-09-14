/**
 * Keeply — a substring search that is case-insensitive in every language.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * SQLite's `LIKE` is case-insensitive for ASCII **and only for ASCII**, and its
 * `lower()` folds only ASCII too. So `lower(x) LIKE lower('%muñoz%')` does not
 * find `MUÑOZ MARKET`: every letter but one folds, the `Ñ` does not, and the
 * row is simply absent. No error, no hint — the user concludes the receipt was
 * never saved.
 *
 * That is not an exotic case here. Parañaque and Las Piñas are cities, Peña and
 * Muñoz are surnames, and receipts carry merchant names printed in capitals.
 *
 * ── WHY GLOB AND NOT A FOLDED COLUMN ───────────────────────────────────────
 * The usual fix is a `*_folded` column written by the app, because JavaScript's
 * `toLowerCase()` knows Unicode and SQLite does not. It also means a migration
 * on five tables, a second copy of every searchable string on disk, and a write
 * path that silently rots the day a patch updates `name` without refreshing the
 * copy.
 *
 * SQLite's `GLOB` takes character classes, which `LIKE` does not, and compares
 * them by code point rather than by byte — so `[ñÑ]` is a working
 * case-insensitive `ñ`. Folding the NEEDLE in JavaScript, where Unicode is
 * understood, and asking SQLite only to compare code points, needs no schema
 * change and no write path at all. `*[mM][uU][ñÑ][oO][zZ]*` finds the row.
 *
 * The cost is honest: `GLOB '*x*'` scans, exactly as `LIKE '%x%'` did. This is
 * the same query plan, not a slower one.
 *
 * ── EVERY CHARACTER IS ESCAPED, NOT JUST THE OBVIOUS ONES ──────────────────
 * `GLOB` has no `ESCAPE` clause. Its three metacharacters are escaped by
 * putting them in a class of their own — `[*]`, `[?]`, `[[]` — which is what
 * {@link globContains} does. `]` is literal outside a class, and the only
 * things this ever puts INSIDE a class are two cased forms of one letter,
 * which can never be `-`, `^`, `]` or a metacharacter.
 */

/**
 * Search terms are truncated at this length before becoming a pattern.
 *
 * SQLite refuses a pattern over `SQLITE_MAX_LIKE_PATTERN_LENGTH` (50,000) with
 * "LIKE or GLOB pattern too complex", and a cased letter costs four characters
 * here, so ~12,500 letters is the real ceiling. Truncating makes the pattern
 * LESS selective — the user gets extra rows, never fewer — which is a far
 * better failure for a search box than an exception. Nothing that reaches a
 * search field is remotely near this; it is a guard against a paste.
 */
export const SEARCH_TERM_MAX_LENGTH = 2000;

/** The three characters `GLOB` treats as special, outside a class. */
const GLOB_META = new Set(['*', '?', '[']);

/**
 * A `GLOB` pattern matching `term` anywhere in a string, ignoring case.
 *
 * Returns `null` for a term that is empty once trimmed — a caller must then
 * add no predicate at all, rather than one matching everything.
 */
export function globContains(term: string): string | null {
  const trimmed = term.trim();
  if (trimmed.length === 0) return null;

  let pattern = '*';
  // Iterated as code points, not UTF-16 units: splitting a surrogate pair would
  // put half an emoji in a character class.
  for (const char of trimmed.slice(0, SEARCH_TERM_MAX_LENGTH)) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();

    // Both forms must be a single code point to go in a class. `ß`.toUpperCase()
    // is `SS`, and `[ßSS]` would be a class of three characters that matches one
    // of them — a wrong answer rather than a missed one.
    if (lower !== upper && [...lower].length === 1 && [...upper].length === 1) {
      pattern += `[${lower}${upper}]`;
    } else if (GLOB_META.has(char)) {
      pattern += `[${char}]`;
    } else {
      pattern += char;
    }
  }

  return `${pattern}*`;
}
