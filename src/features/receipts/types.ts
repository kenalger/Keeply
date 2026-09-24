/**
 * Keeply — the receipt data layer's vocabulary (§9, §10, §23, §29, §30).
 *
 * Pure types plus the small runtime tables (`RECEIPT_CATEGORIES`, page-size
 * limits) the query and validation layers share. Nothing here imports `@/db` at
 * runtime: the barrel loads op-sqlite, and every module a `node --test` suite
 * has to import must load in plain Node.
 *
 * Money is `MinorUnits` from `@/db/money` — integer centavos, branded, so a
 * major-unit `number` cannot be assigned into an amount field (§30).
 * `purchaseDate` is a `'YYYY-MM-DD'` calendar string; `createdAt` / `updatedAt`
 * are epoch millis. The two are never derived from each other.
 *
 * ---------------------------------------------------------------------------
 * WHAT A RECEIPT IS THAT A BILL IS NOT
 * ---------------------------------------------------------------------------
 * 1. IT IS A FACT, NOT A SCHEDULE. There is no cycle, no roll-forward, no
 *    status and no anchor. A receipt happened, on one day, for one amount. That
 *    is why `amountMinor` is NOT nullable here and is nullable on a bill: a
 *    bill's expected charge may be unknown, but a receipt with no amount is not
 *    a receipt.
 * 2. IT OWNS A FILE. `localImageUri` and `localThumbnailUri` point at bytes in
 *    the app sandbox that SQLite knows nothing about. See `queries.ts` for the
 *    ordering contract that keeps the row and the file from outliving each
 *    other, and {@link DeletedReceipt} for what a caller gets back to honour it.
 * 3. ITS URIs ARE SENSITIVE (§10, §19). A receipt image carries names,
 *    addresses, card digits. The path to it must never reach a log, an error
 *    message or an analytics payload — {@link ReceiptError.message} names the
 *    FIELD and never the value, and no statement in `sql.ts` searches a URI
 *    column, so a search term can never be used to probe the filesystem.
 */
import type { MinorUnits } from '@/db/money';

import type { schema } from '@/db';

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

/** The §9 category set, re-exported from the schema enum, type-only. */
export type ReceiptCategory = schema.ReceiptCategory;

/**
 * The categories as a runtime list, for validating data that arrives as a plain
 * string (a form that has not been type-checked, a future restore).
 *
 * `satisfies` proves every member is a real category; `AllCategoriesListed`
 * below proves none is missing — adding one to `RECEIPT_CATEGORY_VALUES`
 * without adding it here is a compile error, not a validation gap. The literal
 * is duplicated rather than imported because `@/db/schema/*` is off limits
 * outside `src/db` (eslint `SCHEMA_IMPORT_MESSAGE`), and the type check is what
 * makes the duplication safe. Same trade as `BILL_CATEGORIES`.
 */
export const RECEIPT_CATEGORIES = [
  'food',
  'grocery',
  'transportation',
  'shopping',
  'electronics',
  'healthcare',
  'entertainment',
  'household',
  'vehicle',
  'other',
] as const satisfies readonly ReceiptCategory[];

type AllCategoriesListed =
  Exclude<ReceiptCategory, (typeof RECEIPT_CATEGORIES)[number]> extends never ? true : never;
/** Fails to compile if a category is added to the schema but not to the list. */
export const CATEGORY_LIST_IS_COMPLETE: AllCategoriesListed = true;

