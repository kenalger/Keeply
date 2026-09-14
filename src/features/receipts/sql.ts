/**
 * Keeply — every SQL statement the receipts feature issues.
 *
 * Pure: builders in, `{ text, params }` out, nothing executed. That is what
 * lets `node --test` run the real statements against the real migrations
 * (`tests/receipts-*.test.ts`) with no native module in sight.
 *
 * ---------------------------------------------------------------------------
 * READS COME FROM THE VIEW, WRITES GO TO THE TABLE
 * ---------------------------------------------------------------------------
 * `RECEIPTS_LIVE_VIEW` is the only relation a SELECT here names. `receipts_live`
 * applies `deleted_at IS NULL`, so a tombstone cannot reappear in a list, in a
 * total, or — the reason this matters more for receipts than for anything else
 * — in a screen that would then try to render the deleted row's image.
 *
 * Writes target the base table because a view is not writable.
 *
 * ---------------------------------------------------------------------------
 * ONE WHERE CLAUSE, FOUR STATEMENTS
 * ---------------------------------------------------------------------------
 * `buildFilterClause()` is shared by the page, its `count(*)`, and BOTH totals
 * queries. "₱12,480 across 31 receipts" under a filtered list is therefore the
 * total of exactly the rows that list is paging through, not of a predicate
 * that was written twice and drifted once.
 *
 * ---------------------------------------------------------------------------
 * AGGREGATION IS SQLITE'S JOB
 * ---------------------------------------------------------------------------
 * `selectReceiptTotalsByCurrency`, `selectReceiptTotalsByCategory` and
 * `selectReceiptCounts` return finished sums and counts. `queries.ts` maps
 * them and does not add anything up; a list of ten thousand receipts is never
 * pulled into JavaScript to be reduced.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE ASKS SQLITE WHAT DAY IT IS
 * ---------------------------------------------------------------------------
 * SQLite's `date('now')` is UTC and flips a day early in PH time, so it appears
 * nowhere in this file. Every date is a bound parameter carrying a calendar day
 * the DEVICE decided on. `tests/receipts-queries.test.ts` greps every statement
 * for it.
 *
 * ---------------------------------------------------------------------------
 * THE URI COLUMNS ARE PROJECTED, NEVER PREDICATED ON
 * ---------------------------------------------------------------------------
 * `local_image_uri` and `local_thumbnail_uri` appear in SELECT lists and in the
 * INSERT/UPDATE parameter lists. They appear in no `WHERE` that compares them
 * to user input — the only predicate over them is `IS NULL` / `IS NOT NULL`,
 * which reveals nothing. A search box able to match a filesystem path is a way
 * to probe for one, and §10 says the paths are sensitive.
 *
 * Every value that came from a user is a bound `?` parameter. The only
 * interpolated text is column and relation names from the constants below.
 */
import { globContains } from '@/lib/search';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ReceiptCategory,
  type ReceiptFilter,
  type ReceiptSort,
  type ReceiptTotalsOptions,
} from './types';

import type { SqlStatement, SqlValue } from './store';

/* -------------------------------------------------------------------------- */
/* Relations                                                                   */
/* -------------------------------------------------------------------------- */

/** The ONLY relation a read in this feature names. `deleted_at IS NULL` (§A8). */
export const RECEIPTS_LIVE_VIEW = 'receipts_live';
/** Writes only — a view is not writable. */
export const RECEIPTS_TABLE = 'receipts';

/** The alias every statement uses, so the column references read the same. */
const R = 'r';

/** Stored columns, in schema order. The projection of every full read. */
const RECEIPT_STORED_COLUMNS = [
  'id',
  'merchant',
  'amount_minor',
  'currency',
  'category',
  'purchase_date',
  'payment_method',
  'notes',
  'local_image_uri',
  'local_thumbnail_uri',
  'created_at',
  'updated_at',
] as const;

const RECEIPT_SELECT_COLUMNS = RECEIPT_STORED_COLUMNS.map(
  (column) => `"${R}"."${column}"`,
).join(', ');

/**
 * The projection the DELETE path uses: the id, and the two things the caller
 * has to unlink. Nothing else.
 *
 * Deliberately narrow. A delete needs one fact — that the id is live — plus the
 * URIs it is about to strand, and reading `amount_minor` or `purchase_date` to
 * get them would put the corrupt columns back in the path of the one operation
 * that must never fail. See `existsById`'s argument in
 * `src/features/bills/queries.ts`; this is the same escape hatch with a payload.
 */
