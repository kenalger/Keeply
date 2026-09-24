/**
 * Keeply — keyset ("cursor") paging over the page statements the features
 * already build.
 *
 * ── WHAT WAS WRONG WITH OFFSET ─────────────────────────────────────────────
 * `LIMIT 40 OFFSET 400` is not "rows 401 to 440". It is "walk 440 rows of the
 * index and throw 400 of them away", so page k costs k pages of work, and a
 * list that re-read every page from offset 0 on every scroll paid for the whole
 * triangle: ~31,000 statements across a 10,000-row scroll (`plan/
 * phase2-3-remediation.md` T19). Keyset paging asks the index for "the rows
 * after THIS one" instead, which is a seek: page 250 costs what page 1 costs.
 *
 * ── HOW, WITHOUT A SECOND COPY OF ANY PREDICATE ───────────────────────────
 * Every list statement in this app ends in `ORDER BY <keys> LIMIT ? OFFSET ?`
 * and every one of those ORDER BYs ends in the row id, so the order is total.
 * `continuationStatement()` takes that statement VERBATIM from the feature's
 * `sql.ts`, removes the tail, and wraps it:
 *
 *     SELECT * FROM (<the page statement, minus its tail>) AS "page"
 *     WHERE <keys after the cursor> ORDER BY <the same keys> LIMIT ?
 *
 * The filter, the projection, the `*_live` view and the derived columns are
 * all still built by the ONE function that also builds the page's count and
 * totals — nothing here restates a WHERE clause. SQLite flattens the subquery
 * (the same flattening every `*_live` view already relies on), so the keyset
 * predicate lands on the paging index as a range: `EXPLAIN QUERY PLAN` reads
 * `SEARCH receipts USING INDEX receipts_page_date_idx (purchase_date<?)`, and
 * `tests/query-plans-keyset.test.ts` holds every list to it.
 *
 * The tail has to be REMOVED, not left inside the subquery: SQLite will not
 * flatten a subquery that keeps its own ORDER BY while the outer query has
 * one, nor one that keeps a LIMIT or an OFFSET (restrictions 11, 13 and 14 of
 * "Subquery flattening", sqlite.org/optoverview.html). A builder that grew a
 * DISTINCT or a window function would block it the same way (4, 25) — the
 * plan test is what would notice, as a scan or a temp B-tree.
 *
 * ── THE KEY SPEC IS CHECKED AGAINST THE STATEMENT, EVERY TIME ─────────────
 * A keyset predicate is a restatement of the ORDER BY. If the two ever
 * disagree — a tiebreaker added to `sql.ts` and not here — rows are skipped or
 * repeated at page boundaries, silently, and only for users with enough rows
 * to have a second page. So the spec renders its own ORDER BY and
 * `continuationStatement()` refuses to build unless the page statement ends in
 * exactly that text. Drift is a thrown error in the first test that pages,
 * not a missing receipt on someone's phone.
 *
 * ── NULLS, COLLATION, AND WHY THE SEEK TERM IS REDUNDANT ON PURPOSE ───────
 *  - SQLite puts NULL first ascending and LAST descending. A nullable key is
 *    therefore only accepted in the lifted form the lists already use
 *    (`"x" IS NULL ASC, "x" ASC`), and the predicate compares the bucket
 *    first, then the value with `IS` — `x > NULL` is NULL, and `x IS NULL`
 *    is how a cursor that is itself in the NULL bucket keeps going.
 *  - `COLLATE NOCASE` is repeated on every comparison. It folds ASCII only,
 *    exactly like the index; comparing in JavaScript, or with any other
 *    collation, would order `Émile` differently from the index and lose rows.
 *  - The predicate starts with `lead >= ?` (or `<=`), which the OR-chain
 *    already implies. SQLite cannot derive a range from a disjunction, so
 *    without it the plan is still "no temp B-tree" — and still walks the index
 *    from the top, which is OFFSET again by another name.
 *
 * ── THE CURSOR TOKEN ───────────────────────────────────────────────────────
 * An opaque string, minted by a data layer from the LAST ROW IT READ — raw,
 * before mapping, so a damaged row that the list skipped still moves the
 * cursor past itself. It carries:
 *
 *  - the list and sort it belongs to (a cursor from another order is refused),
 *  - the key values (SQLite scalars, with their types — `'12'` and `12` do not
 *    sort alike),
 *  - how many rows precede it, the `count(*)` the first page took, and the
 *    calendar day that first page was read against.
 *
 * The count rides along because the whole point is not to re-run it: with a
 * search, `count(*)` is a full-table GLOB scan, and the old code ran one per
 * page. The day rides along so one list is read against one "today" — a bills
 * list scrolled across midnight must not label half its rows by yesterday.
 *
 * THE TOKEN CONTAINS ROW VALUES — a merchant name, an amount. It lives in
 * memory, is handed straight back to the data layer, and is never logged,
 * persisted or put in an error message. Nothing in this file does any of those.
 *
 * ── WHEN A ROW CANNOT BE A CURSOR ──────────────────────────────────────────
 * A key that is not an exact SQLite scalar — a BLOB, an integer past 2^53 that
 * JavaScript has already rounded, a NULL in a column the order assumes is never
 * NULL — cannot be bound back and compared honestly. Those only exist in a
 * damaged database, and the damaged-row policy (a list skips and counts; it
 * never blanks) applies: the token falls back to "skip `seen` rows", the old
 * OFFSET, which is slower and exactly right. Correctness never depends on data
 * being clean; speed does.
 *
 * Pure: no imports, no I/O. Loaded by `node --test` as-is.
 */

