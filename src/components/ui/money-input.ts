/**
 * Keeply — text → money, in one place.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * `<Amount/>` is the exit: integer minor units become a formatted string.
 * This is the ENTRANCE, and it is the more dangerous direction. Every peso a
 * user ever types passes through here on its way to a `*_minor` column, so
 * every 100x bug the schema is braced against would be born in this function.
 *
 * Three rules make that impossible rather than unlikely:
 *
 *  1. **No floating point, ever.** `1499.50` is not multiplied by 100 —
 *     `parseFloat('1499.50') * 100` is `149949.99999999997` on some inputs and
 *     `Math.round` hides it. Instead the integer part and the fraction are
 *     handled as DIGIT STRINGS and concatenated: `'1499' + '50'` → `149950`.
 *     The result is exact by construction, not by luck.
 *  2. **Never guess.** `'1.499,50'` is 1,499.50 in Europe and nonsense here.
 *     Anything ambiguous is REJECTED with a message, never interpreted. A
 *     wrong guess about a separator is a 100x error the user cannot see.
 *  3. **Never round silently.** `'1499.505'` cannot be represented in
 *     centavos. It is refused, with the text left on screen to be corrected —
 *     it is not quietly truncated to `149950` or rounded to `149951`.
 *
 * The final gate is `minorUnits()` from `@/db`, which rejects a non-integer
 * and anything past `Number.MAX_SAFE_INTEGER`. Nothing here casts to
 * `MinorUnits` by hand.
 *
 * Pure and side-effect free: no React, no theme, no components. `AmountField`
 * is the only caller in the app, but the logic is separable so it can be
 * exercised directly.
 */
// The leaf modules, not the barrels: `@/db` pulls op-sqlite and `@/theme` pulls
// react-native, and this parser is pure logic `node --test` should reach.
import { minorUnits, type MinorUnits } from '@/db/money';
import { DEFAULT_CURRENCY, minorUnitExponent } from '@/theme/format';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/** Why a non-empty draft did not produce an amount. */
export type AmountProblem =
  /** Characters that are not part of a number, and nothing salvageable. */
  | 'not-a-number'
  /** More than one decimal point, or commas that are not thousands groups. */
  | 'ambiguous-separators'
  /** More decimal places than the currency has. Refused, never rounded. */
  | 'too-precise'
  /** Beyond `Number.MAX_SAFE_INTEGER` minor units. */
  | 'too-large'
  /** A minus sign where the field only accepts positives. */
  | 'negative-not-allowed';

export interface AmountParse {
  /**
   * What the input should now show. Grouped (`'1,499.50'`) when the draft
   * parsed; the user's own text, untouched, when it did not — so a rejected
   * paste stays on screen to be fixed rather than vanishing.
   */
  display: string;
  /** The ungrouped numeric text the draft reduces to. `''` when empty. */
  canonical: string;
  /** The amount, or `null` when the draft is empty or unusable. */
  minor: MinorUnits | null;
  /** Set only when `minor` is null *and* the user typed something. */
  problem: AmountProblem | null;
  /**
   * True while the draft is a legitimate half-finished number — `'1499.'`,
   * `'.'`, `''`. Not an error; just not an amount yet.
   */
  incomplete: boolean;
}

export interface AmountInputOptions {
  /** ISO 4217 code. Decides how many decimal places are allowed. */
  currency?: string;
  /** Accept a leading minus. Defaults to `false`. */
  allowNegative?: boolean;
}

/* ------------------------------------------------------------------ *
 * Digit-string helpers
 * ------------------------------------------------------------------ */

const GROUP_SIZE = 3;

/** `'1499'` -> `'1,499'`. Digits only; no sign, no decimal point. */
export function groupInteger(digits: string): string {
  if (digits.length <= GROUP_SIZE) return digits;
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    out += digits[i];
    const remaining = digits.length - i - 1;
    if (remaining > 0 && remaining % GROUP_SIZE === 0) out += ',';
  }
  return out;
}

/** Integer part as written, with commas only in true thousands positions. */
const GROUPED_INTEGER_RE = /^\d{1,3}(?:,\d{3})*$/;
const PLAIN_INTEGER_RE = /^\d*$/;
const PLAIN_FRACTION_RE = /^\d*$/;

/** Everything that is only ever decoration around a number. */
const DECORATION_RE = /[\s\u00a0\u202f\u20b1$\u20ac\u00a3\u00a5]/g;

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function failure(display: string, problem: AmountProblem): AmountParse {
  return { display, canonical: '', minor: null, problem, incomplete: false };
}

/**
 * Turn arbitrary text — typed, pasted, or restored — into an amount.
 *
 * Accepted: `'1499'`, `'1,499.5'`, `'₱1,499.50'`, `'.5'`, `'1499.'`, `'-20'`
 * (with `allowNegative`). Refused, with a reason: two decimal points, commas
 * in positions that are not thousands groups, more decimals than the currency
 * has, and anything that overflows a safe integer.
 */