const RECEIPT_IMAGE_COLUMNS = [
  `"${R}"."id"`,
  `"${R}"."local_image_uri"`,
  `"${R}"."local_thumbnail_uri"`,
].join(', ');

/* -------------------------------------------------------------------------- */
/* Row shapes as SQLite returns them                                           */
/* -------------------------------------------------------------------------- */

/** Snake-cased, SQLite-typed. Mapped to `ReceiptRecord` in `queries.ts`. */
export interface ReceiptRow {
  id: unknown;
  merchant: unknown;
  amount_minor: unknown;
  currency: unknown;
  category: unknown;
  purchase_date: unknown;
  payment_method: unknown;
  notes: unknown;
  local_image_uri: unknown;
  local_thumbnail_uri: unknown;
  created_at: unknown;
  updated_at: unknown;
}

/** What `selectReceiptImagesById()` returns. Never mapped through `corrupt()`. */
export interface ReceiptImageRow {
  id: unknown;
  local_image_uri: unknown;
  local_thumbnail_uri: unknown;
}

export interface CountRow {
  n: unknown;
}

export interface ReceiptCurrencyTotalRow {
  currency: unknown;
  receipt_count: unknown;
  total_minor: unknown;
}

export interface ReceiptCategoryTotalRow {
  currency: unknown;
  category: unknown;
  receipt_count: unknown;
  total_minor: unknown;
}

export interface ReceiptCountsRow {
  receipt_count: unknown;
  without_image_count: unknown;
  damaged_count: unknown;
}

/* -------------------------------------------------------------------------- */
/* Filtering (§23)                                                             */
/* -------------------------------------------------------------------------- */

interface WhereClause {
  text: string;
  params: SqlValue[];
}

function normalizeCategories(category: ReceiptFilter['category']): ReceiptCategory[] {
  if (category === undefined) return [];
  return Array.isArray(category) ? [...category] : [category as ReceiptCategory];
}

/**
 * The shared WHERE of the page, its COUNT and both totals, so the four can
 * never disagree.
 *
 * A bound that is not a finite number is IGNORED rather than bound as NULL:
 * `amount_minor >= NULL` is NULL, which SQLite treats as false, and a filter
 * silently matching nothing is the worst of the three possible behaviours.
 * `validateReceiptFilter()` is what tells the caller their range was nonsense.
 */