/** What a key can hold and be bound back as. The features' own `SqlValue`. */
export type KeyValue = string | number | null;

/** Structurally every feature's `SqlStatement`. */
export interface KeysetStatement {
  readonly text: string;
  readonly params: readonly KeyValue[];
}

export type KeysetDirection = 'asc' | 'desc';

export interface KeysetKey {
  /** The result column, as the page statement projects it (`"purchase_date"`). */
  readonly column: string;
  readonly direction: KeysetDirection;
  /** The collation the paging index was built with. Only NOCASE is used. */
  readonly collate?: 'nocase';
  /**
   * The column may be NULL, and the list lifts NULLs past every value
   * (`"x" IS NULL ASC, "x" <dir>`). The only form a nullable key is accepted
   * in — see the header.
   */
  readonly nullsLast?: boolean;
}

export interface KeysetSpec {
  /** `'receipts:purchase-date'` — the list and the order a cursor belongs to. */
  readonly tag: string;
  /** How the page statement qualifies its ORDER BY: `'"r".'`, or `''`. */
  readonly qualifier: string;
  /** In ORDER BY order. The last one is the row id, which makes it total. */
  readonly keys: readonly KeysetKey[];
}

/** A decoded cursor: where a list stopped, and what the first page learned. */
export interface KeysetCursor {
  /** One value per key, or `null` when the row could not be a cursor. */
  readonly keys: readonly KeyValue[] | null;
  /** Rows (mapped or damaged) before the cursor. The OFFSET fallback. */
  readonly seen: number;
  /** The `count(*)` the first page of this list took. */
  readonly total: number;
  /** The calendar day the first page was read against, when it used one. */
  readonly todayISO: string | null;
}

/** Position facts a data layer records into a cursor it mints. */
export interface CursorPosition {
  readonly seen: number;
  readonly total: number;
  readonly todayISO?: string | null;
}

/**
 * A cursor that cannot be used. Always a bug — tokens are minted by the data
 * layer and handed straight back — so this is thrown, not reported.
 *
 * The message names the problem and never the token: the token holds row
 * values (see the header).
 */
export class KeysetCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeysetCursorError';
  }
}

/* -------------------------------------------------------------------------- */
/* Specs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Declare one list order. Checked once, at module load, so a malformed spec
 * fails the first test that imports its feature rather than a scroll.
 *
 * @throws {Error} if the spec has no keys, or does not end in the row id — an
 *         order that is not total cannot be paged without losing rows.
 */
export function defineKeyset(spec: KeysetSpec): KeysetSpec {
  const last = spec.keys.at(-1);
  if (spec.tag.length === 0 || last === undefined) {
    throw new Error('A keyset needs a tag and at least one key');
  }
  if (last.column !== 'id' || last.nullsLast === true || last.collate !== undefined) {
    throw new Error(`Keyset ${spec.tag} must end in the row id`);
  }
  return Object.freeze({ ...spec, keys: Object.freeze([...spec.keys]) });
}

/** One ORDER BY term as SQL has it, plus what the predicate needs. */
interface Term {
  /** As the ORDER BY writes it: `"r"."expiry_date" IS NULL ASC`. */
  readonly order: string;
  /** As a comparison operand: `("r"."expiry_date" IS NULL)`. */
  readonly operand: string;
  readonly direction: KeysetDirection;
  /** Compared with `IS` rather than `=`: this term can hold NULL. */
  readonly nullable: boolean;
  /** Which key's value this term compares, and how. */
  readonly source: { readonly index: number; readonly bucket: boolean };
}