/** Whether `value` is one of the §9 categories. */
export function isReceiptCategory(value: unknown): value is ReceiptCategory {
  return typeof value === 'string' && (RECEIPT_CATEGORIES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

/** One receipt, as every read in this feature returns it. */
export interface ReceiptRecord {
  id: string;
  merchant: string;
  /** Always present and always `> 0`. See the file header. */
  amountMinor: MinorUnits;
  currency: string;
  category: ReceiptCategory;
  /** The calendar date printed on the receipt, `'YYYY-MM-DD'`. */
  purchaseDate: string;
  paymentMethod: string | null;
  notes: string | null;
  /**
   * Sandbox URI of the full-size capture, or `null` when the user saved the
   * metadata without a photo.
   *
   * SENSITIVE (§10). Render it, unlink it, never log it. A missing file is
   * "Image unavailable", not a crash — the data layer cannot tell whether the
   * bytes are still there and does not try.
   */
  localImageUri: string | null;
  /** Sandbox URI of the list thumbnail. Sensitive on the same terms. */
  localThumbnailUri: string | null;
  createdAt: number;
  updatedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Mutation input                                                              */
/* -------------------------------------------------------------------------- */

export interface NewReceiptInput {
  merchant: string;
  amountMinor: MinorUnits;
  /** Defaults to `DEFAULT_CURRENCY` (§30). */
  currency?: string;
  /** Defaults to `'other'`. */
  category?: ReceiptCategory;
  /**
   * Defaults to the injected clock's TODAY.
   *
   * "Photograph the receipt now, type the date later" is the common capture
   * flow (§9's workflow), and today is the honest answer to a missing one — the
   * same trade `validateNewBill`'s `reconcilePaidDate` makes for `paid_date`.
   */
  purchaseDate?: string;
  paymentMethod?: string | null;
  notes?: string | null;
  localImageUri?: string | null;
  localThumbnailUri?: string | null;
}

/**
 * A partial edit. `undefined` means "not mentioned"; `null` means "clear it",
 * and is refused for the columns the schema declares NOT NULL.
 *
 * Setting `localImageUri` to a new value or to `null` ORPHANS the file that was
 * there. `updateReceipt()` returns it in {@link ReceiptWrite.orphanedUris} so
 * the caller can unlink it — after the write commits, never before. See
 * `queries.ts`.
 */
export interface ReceiptPatch {
  merchant?: string;
  amountMinor?: MinorUnits;
  currency?: string;
  category?: ReceiptCategory;
  purchaseDate?: string;
  paymentMethod?: string | null;
  notes?: string | null;
  localImageUri?: string | null;
  localThumbnailUri?: string | null;
}

/* -------------------------------------------------------------------------- */
/* What a write hands back so the caller can tidy the filesystem               */
/* -------------------------------------------------------------------------- */

/**
 * The result of a write that may have stranded image bytes.
 *
 * `orphanedUris` is every sandbox URI the committed row no longer references.
 * It is the ONLY channel through which a URI leaves this module besides the
 * record itself, and it exists so the caller never has to guess: unlink exactly
 * these, only after the promise resolved `ok`.
 */
export interface ReceiptWrite {
  record: ReceiptRecord;
  orphanedUris: readonly string[];
}

/**
 * The result of a soft delete.
 *
 * The row is gone from every list and every total the instant this resolves;
 * the files it referenced are still on disk, and `orphanedUris` names them.
 * Unlink them AFTER this resolves — the ordering argument is in `queries.ts`.
 */
export interface DeletedReceipt {
  id: string;
  deletedAt: number;
  orphanedUris: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Totals                                                                      */
/* -------------------------------------------------------------------------- */

/** Money spent in one currency over the filtered range. */
export interface ReceiptCurrencyTotal {
  currency: string;
  receiptCount: number;
  totalMinor: MinorUnits;
}

/** Money spent in one category, within one currency. */
export interface ReceiptCategoryTotal {
  category: ReceiptCategory;
  currency: string;
  receiptCount: number;
  totalMinor: MinorUnits;
}

/**
 * §5's receipt bucket and §9's journal summary, aggregated entirely by SQLite.
 *
 * Grouped by currency because summing ₱ and $ into one integer is a lie the
 * type system cannot catch. §30 ships PHP only, so `primary` is the single
 * number Home renders; `byCurrency` is what makes adding a currency a UI change
 * rather than a data-layer change.
 *
 * Nothing in `queries.ts` folds these up in JavaScript — `receiptCount` and
 * `withoutImageCount` come from their own `count(*)` pass, not from reducing
 * over `byCurrency`.
 */
export interface ReceiptTotals {
  byCurrency: readonly ReceiptCurrencyTotal[];
  /** One row per (currency, category) pair that has at least one receipt. */
  byCategory: readonly ReceiptCategoryTotal[];
  /** The entry for the app's default currency, zeroed when there is none. */
  primary: ReceiptCurrencyTotal;
  /** Matching receipts in every currency. */
  receiptCount: number;
  /**
   * Of those, how many have no image on file.
   *
   * A COUNT, deliberately: the dashboard may want to nudge the user to attach
   * photos, and a count says so without any URI leaving the database (§10).
   */
  withoutImageCount: number;
  /**
   * Of those, how many the sums had to leave out because their `amount_minor`
   * is not an integer.
   *
   * The same policy `ReceiptPage.damagedCount` states, applied to a total
   * instead of a list: one row with a float in it must not blank Home's
   * spending card, and it must not silently skew it either. `sql.ts`'s
   * `READABLE_AMOUNT_SQL` is where the exclusion happens — in SQLite, not here.
   */
  damagedCount: number;
}

/* -------------------------------------------------------------------------- */
/* Filters (§23)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A receipt journal is read newest-first, which is why `'purchase-date'`
 * descends while `BillSort`'s `'due-date'` ascends: a bill list is a queue of
 * things to do, a receipt list is a history of things done.
 */
export type ReceiptSort = 'purchase-date' | 'merchant' | 'amount';

/** §23's receipt filters: merchant, category, date range, amount range. */
export interface ReceiptFilter {
  /**
   * Case-insensitive substring of the merchant, payment method or notes. `%`,
   * `_` and `\` are escaped, so searching for "50%" matches a literal "50%".
   *
   * The image URI columns are NOT searched, on purpose: a search box that can
   * match a filesystem path is a way to probe for one (§10).
   */
  search?: string;
  /** One category or several, OR'd together. Omit for all. */
  category?: ReceiptCategory | readonly ReceiptCategory[];
  /** Purchased on or after this `'YYYY-MM-DD'`. */
  fromISO?: string;
  /** Purchased on or before this `'YYYY-MM-DD'`. */
  toISO?: string;
  /** At least this many minor units. */
  minAmountMinor?: MinorUnits;
  /** At most this many minor units. */
  maxAmountMinor?: MinorUnits;
  /** Only receipts that do (`true`) or do not (`false`) have an image on file. */
  hasImage?: boolean;
  currency?: string;
  sort?: ReceiptSort;
  /** Rows per page. Defaults to `DEFAULT_PAGE_SIZE`, capped at `MAX_PAGE_SIZE`. */
  limit?: number;
  offset?: number;
  /**
   * Continue after the page that returned this cursor ({@link ReceiptPage.next}).
   *
   * A keyset read: the page starts where the last one ended, by sort key and
   * through the same paging index, instead of skipping `offset` rows — and it
   * is NOT counted again. `total` is the `count(*)` the first page took,
   * carried in the cursor. Pass the SAME filter and sort the cursor came from;
   * a cursor from another sort is refused. Never combined with `offset`.
   */
  after?: string;
}

/**
 * What `receiptTotals()` measures: the SAME predicate a list uses, minus the
 * pagination that would make a total meaningless.
 *
 * One type, so "the total under this list" is provably the total OF this list —
 * `sql.ts` builds both WHERE clauses from a single function.
 */
export type ReceiptTotalsOptions = Omit<ReceiptFilter, 'sort' | 'limit' | 'offset' | 'after'>;

export interface ReceiptPage {
  rows: readonly ReceiptRecord[];
  /**
   * Rows the page matched but could not be read.
   *
   * SQLite is dynamically typed, so a float can sit in `amount_minor` past the
   * `> 0` CHECK. Mapping such a row throws — and throwing from a LIST makes one
   * damaged record blank the whole screen behind a "Try again" that re-runs the
   * identical query forever. So a list SKIPS and COUNTS, exactly as
   * `BillPage.damagedCount` does, and reports the count so a screen can say so
   * out loud rather than quietly showing less than it found.
   * `softDeleteReceipt()` never maps, so a counted row is always removable.
   */
  damagedCount: number;
  /**
   * Matching rows in total, counted in SQL — not `rows.length`. A page read
   * with `after` reports the count its first page took, without re-counting.
   */
  total: number;
  /** The limit actually applied after clamping. */
  limit: number;
  /** Rows before this page — the one passed, or the cursor's position. */
  offset: number;
  hasMore: boolean;
  /**
   * Pass as `after` to read the page that follows. `null` exactly when
   * `hasMore` is false.
   *
   * Opaque, in-memory only, and never logged: it is built from the last row's
   * sort keys, so it holds a merchant name or an amount (`@/lib/keyset`).
   */
  next: string | null;
}

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
/** How many rows `recentReceipts()` will return when asked for everything. */
export const MAX_RECENT_ROWS = 100;
/** How many `recentReceipts()` returns when a caller does not say (§5). */
export const DEFAULT_RECENT_LIMIT = 10;

/* -------------------------------------------------------------------------- */
/* Typed errors (§29)                                                          */
/* -------------------------------------------------------------------------- */

export type ReceiptErrorCode =
  | 'invalid-merchant'
  | 'invalid-amount'
  | 'invalid-currency'
  | 'invalid-category'
  | 'invalid-date'
  /**
   * A URI that is not a local file.
   *
   * §10 and §34: receipt images live on the device. A `https:` or `content:`
   * URI in this column would make a list view fetch over the network the moment
   * a screen rendered it, which is the offline-first invariant broken by a
   * string. The code exists so validation can refuse it at the boundary.
   */
  | 'invalid-uri'
  | 'too-long'
  | 'not-found'
  | 'empty-patch'
  /** A range whose lower bound is above its upper bound — it matches nothing. */
  | 'invalid-range';

export type ReceiptField =
  | 'merchant'
  | 'amountMinor'
  | 'currency'
  | 'category'
  | 'purchaseDate'
  | 'paymentMethod'
  | 'notes'
  | 'localImageUri'
  | 'localThumbnailUri'
  | 'id'
  | 'patch'
  | 'filter';

/**
 * A validation failure, returned rather than thrown.
 *
 * `message` is developer-facing and NEVER contains the offending value. An
 * amount, a note, a merchant and — above all — an image URI are user data
 * (§10, §18, §19): this message may be rendered, logged by a caller, or
 * attached to a crash report, and none of those may carry a path to a photo of
 * someone's credit card. The UI renders copy from `code` + `field`;
 * `@/lib/errors`' `toUserMessage()` is the model.
 */
export interface ReceiptError {
  code: ReceiptErrorCode;
  field: ReceiptField;
  message: string;
}

export type ReceiptResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly ReceiptError[] };

export function ok<T>(value: T): ReceiptResult<T> {
  return { ok: true, value };
}

export function failed<T>(errors: readonly ReceiptError[]): ReceiptResult<T> {
  return { ok: false, errors };
}

export function fieldError(
  code: ReceiptErrorCode,
  field: ReceiptField,
  message: string,
): ReceiptError {
  return { code, field, message };
}