export function buildFilterClause(filter: ReceiptFilter = {}): WhereClause {
  const conditions: string[] = [];
  const params: SqlValue[] = [];

  const categories = normalizeCategories(filter.category);
  if (categories.length > 0) {
    conditions.push(`"${R}"."category" IN (${categories.map(() => '?').join(', ')})`);
    params.push(...categories);
  }

  if (typeof filter.currency === 'string' && filter.currency.length > 0) {
    conditions.push(`"${R}"."currency" = ?`);
    params.push(filter.currency);
  }

  if (typeof filter.fromISO === 'string' && filter.fromISO.length > 0) {
    conditions.push(`"${R}"."purchase_date" >= ?`);
    params.push(filter.fromISO);
  }
  if (typeof filter.toISO === 'string' && filter.toISO.length > 0) {
    conditions.push(`"${R}"."purchase_date" <= ?`);
    params.push(filter.toISO);
  }

  if (Number.isFinite(filter.minAmountMinor)) {
    conditions.push(`"${R}"."amount_minor" >= ?`);
    params.push(filter.minAmountMinor as number);
  }
  if (Number.isFinite(filter.maxAmountMinor)) {
    conditions.push(`"${R}"."amount_minor" <= ?`);
    params.push(filter.maxAmountMinor as number);
  }

  // `IS NULL` reveals nothing about the path itself. See the file header for
  // why that is the only predicate this module ever puts on a URI column.
  if (typeof filter.hasImage === 'boolean') {
    conditions.push(
      filter.hasImage
        ? `"${R}"."local_image_uri" IS NOT NULL`
        : `"${R}"."local_image_uri" IS NULL`,
    );
  }

  const search = typeof filter.search === 'string' ? filter.search.trim() : '';
  if (search.length > 0) {
    // GLOB, not LIKE: LIKE folds case for ASCII only, so `MUÑOZ` never matched
    // `muñoz`. `globContains()` folds the needle in JavaScript — which knows
    // Unicode — and emits a character class per letter. Same scan, same plan.
    const pattern = globContains(search) ?? '*';
    conditions.push(
      `("${R}"."merchant" GLOB ?` +
        ` OR coalesce("${R}"."payment_method", '') GLOB ?` +
        ` OR coalesce("${R}"."notes", '') GLOB ?)`,
    );
    params.push(pattern, pattern, pattern);
  }

  return {
    text: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/** A totals request is a filter with the pagination taken off. */
function totalsFilter(options: ReceiptTotalsOptions = {}): ReceiptFilter {
  return options;
}

/**
 * "This row's amount is actually an integer."
 *
 * SQLite's declared types are affinities, not guarantees: `amount_minor = 1234.5`
 * passes `CHECK (amount_minor > 0)` and is stored as a REAL. One such row poisons
 * `sum()` — the total comes back a float, and a float number of centavos is not
 * a number this app can show anyone.
 *
 * A LIST answers that by skipping the row and counting it (`ReceiptPage`). The
 * totals answer it the same way, in SQL: the sums are taken over readable rows
 * only, and `selectReceiptCounts()` reports how many were left out. A total that
 * quietly omits a receipt is worse than one that says it did — and a total that
 * refuses to render at all because of one bad row is worse than both.
 */
const READABLE_AMOUNT_SQL = `typeof("${R}"."amount_minor") = 'integer'`;

/** `where` with one more condition AND-ed on. */
function and(where: WhereClause, condition: string): WhereClause {
  return {
    text: where.text === '' ? ` WHERE ${condition}` : `${where.text} AND ${condition}`,
    params: where.params,
  };
}

/**
 * Ordering always ends in `"id"`, so a row can never appear on two pages or on
 * none: SQLite is free to return ties in any order, and an unstable sort makes
 * `LIMIT/OFFSET` pagination silently lossy.
 *
 * `'purchase-date'` DESCENDS. A receipt journal is a history read newest-first;
 * `created_at` breaks the tie so five receipts entered from one shoebox on one
 * afternoon come back in the order they were entered, not arbitrarily.
 */
function orderBy(sort: ReceiptSort = 'purchase-date'): string {
  switch (sort) {
    case 'merchant':
      return ` ORDER BY "${R}"."merchant" COLLATE NOCASE ASC, "${R}"."id" ASC`;
    case 'amount':
      return (
        ` ORDER BY "${R}"."amount_minor" DESC, "${R}"."purchase_date" DESC,` +
        ` "${R}"."id" ASC`
      );
    case 'purchase-date':
      return (
        ` ORDER BY "${R}"."purchase_date" DESC, "${R}"."created_at" DESC,` +
        ` "${R}"."id" ASC`
      );
    default: {
      const unhandled: never = sort;
      throw new Error(`Unknown receipt sort: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The page size actually applied: never unbounded, never zero or negative. */
export function resolvePageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

export function resolveOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** One page. Always `LIMIT`ed — §33 forbids an unbounded read on a device. */
export function selectReceipts(filter: ReceiptFilter = {}): SqlStatement {
  const where = buildFilterClause(filter);
  return {
    text:
      `SELECT ${RECEIPT_SELECT_COLUMNS} FROM "${RECEIPTS_LIVE_VIEW}" "${R}"` +
      `${where.text}${orderBy(filter.sort)} LIMIT ? OFFSET ?`,
    params: [
      ...where.params,
      resolvePageSize(filter.limit),
      resolveOffset(filter.offset),
    ],
  };
}

/**
 * `count(*)` over the same WHERE — the total is counted in SQL, not by taking
 * `rows.length` of a page.
 */
export function countReceipts(filter: ReceiptFilter = {}): SqlStatement {
  const where = buildFilterClause(filter);
  return {
    text: `SELECT count(*) AS "n" FROM "${RECEIPTS_LIVE_VIEW}" "${R}"${where.text}`,
    params: where.params,
  };
}

export function selectReceiptById(id: string): SqlStatement {
  return {
    text:
      `SELECT ${RECEIPT_SELECT_COLUMNS} FROM "${RECEIPTS_LIVE_VIEW}" "${R}"` +
      ` WHERE "${R}"."id" = ? LIMIT 1`,
    params: [id],
  };
}

/**
 * The id and the two image URIs of one live receipt — the delete path's read.
 *
 * See `RECEIPT_IMAGE_COLUMNS`: this exists so a soft delete never has to touch
 * a column that could be corrupt, and so the caller learns which files the
 * delete just stranded in the same breath that tells it the delete happened.
 */
export function selectReceiptImagesById(id: string): SqlStatement {
  return {
    text:
      `SELECT ${RECEIPT_IMAGE_COLUMNS} FROM "${RECEIPTS_LIVE_VIEW}" "${R}"` +
      ` WHERE "${R}"."id" = ? LIMIT 1`,
    params: [id],
  };
}

/** §5's "Recent Activity": the newest receipts, capped by the caller. */
export function selectRecentReceipts(limit: number): SqlStatement {
  return {
    text:
      `SELECT ${RECEIPT_SELECT_COLUMNS} FROM "${RECEIPTS_LIVE_VIEW}" "${R}"` +
      `${orderBy('purchase-date')} LIMIT ?`,
    params: [limit],
  };
}

/* -------------------------------------------------------------------------- */
/* Reads — totals, aggregated by SQLite                                        */
/* -------------------------------------------------------------------------- */

/**
 * Money spent, grouped by currency, over the filtered set.
 *
 * `amount_minor` is NOT NULL on this table, so — unlike a bill's expected
 * amount — there is no "unknown" bucket to exclude. The one exclusion is
 * `READABLE_AMOUNT_SQL`; see its comment.
 */
export function selectReceiptTotalsByCurrency(
  options: ReceiptTotalsOptions = {},
): SqlStatement {
  const where = and(buildFilterClause(totalsFilter(options)), READABLE_AMOUNT_SQL);
  return {
    text:
      `SELECT "${R}"."currency" AS "currency", count(*) AS "receipt_count",` +
      ` sum("${R}"."amount_minor") AS "total_minor"` +
      ` FROM "${RECEIPTS_LIVE_VIEW}" "${R}"${where.text}` +
      ` GROUP BY "${R}"."currency"` +
      ` ORDER BY "total_minor" DESC, "currency" ASC`,
    params: where.params,
  };
}

/**
 * The same money, grouped by category WITHIN currency (§5's spending breakdown).
 *
 * Currency leads the grouping because a category total that mixed ₱ and $ would
 * be a number with no unit. A category with no matching receipt is simply
 * absent — the UI decides whether to render a zero row, and this does not
 * invent one.
 */
export function selectReceiptTotalsByCategory(
  options: ReceiptTotalsOptions = {},
): SqlStatement {
  const where = and(buildFilterClause(totalsFilter(options)), READABLE_AMOUNT_SQL);
  return {
    text:
      `SELECT "${R}"."currency" AS "currency", "${R}"."category" AS "category",` +
      ` count(*) AS "receipt_count", sum("${R}"."amount_minor") AS "total_minor"` +
      ` FROM "${RECEIPTS_LIVE_VIEW}" "${R}"${where.text}` +
      ` GROUP BY "${R}"."currency", "${R}"."category"` +
      ` ORDER BY "currency" ASC, "total_minor" DESC, "category" ASC`,
    params: where.params,
  };
}

/**
 * The counts that span every currency, in one pass.
 *
 * Its reason for existing: `ReceiptTotals.receiptCount` must NOT be the sum of
 * `byCurrency[].receiptCount` computed in JavaScript. That would be an
 * aggregate assembled outside SQLite, which is the thing this data layer does
 * not do — and it would quietly break the day a currency row is filtered out,
 * or the day a damaged row is dropped from the sums.
 *
 * `receipt_count` counts EVERY matching row; `damaged_count` says how many of
 * them the sums had to leave out. The two together are what lets a screen say
 * "₱12,480 across 30 of 31 receipts" instead of showing a wrong number or no
 * number at all.
 */
export function selectReceiptCounts(options: ReceiptTotalsOptions = {}): SqlStatement {
  const where = buildFilterClause(totalsFilter(options));
  return {
    text:
      `SELECT count(*) AS "receipt_count",` +
      ` sum(CASE WHEN "${R}"."local_image_uri" IS NULL THEN 1 ELSE 0 END)` +
      ` AS "without_image_count",` +
      ` sum(CASE WHEN ${READABLE_AMOUNT_SQL} THEN 0 ELSE 1 END) AS "damaged_count"` +
      ` FROM "${RECEIPTS_LIVE_VIEW}" "${R}"${where.text}`,
    params: where.params,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes — base table, because a view is not writable                         */
/* -------------------------------------------------------------------------- */

export interface InsertReceiptValues {
  id: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  category: string;
  purchaseDate: string;
  paymentMethod: string | null;
  notes: string | null;
  localImageUri: string | null;
  localThumbnailUri: string | null;
  nowMs: number;
}

export function insertReceipt(values: InsertReceiptValues): SqlStatement {
  return {
    text:
      `INSERT INTO "${RECEIPTS_TABLE}"` +
      ` ("id", "merchant", "amount_minor", "currency", "category", "purchase_date",` +
      ` "payment_method", "notes", "local_image_uri", "local_thumbnail_uri",` +
      ` "created_at", "updated_at", "deleted_at")` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      values.id,
      values.merchant,
      values.amountMinor,
      values.currency,
      values.category,
      values.purchaseDate,
      values.paymentMethod,
      values.notes,
      values.localImageUri,
      values.localThumbnailUri,
      values.nowMs,
      values.nowMs,
    ],
  };
}

/** Column name per patchable field. The only place the mapping is written. */
const RECEIPT_COLUMN_FOR_FIELD = {
  merchant: 'merchant',
  amountMinor: 'amount_minor',
  currency: 'currency',
  category: 'category',
  purchaseDate: 'purchase_date',
  paymentMethod: 'payment_method',
  notes: 'notes',
  localImageUri: 'local_image_uri',
  localThumbnailUri: 'local_thumbnail_uri',
} as const;

export type PatchableReceiptField = keyof typeof RECEIPT_COLUMN_FOR_FIELD;

/**
 * `UPDATE ... SET <changed>, updated_at = ? WHERE id = ? AND deleted_at IS NULL`.
 *
 * `updated_at` is set on EVERY mutation, by this builder, so no caller can
 * forget it — a future sync queue diffs on it (§21). The `deleted_at IS NULL`
 * guard means an edit can never resurrect a tombstone, which for a receipt also
 * means an edit can never re-point a deleted row at a file the delete's caller
 * has already unlinked.
 *
 * @throws {Error} if `assignments` is empty. An UPDATE with no SET list is not
 *         valid SQL, and reaching here with nothing to write means a validation
 *         layer let an empty patch through — a bug worth a stack trace, not a
 *         silent no-op write of `updated_at`.
 */
export function updateReceipt(
  id: string,
  assignments: ReadonlyMap<PatchableReceiptField, SqlValue>,
  nowMs: number,
): SqlStatement {
  if (assignments.size === 0) {
    throw new Error('updateReceipt called with no assignments');
  }
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [field, value] of assignments) {
    sets.push(`"${RECEIPT_COLUMN_FOR_FIELD[field]}" = ?`);
    params.push(value);
  }
  sets.push('"updated_at" = ?');
  params.push(nowMs, id);
  return {
    text:
      `UPDATE "${RECEIPTS_TABLE}" SET ${sets.join(', ')}` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params,
  };
}

/**
 * Soft delete. Never `DELETE FROM` — the tombstone is the point (§21), and for
 * receipts it is more than that.
 *
 * The tombstone KEEPS `local_image_uri`. That is what makes the file/row
 * ordering in `queries.ts` recoverable rather than merely lucky: if the app
 * dies between the commit and the unlink, the stranded bytes are still named by
 * a row, so a future sweep can find them exactly instead of scanning a
 * directory and guessing which files are unreferenced.
 */
export function softDeleteReceipt(id: string, nowMs: number): SqlStatement {
  return {
    text:
      `UPDATE "${RECEIPTS_TABLE}" SET "deleted_at" = ?, "updated_at" = ?` +
      ` WHERE "id" = ? AND "deleted_at" IS NULL`,
    params: [nowMs, nowMs, id],
  };
}