export function parseAmountInput(raw: string, options: AmountInputOptions = {}): AmountParse {
  const { currency = DEFAULT_CURRENCY, allowNegative = false } = options;
  const exponent = minorUnitExponent(currency);

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { display: '', canonical: '', minor: null, problem: null, incomplete: true };
  }

  // Sign first: it is the only thing allowed to precede the digits.
  let body = trimmed.replace(DECORATION_RE, '');
  let negative = false;
  if (body.startsWith('-') || body.startsWith('−')) {
    negative = true;
    body = body.slice(1);
  }
  if (body.includes('-') || body.includes('−')) return failure(raw, 'not-a-number');
  if (negative && !allowNegative) return failure(raw, 'negative-not-allowed');

  if (body === '') return failure(raw, 'not-a-number');

  // One decimal point, at most. Two is either a typo or a foreign grouping
  // convention, and there is no safe way to tell which.
  const pieces = body.split('.');
  if (pieces.length > 2) return failure(raw, 'ambiguous-separators');

  const rawInt = pieces[0] ?? '';
  const rawFrac = pieces[1] ?? '';
  const hasPoint = pieces.length === 2;

  if (rawInt.includes(',')) {
    // Commas are thousands separators or they are a decimal comma we refuse to
    // guess at. `'1,499'` passes; `'1,49'` and `'1499,50'` do not.
    if (!GROUPED_INTEGER_RE.test(rawInt)) return failure(raw, 'ambiguous-separators');
  } else if (!PLAIN_INTEGER_RE.test(rawInt)) {
    return failure(raw, 'not-a-number');
  }
  if (!PLAIN_FRACTION_RE.test(rawFrac)) {
    // A comma inside the fraction is the European form: refuse, do not reorder.
    return failure(raw, rawFrac.includes(',') ? 'ambiguous-separators' : 'not-a-number');
  }

  // `'007'` is seven pesos. Leading zeros are noise, and dropping them changes
  // no magnitude — the one normalisation that is always safe.
  const intDigits = rawInt.replace(/,/g, '').replace(/^0+(?=\d)/, '');
  if (intDigits === '' && rawFrac === '' && !hasPoint) return failure(raw, 'not-a-number');

  // More decimals than the currency has cannot be stored exactly. Say so.
  if (rawFrac.length > exponent) return failure(raw, 'too-precise');

  const sign = negative ? '-' : '';
  const canonical = hasPoint ? `${sign}${intDigits}.${rawFrac}` : `${sign}${intDigits}`;
  const display = hasPoint
    ? `${sign}${groupInteger(intDigits)}.${rawFrac}`
    : `${sign}${groupInteger(intDigits)}`;

  // A lone '.', or a trailing '.', is a half-typed number rather than an error.
  if (intDigits === '' && rawFrac === '') {
    return { display, canonical, minor: null, problem: null, incomplete: true };
  }

  // ── The exact conversion. Digit strings only; no multiplication. ──
  const digits = `${intDigits === '' ? '0' : intDigits}${rawFrac.padEnd(exponent, '0')}`;
  const normalized = digits.replace(/^0+(?=\d)/, '');

  // 16 digits is already past 2^53; bail before Number() rounds it for us.
  if (normalized.length > 16) return failure(raw, 'too-large');

  const magnitude = Number(normalized);
  if (!Number.isFinite(magnitude)) return failure(raw, 'too-large');

  try {
    // The final gate. A float or an unsafe integer throws here rather than
    // reaching a column that promised to hold neither.
    const minor = minorUnits(negative ? -magnitude : magnitude);
    return { display, canonical, minor, problem: null, incomplete: false };
  } catch {
    return failure(raw, 'too-large');
  }
}

/* ------------------------------------------------------------------ *
 * Keystroke handling
 * ------------------------------------------------------------------ */

/** True when `next` is `prev` with exactly one character inserted. */
function isSingleInsertion(prev: string, next: string): boolean {
  if (next.length !== prev.length + 1) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (next.slice(0, i) + next.slice(i + 1) === prev) return true;
  }
  return false;
}

/** The index of the single character removed from `prev`, or `-1`. */
function singleDeletionIndex(prev: string, next: string): number {
  if (next.length !== prev.length - 1) return -1;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev.slice(0, i) + prev.slice(i + 1) === next) return i;
  }
  return -1;
}

/**
 * Whether `next` is `prev` with ONE contiguous run of characters removed and
 * nothing added — a selection followed by Delete, or a long-press backspace.
 *
 * `'1,234,567' → '1,2367'` removes `4,5`. Judged as a paste (the only other
 * thing a multi-character change used to be) it read as `ambiguous-separators`
 * and cleared the committed amount; and because `'1,234,567' → '1,567'`
 * happened to survive, it failed intermittently (T15). A deletion cannot
 * introduce an ambiguity the previous draft did not have, so it is typing.
 */