function termsOf(spec: KeysetSpec, qualifier: string): Term[] {
  const terms: Term[] = [];
  spec.keys.forEach((key, index) => {
    const column = `${qualifier}"${key.column}"`;
    const collated = key.collate === 'nocase' ? `${column} COLLATE NOCASE` : column;
    const direction = key.direction === 'asc' ? 'ASC' : 'DESC';
    if (key.nullsLast === true) {
      // Operator precedence: `x IS NULL > ?` parses as `x IS (NULL > ?)`, so
      // the bucket is parenthesised as an operand — and parenthesised it is
      // still the expression the paging index was built on.
      terms.push({
        order: `${column} IS NULL ASC`,
        operand: `(${column} IS NULL)`,
        direction: 'asc',
        nullable: false,
        source: { index, bucket: true },
      });
    }
    terms.push({
      order: `${collated} ${direction}`,
      operand: collated,
      direction: key.direction,
      nullable: key.nullsLast === true,
      source: { index, bucket: false },
    });
  });
  return terms;
}

/**
 * The ORDER BY this spec means, spelled exactly as `sql.ts` spells it.
 *
 * Exported so a test can hold every builder to its spec without paging.
 */
export function orderByClause(spec: KeysetSpec, qualifier: string = spec.qualifier): string {
  return ` ORDER BY ${termsOf(spec, qualifier)
    .map((term) => term.order)
    .join(', ')}`;
}

/* -------------------------------------------------------------------------- */
/* The token                                                                   */
/* -------------------------------------------------------------------------- */

/** JSON has no Infinity; SQLite REAL does. Tagged, so it survives the trip. */
type EncodedValue = string | number | null | { readonly inf: 1 | -1 };

interface EncodedCursor {
  readonly t: string;
  readonly k: readonly EncodedValue[] | null;
  readonly s: number;
  readonly n: number;
  readonly d: string | null;
}

/**
 * The key values of one raw row, or `null` when any of them cannot be bound
 * back exactly (see "WHEN A ROW CANNOT BE A CURSOR").
 *
 * @throws {Error} if a key column is absent from the row altogether. That is
 *         not damaged data — every value SQLite returns is at least NULL — it
 *         is a spec naming a column the statement does not project.
 */
function keyValuesOf(spec: KeysetSpec, row: object): KeyValue[] | null {
  const values: KeyValue[] = [];
  for (const key of spec.keys) {
    const value: unknown = (row as Readonly<Record<string, unknown>>)[key.column];
    if (value === undefined) {
      throw new Error(`Keyset ${spec.tag}: the page does not project "${key.column}"`);
    }
    if (value === null) {
      if (key.nullsLast !== true) return null;
      values.push(null);
    } else if (typeof value === 'string') {
      values.push(value);
    } else if (typeof value === 'number') {
      // NaN is not a SQLite value, and an integer past 2^53 has already been
      // rounded by the driver: binding it back would name a different row.
      if (Number.isNaN(value)) return null;
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null;
      values.push(value);
    } else {
      // A BLOB, a bigint, a boolean: not bindable through the store seam.
      return null;
    }
  }
  return values;
}

function encodeValue(value: KeyValue): EncodedValue {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { inf: value > 0 ? 1 : -1 };
  }
  return value;
}

const INVALID = Symbol('invalid');

function decodeValue(value: unknown): KeyValue | typeof INVALID {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
  if (typeof value === 'object' && value !== null && 'inf' in value) {
    const sign = (value as { inf: unknown }).inf;
    if (sign === 1) return Number.POSITIVE_INFINITY;
    if (sign === -1) return Number.NEGATIVE_INFINITY;
  }
  return INVALID;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Mint the cursor that continues after `row` — the LAST row a page read, raw.
 *
 * @throws {Error} if `position` is not a pair of non-negative integers; a data
 *         layer computing a negative `seen` has a bug worth a stack trace.
 */
export function cursorAfter(spec: KeysetSpec, row: object, position: CursorPosition): string {
  if (!isCount(position.seen) || !isCount(position.total)) {
    throw new Error(`Keyset ${spec.tag}: a cursor position must be two counts`);
  }
  const keys = keyValuesOf(spec, row);
  const encoded: EncodedCursor = {
    t: spec.tag,
    k: keys === null ? null : keys.map(encodeValue),
    s: position.seen,
    n: position.total,
    d: position.todayISO ?? null,
  };
  return JSON.stringify(encoded);
}

/**
 * The cursor that continues a page, or `null` when the page read nothing —
 * there is no row to continue after.
 */
export function nextCursor(
  spec: KeysetSpec,
  rows: readonly object[],
  position: CursorPosition,
): string | null {
  const last = rows.at(-1);
  return last === undefined ? null : cursorAfter(spec, last, position);
}

/**
 * Decode a token minted by {@link cursorAfter} for this same list and order.
 *
 * @throws {KeysetCursorError} if the token is not one, or belongs to a
 *         different list or sort. Never names the token's contents.
 */
export function readCursor(spec: KeysetSpec, token: string): KeysetCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    throw new KeysetCursorError('Not a list cursor');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new KeysetCursorError('Not a list cursor');
  }
  const candidate = parsed as Partial<Record<keyof EncodedCursor, unknown>>;
  if (candidate.t !== spec.tag) {
    throw new KeysetCursorError('This cursor belongs to a different list or sort order');
  }
  if (!isCount(candidate.s) || !isCount(candidate.n)) {
    throw new KeysetCursorError('A list cursor lost its position');
  }
  if (candidate.d !== null && typeof candidate.d !== 'string') {
    throw new KeysetCursorError('A list cursor lost its calendar day');
  }

  let keys: KeyValue[] | null = null;
  if (candidate.k !== null) {
    if (!Array.isArray(candidate.k) || candidate.k.length !== spec.keys.length) {
      throw new KeysetCursorError('A list cursor does not match its sort order');
    }
    keys = [];
    for (let index = 0; index < spec.keys.length; index += 1) {
      const value = decodeValue(candidate.k[index]);
      if (value === INVALID || (value === null && spec.keys[index].nullsLast !== true)) {
        throw new KeysetCursorError('A list cursor holds a value its sort order cannot');
      }
      keys.push(value);
    }
  }

  return { keys, seen: candidate.s, total: candidate.n, todayISO: candidate.d ?? null };
}

/* -------------------------------------------------------------------------- */
/* The continuation statement                                                  */
/* -------------------------------------------------------------------------- */

/** The alias the wrapped page is given. No feature statement uses it. */
const PAGE = '"page".';
const TAIL = ' LIMIT ? OFFSET ?';

/** `(a > ? OR (a = ? AND (b > ? OR (b = ? AND c > ?))))`, built back to front. */
function afterCursor(terms: readonly Term[], values: readonly KeyValue[]) {
  let text = '';
  let params: KeyValue[] = [];
  for (let index = terms.length - 1; index >= 0; index -= 1) {
    const term = terms[index];
    const value = values[index];
    const beyond = `${term.operand} ${term.direction === 'asc' ? '>' : '<'} ?`;
    if (index === terms.length - 1) {
      text = beyond;
      params = [value];
    } else {
      const same = `${term.operand} ${term.nullable ? 'IS' : '='} ?`;
      text = `(${beyond} OR (${same} AND ${text}))`;
      params = [value, value, ...params];
    }
  }
  return { text, params };
}

/**
 * The page after `cursor`, built from the page statement the feature already
 * has. Reads `limit + 1` rows: the extra one is how {@link splitPeek} knows
 * whether anything follows, without a `count(*)`.
 *
 * @param page   The feature's own page statement — `selectReceipts(filter)` —
 *               whose last two parameters are its LIMIT and OFFSET.
 * @throws {Error} if `page` does not end in exactly this spec's ORDER BY and
 *         `LIMIT ? OFFSET ?`. See the header: that is a spec that has drifted
 *         from its statement, and paging it would lose rows.
 */
export function continuationStatement(
  page: KeysetStatement,
  spec: KeysetSpec,
  cursor: KeysetCursor,
  limit: number,
): KeysetStatement {
  const tail = `${orderByClause(spec)}${TAIL}`;
  if (!page.text.endsWith(tail) || page.params.length < 2) {
    throw new Error(`Keyset ${spec.tag} no longer matches the ORDER BY of its page`);
  }
  const peek = limit + 1;
  const inner = page.params.slice(0, -2);

  const keys = cursor.keys;
  if (keys === null) {
    // The damaged-row fallback: the page's own statement, skipping what was
    // already read. See "WHEN A ROW CANNOT BE A CURSOR".
    return { text: page.text, params: [...inner, peek, cursor.seen] };
  }

  const terms = termsOf(spec, PAGE);
  const values = terms.map((term) => {
    const value = keys[term.source.index];
    return term.source.bucket ? (value === null ? 1 : 0) : value;
  });
  const lead = terms[0];
  const seek = `${lead.operand} ${lead.direction === 'asc' ? '>=' : '<='} ?`;
  const rest = afterCursor(terms, values);

  return {
    text:
      `SELECT * FROM (${page.text.slice(0, -tail.length)}) AS "page"` +
      ` WHERE ${seek} AND ${rest.text}${orderByClause(spec, PAGE)} LIMIT ?`,
    params: [...inner, values[0], ...rest.params, peek],
  };
}

/** A peeked read, split into the page and whether a row followed it. */
export function splitPeek<Row>(
  rows: readonly Row[],
  limit: number,
): { page: readonly Row[]; hasMore: boolean } {
  return rows.length > limit
    ? { page: rows.slice(0, limit), hasMore: true }
    : { page: rows, hasMore: false };
}