function isContiguousDeletion(prev: string, next: string): boolean {
  if (next.length >= prev.length) return false;
  let prefix = 0;
  while (prefix < next.length && prev[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < next.length - prefix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return prefix + suffix === next.length;
}

function fractionLength(text: string): number {
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Apply one edit from a `TextInput` to the amount draft.
 *
 * Typing and pasting are deliberately NOT the same thing:
 *
 *  - A single keystroke that cannot land — a second `.`, a third decimal digit
 *    — is **ignored**. The field simply does not accept it, the way a numeric
 *    keypad refuses a letter. Nothing is lost, so nothing needs reporting.
 *  - The same shape arriving by PASTE (`'1499.505'`) is **reported**, because
 *    dropping a character out of pasted text would silently change an amount.
 *
 *  - Backspacing over a group separator deletes the digit in front of it, not
 *    the comma, which would otherwise reappear on the next regroup and make
 *    the key look broken.
 */
export function applyAmountEdit(
  previousDisplay: string,
  nextDisplay: string,
  options: AmountInputOptions = {},
): AmountParse {
  const { currency = DEFAULT_CURRENCY } = options;
  const exponent = minorUnitExponent(currency);

  if (nextDisplay === previousDisplay) return parseAmountInput(nextDisplay, options);

  const inserted = isSingleInsertion(previousDisplay, nextDisplay);
  const deleted = singleDeletionIndex(previousDisplay, nextDisplay);
  // One character either way, or any run deleted: the user is editing, not
  // pasting. Only a multi-character INSERTION is judged as pasted text.
  const typed =
    inserted || deleted >= 0 || isContiguousDeletion(previousDisplay, nextDisplay);

  if (inserted) {
    const bare = nextDisplay.replace(/,/g, '');
    // A second decimal point: refuse the keystroke, keep the draft.
    if ((bare.match(/\./g) ?? []).length > 1) return parseAmountInput(previousDisplay, options);
    // One decimal place too many: refuse the keystroke, keep the draft.
    if (fractionLength(bare) > exponent) return parseAmountInput(previousDisplay, options);
  }

  let candidate = nextDisplay;
  if (deleted >= 0 && previousDisplay[deleted] === ',') {
    // Backspace landed on a separator the field inserted, not on anything the
    // user typed. Take the digit in front of it instead, so the key does
    // something rather than appearing to do nothing once the group re-forms.
    candidate = previousDisplay.slice(0, deleted - 1) + previousDisplay.slice(deleted);
  }

  if (typed) {
    // Mid-typing, the groups are OURS, not the user's: `'1,499'` + `'0'` is
    // `'1,4990'`, which is not valid grouping and must not be judged as though
    // the user had pasted it. Drop every separator and let the parser regroup.
    candidate = candidate.replace(/,/g, '');
  }

  return parseAmountInput(candidate, options);
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

/**
 * Minor units back to editable text: `149950` -> `'1,499.50'`.
 *
 * The inverse of `parseAmountInput`, and exact for the same reason — the
 * decimal point is *inserted into* the digit string rather than produced by
 * dividing by 100.
 *
 * Note this is not `formatMoney`: there is no currency symbol, because the
 * symbol is a fixed affix beside the field, not part of what the user edits.
 */
export function formatAmountDraft(minor: MinorUnits, currency: string = DEFAULT_CURRENCY): string {
  const exponent = minorUnitExponent(currency);
  const negative = minor < 0;
  const sign = negative ? '-' : '';
  const digits = String(Math.abs(minor));
  if (exponent === 0) return `${sign}${groupInteger(digits)}`;
  const padded = digits.padStart(exponent + 1, '0');
  const cut = padded.length - exponent;
  return `${sign}${groupInteger(padded.slice(0, cut))}.${padded.slice(cut)}`;
}

/**
 * Finish a half-typed draft on blur: `'1,499.5'` -> `'1,499.50'`, `'.'` -> `''`.
 *
 * Padding a fraction with zeros is exact — it is the one normalisation that
 * cannot change what the user meant. A draft that failed to parse is returned
 * untouched, so a rejected paste stays visible next to its error.
 */
export function settleAmountDraft(parse: AmountParse, options: AmountInputOptions = {}): AmountParse {
  const { currency = DEFAULT_CURRENCY } = options;
  if (parse.problem !== null) return parse;
  if (parse.minor === null) {
    return { display: '', canonical: '', minor: null, problem: null, incomplete: true };
  }
  return { ...parse, display: formatAmountDraft(parse.minor, currency), incomplete: false };
}

/**
 * What to tell the user. Never quotes the amount back at them — an amount is
 * user data, and the text they typed is already on screen anyway.
 */
export function describeAmountProblem(problem: AmountProblem, currency: string = DEFAULT_CURRENCY): string {
  const exponent = minorUnitExponent(currency);
  switch (problem) {
    case 'not-a-number':
      return 'Enter an amount using digits only.';
    case 'ambiguous-separators':
      return 'Use one decimal point, and commas only between thousands.';
    case 'too-precise':
      return exponent === 0
        ? `${currency} amounts have no decimal places.`
        : `${currency} amounts stop at ${exponent} decimal places — nothing is rounded off for you.`;
    case 'too-large':
      return 'That amount is too large to store.';
    case 'negative-not-allowed':
      return 'Enter an amount greater than zero.';
  }
}
